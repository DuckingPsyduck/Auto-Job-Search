/**
 * Tracked scan: read the employers you chose, straight from their own job boards.
 *
 * The public index is broader, but this is where the dates are exact, the coverage is certain,
 * and a quiet regression in the index would show up as a posting the tracked scan sees and the
 * sweep does not. Keep both.
 *
 * Boards come from config/portals.yml. Each provider returns the same posting shape as the
 * sweep, so filtering, enrichment and reporting are shared.
 */
import { existsSync, readFileSync, createWriteStream } from 'node:fs';
import * as yaml from 'js-yaml';
import { Geo } from './geo.mjs';
import { fetchJson, idFor, normalizeUrl, pool } from './http.mjs';
import { buildTitleMatcher, buildLaneMatcher, buildCoverage, classify } from './filters.mjs';
import { relativeDate } from './providers.mjs';
import { today, workPath } from './config.mjs';
import { daysBefore } from './sweep.mjs';

const iso = value => {
  if (!value) return '';
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(Number(s) || s);
  return Number.isNaN(d.valueOf()) ? '' : d.toISOString().slice(0, 10);
};

const base = (board, provider) => ({
  source: 'tracked',
  ats: provider,
  company: board.slug || board.tenant || board.name,
  company_name: board.name || '',
});

/** Load and flatten portals.yml into one list of boards. */
export function loadBoards(cfg) {
  const path = cfg.paths?.portals;
  if (!path || !existsSync(path)) {
    throw new Error(`no portals file at ${path}. Copy config/portals.example.yml and list your employers.`);
  }
  const data = yaml.load(readFileSync(path, 'utf8')) || {};
  const boards = [];
  for (const provider of ['greenhouse', 'lever', 'ashby', 'workday']) {
    for (const entry of data[provider] || []) {
      if (entry?.enabled === false) continue;
      boards.push({ ...entry, provider });
    }
  }
  return boards;
}

const listers = {
  /** Greenhouse publishes the whole board, with `first_published` per posting. */
  async greenhouse(board, cfg) {
    const url = (cfg.sources?.ats?.greenhouse_board || 'https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=false')
      .replace('{slug}', board.slug);
    const data = await fetchJson(url, cfg);
    return (data?.jobs || []).map(job => ({
      ...base(board, 'greenhouse'),
      title: job.title,
      url: normalizeUrl(job.absolute_url),
      locations: [job.location?.name].filter(Boolean),
      date_posted: iso(job.first_published || job.updated_at),
      date_basis: job.first_published ? 'greenhouse first_published' : 'greenhouse updated_at',
    }));
  },

  async lever(board, cfg) {
    const url = (cfg.sources?.ats?.lever_board || 'https://api.lever.co/v0/postings/{slug}?mode=json')
      .replace('{slug}', board.slug);
    const data = await fetchJson(url, cfg);
    return (Array.isArray(data) ? data : []).map(job => ({
      ...base(board, 'lever'),
      title: job.text,
      url: normalizeUrl(job.hostedUrl),
      locations: [job.categories?.location].filter(Boolean),
      date_posted: iso(job.createdAt),
      date_basis: 'lever createdAt',
    }));
  },

  async ashby(board, cfg) {
    const url = (cfg.sources?.ats?.ashby_board || 'https://api.ashbyhq.com/posting-api/job-board/{slug}')
      .replace('{slug}', board.slug);
    const data = await fetchJson(url, cfg);
    return (data?.jobs || []).map(job => ({
      ...base(board, 'ashby'),
      title: job.title,
      url: normalizeUrl(job.jobUrl || job.applyUrl),
      locations: [job.location, ...(job.secondaryLocations || []).map(l => l?.location)].filter(Boolean),
      date_posted: iso(job.publishedAt),
      date_basis: 'ashby publishedAt',
    }));
  },

  /**
   * Workday has no board dump: its CXS endpoint is a paged POST search. Dates come back as
   * prose ("Posted 3 Days Ago"), resolved against the run date.
   */
  async workday(board, cfg, runDate) {
    const host = `${board.tenant}.${board.wd}.myworkdayjobs.com`;
    const endpoint = `https://${host}/wday/cxs/${board.tenant}/${board.site}/jobs`;
    const pageSize = cfg.http?.workday?.page_size || 20;
    const maxPages = cfg.http?.workday?.max_pages || 110;
    const out = [];
    let offset = 0;
    let total = Infinity;

    for (let page = 0; page < maxPages && offset < total; page++) {
      const data = await fetchJson(endpoint, cfg, {
        method: 'POST',
        body: { appliedFacets: {}, limit: pageSize, offset, searchText: '' },
      });
      if (!data?.jobPostings?.length) break;
      total = data.total ?? total;
      for (const job of data.jobPostings) {
        out.push({
          ...base(board, 'workday'),
          title: job.title,
          url: normalizeUrl(`https://${host}/${board.site}${job.externalPath}`),
          locations: [job.locationsText].filter(Boolean),
          date_posted: relativeDate(job.postedOn, runDate),
          date_basis: 'workday postedOn (relative)',
        });
      }
      offset += pageSize;
    }
    return out;
  },
};

