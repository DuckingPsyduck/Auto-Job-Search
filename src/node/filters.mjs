/**
 * Filtering and ranking.
 *
 * Every posting gets a verdict and a reason; nothing is silently discarded. That is what makes
 * a bad filter visible — a location rule that quietly dropped domestic jobs, or a keyword that
 * matched nothing all week, shows up in the dropped sheet instead of vanishing.
 *
 * Verdicts:
 *   shortlist — passed every gate, goes to enrichment and the main sheet
 *   check     — could not verify the location; a human looks (never auto-dropped)
 *   dropped   — failed a gate; `verdict_reason` says which
 */
import { readFileSync, existsSync } from 'node:fs';

const escapeRx = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Title matcher built from the candidate's target keywords.
 * A posting is kept when a positive keyword matches and no negative one does.
 */
export function buildTitleMatcher(cfg) {
  const fromProfile = (cfg.profile?.targets?.archetypes || []).flatMap(a => a.keywords || []);
  const positive = [...new Set([...fromProfile, ...(cfg.titles?.extra_positive || [])])]
    .map(s => String(s).trim()).filter(Boolean);
  const negative = (cfg.titles?.extra_negative || []).map(s => String(s).trim()).filter(Boolean);

  if (!positive.length) {
    throw new Error('no title keywords: add them to profile.targets[].keywords or titles.extra_positive');
  }
  const posRx = new RegExp(`\\b(${positive.map(escapeRx).join('|')})\\b`, 'i');
  const negRx = negative.length ? new RegExp(`\\b(${negative.map(escapeRx).join('|')})\\b`, 'i') : null;
  const seniorityRx = cfg.titles?.seniority_flag ? new RegExp(cfg.titles.seniority_flag, 'i') : null;

  return {
    positive,
    negative,
    /**
     * Positives are tested first on purpose: a title that never matched a target keyword is
     * simply irrelevant, while one that matched and was then excluded ("Data Engineer Intern")
     * is worth recording, because that is how an over-broad exclusion gets noticed.
     * @returns {{ok: boolean, hits: string[], blocked: string|null, relevant: boolean}}
     */
    match(title) {
      const t = String(title || '');
      if (!posRx.test(t)) return { ok: false, hits: [], blocked: null, relevant: false };
      const blocked = negRx?.exec(t)?.[1] || null;
      if (blocked) return { ok: false, hits: [], blocked, relevant: true };
      return {
        ok: true,
        hits: positive.filter(p => new RegExp(`\\b${escapeRx(p)}\\b`, 'i').test(t)),
        blocked: null,
        relevant: true,
      };
    },
    isSenior(title) {
      return seniorityRx ? seniorityRx.test(String(title || '')) : false;
    },
  };
}

/** Lane assignment: which kind of work a title represents. Order matters; first match wins. */
export function buildLaneMatcher(cfg) {
  const order = cfg.lanes?.order || [];
  const patterns = cfg.lanes?.patterns || {};
  const compiled = order
    .filter(name => patterns[name])
    .map(name => ({ name, rx: new RegExp(patterns[name], 'i') }));
  const labels = cfg.lanes?.labels || {};
  return {
    lane(title) {
      const t = String(title || '');
      for (const { name, rx } of compiled) if (rx.test(t)) return name;
      return order[order.length - 1] || 'other';
    },
    label(lane) {
      return labels[lane] || lane;
    },
  };
}

/**
 * Employer coverage: is this a board we already scan, a company in the registry, or new?
 * Also answers "have we applied here before" from the candidate's tracker, when present.
 */
export function buildCoverage(cfg, trackedSlugs = []) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const tracked = new Set(trackedSlugs.map(norm));
  let trackerText = '';
  const trackerPath = cfg.paths?.tracker;
  if (trackerPath && existsSync(trackerPath)) {
    trackerText = readFileSync(trackerPath, 'utf8').toLowerCase().replace(/[^a-z0-9|\n]/g, '');
  }
  return {
    coverage(company) {
      return tracked.has(norm(company)) ? 'tracked' : 'new';
    },
    appliedBefore(company) {
      const n = norm(company);
      return n.length > 3 && trackerText.includes(n.slice(0, 10));
    },
  };
}

/** Pay floor: drop a posting only when its stated maximum is below the floor. */
export function belowPayFloor(posting, floor) {
  if (!floor) return false;
  const max = posting.pay_max ?? posting.salary_estimate?.median ?? null;
  return typeof max === 'number' && max > 0 && max < floor;
}

/**
 * Apply every gate to one posting, in cost order: cheapest and most selective first.
 * Mutates and returns the posting with lane, rank, verdict and reason attached.
 *
 * @param {object} posting normalized posting
 * @param {{titles: object, lanes: object, geo: object, coverage: object, cfg: object, since?: string}} ctx
 */
export function classify(posting, ctx) {
  const { titles, lanes, geo, coverage, cfg, since } = ctx;

  const title = titles.match(posting.title);
  if (!title.ok) {
    posting.verdict = 'dropped';
    posting.title_relevant = title.relevant;
    posting.verdict_reason = title.blocked
      ? `excluded title keyword: ${title.blocked}`
      : 'title outside target keywords';
    return posting;
  }
  posting.title_relevant = true;
  posting.title_match = title.hits;
  posting.seniority = titles.isSenior(posting.title) ? 'senior+' : '';
  posting.lane = lanes.lane(posting.title);

  // Discovery window. For dataset rows this is first_seen, a proxy; enrichment replaces it
  // with the employer's own date before anything is reported as "posted today".
  if (since && posting.date_first_seen && posting.date_first_seen < since) {
    posting.verdict = 'dropped';
    posting.verdict_reason = `first seen ${posting.date_first_seen}, before ${since}`;
    return posting;
  }

  const { rank, domestic } = geo.rank(posting.locations, posting.locations.join('; '));
  posting.location_rank = rank;
  posting.domestic = domestic;

  if (rank === 4) {
    posting.verdict = 'dropped';
    posting.verdict_reason = `outside home country: ${posting.locations.join('; ') || '(no location)'}`;
    return posting;
  }
  if (rank === 5) {
    posting.verdict = 'check';
    posting.verdict_reason = `location not verifiable: ${posting.locations.join('; ') || '(no location)'}`;
    return posting;
  }
  if (!(cfg.location?.shortlist_ranks || [1, 2, 3]).includes(rank)) {
    posting.verdict = 'dropped';
    posting.verdict_reason = `location rank ${rank} not in shortlist`;
    return posting;
  }

  const floor = cfg.profile?.compensation?.base_floor || 0;
  if (belowPayFloor(posting, floor)) {
    posting.verdict = 'dropped';
    posting.verdict_reason = `pay below floor (${floor})`;
    return posting;
  }

  posting.employer_coverage = coverage.coverage(posting.company);
  posting.applied_before = coverage.appliedBefore(posting.company);
  if ((cfg.flags?.aggregator_companies || []).includes(posting.company)) {
    posting.note = 'aggregator repost: find the real employer';
  }

  posting.verdict = 'shortlist';
  posting.verdict_reason = '';
  return posting;
}