/**
 * @param {object} cfg
 * @param {{date?: string, sinceDays?: number, log?: Function}} [opts]
 */
export async function runTracked(cfg, { date = today(), sinceDays, log = () => {} } = {}) {
  if (!cfg.profile) throw new Error('tracked scan needs a profile: fill config/profile.yml');

  const boards = loadBoards(cfg);
  const days = sinceDays ?? cfg.windows?.tracked_scan_days ?? 1;
  const since = daysBefore(date, days);
  const ctx = {
    cfg,
    titles: buildTitleMatcher(cfg),
    lanes: buildLaneMatcher(cfg),
    geo: Geo.fromConfig(cfg),
    coverage: buildCoverage(cfg, boards.map(b => b.slug || b.tenant)),
    since: null, // the window is applied below, against the employer's own date
  };

  log(`tracked ${date}: ${boards.length} boards, window ${since} .. ${date}`);

  const rows = [];
  const empty = [];
  const failed = [];
  await pool(boards, cfg.http?.concurrency?.default || 6, async board => {
    try {
      const postings = await listers[board.provider](board, cfg, date);
      if (!postings.length) empty.push(board.name || board.slug || board.tenant);
      for (const posting of postings) {
        if (!posting.url || !posting.title) continue;
        rows.push({
          id: idFor(posting.url),
          date_first_seen: date,
          scraped_at: date,
          ...posting,
        });
      }
    } catch (err) {
      failed.push(`${board.name || board.slug}: ${err.message}`);
    }
  });

  const seen = new Set();
  const kept = [];
  let stale = 0;
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const classified = classify(row, ctx);
    if (classified.verdict === 'dropped' && !classified.title_relevant) continue;
    // The employer's own date decides the window here; unlike the index, there is no lag to
    // allow for, so a posting older than the window is simply out of scope.
    if (classified.verdict !== 'dropped' && row.date_posted && row.date_posted < since) {
      classified.verdict = 'dropped';
      classified.verdict_reason = `posted ${row.date_posted}, before ${since}`;
      stale++;
    }
    kept.push(classified);
  }

  const outPath = workPath(cfg, `ranked-tracked-${date}.jsonl`);
  const out = createWriteStream(outPath, { encoding: 'utf8' });
  for (const row of kept) out.write(`${JSON.stringify(row)}\n`);
  await new Promise(resolve => out.end(resolve));

  const counts = kept.reduce((acc, r) => ((acc[r.verdict] = (acc[r.verdict] || 0) + 1), acc), {});
  log(
    `tracked: ${rows.length} postings across ${boards.length} boards | ` +
    `shortlist ${counts.shortlist || 0} · check ${counts.check || 0} · dropped ${counts.dropped || 0} ` +
    `(${stale} outside the window)`
  );
  if (empty.length) log(`  returned nothing: ${empty.slice(0, 8).join(', ')}${empty.length > 8 ? ` +${empty.length - 8}` : ''}`);
  if (failed.length) log(`  failed: ${failed.slice(0, 5).join(' | ')}`);

  return { date, out: outPath, counts, boards: boards.length, postings: rows.length, empty, failed };
}
