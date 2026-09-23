/**
 * Live sweep — the fallback when the public index is unavailable.
 *
 * The daily index is one third-party project. When it is down, or when a user would rather not
 * depend on it, this walks employer boards directly: the same operation as the tracked scan, at
 * a larger scale. Board slugs come from public per-ATS company lists (configured, cached) plus
 * whatever is in `portals.yml`.
 *
 * The trade is honest and worth stating: this reads hundreds of boards instead of one 70 MB
 * file, so it is slower and noisier, and `max_boards` caps it. It is a fallback, not a
 * replacement — but it keeps a user working on a day the index does not publish.
 */
import { createWriteStream } from 'node:fs';
import { readFileSync, existsSync } from 'node:fs';
import { Geo } from './geo.mjs';
import { fetchToCache, cachePath } from './http.mjs';
import { buildTitleMatcher, buildLaneMatcher, buildCoverage, classify } from './filters.mjs';
import { loadBoards, scanBoards } from './tracked.mjs';
import { today, workPath } from './config.mjs';
import { daysBefore } from './sweep.mjs';

/**
 * Turn a published slug list into board records.
 * Workday entries carry three parts ("tenant|wd|site"); the others are a bare slug.
 */
export function parseSlugList(provider, slugs) {
  const boards = [];
  for (const raw of slugs) {
    const value = String(raw || '').trim();
    if (!value) continue;
    if (provider === 'workday') {
      const [tenant, wd, site] = value.split('|');
      if (tenant && wd && site) boards.push({ provider, tenant, wd, site, name: tenant });
    } else {
      boards.push({ provider, slug: value, name: value });
    }
  }
  return boards;
}

/**
 * Merge the user's own boards with the discovered ones: own first, de-duplicated, capped.
 *
 * Order matters. The cap is a blunt instrument — it takes the head of the list — so the
 * employers a user chose to track must never be the ones it cuts.
 */
export function mergeBoards(own, discovered, cap, log = () => {}) {
  const seen = new Set();
  const merged = [];
  for (const board of [...own, ...discovered]) {
    const key = `${board.provider}:${board.slug || `${board.tenant}|${board.wd}|${board.site}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(board);
  }
  if (merged.length > cap) {
    log(`  capped at ${cap} boards of ${merged.length} (sources.full_sweep.live.max_boards)`);
    return merged.slice(0, cap);
  }
  return merged;
}

/**
 * Assemble the board list for a live sweep: configured slug sources first, then portals.yml,
 * de-duplicated, capped at `max_boards`.
 */
export async function loadLiveBoards(cfg, log = () => {}) {
  const live = cfg.sources?.full_sweep?.live || {};
  const boards = [];

  for (const [provider, url] of Object.entries(live.slug_sources || {})) {
    const path = cachePath(cfg, 'slugs', `${provider}.json`);
    const got = await fetchToCache(url, cfg, path);
    if (!got.path || !existsSync(got.path)) {
      log(`  slug list unavailable for ${provider}: ${got.error || 'no response'}`);
      continue;
    }
    try {
      const slugs = JSON.parse(readFileSync(got.path, 'utf8'));
      const parsed = parseSlugList(provider, Array.isArray(slugs) ? slugs : []);
      log(`  ${provider}: ${parsed.length} boards${got.fromCache ? ' (cached)' : ''}`);
      boards.push(...parsed);
    } catch (err) {
      log(`  slug list unreadable for ${provider}: ${err.message}`);
    }
  }

  // The user's own employers always take part, and come first so the cap never excludes them.
  let own = [];
  try {
    own = loadBoards(cfg);
  } catch {
    // No portals.yml is fine here; the slug lists carry the sweep.
  }

  return mergeBoards(own, boards, live.max_boards || 500, log);
}

/**
 * @param {object} cfg
 * @param {{date?: string, sinceDays?: number, log?: Function}} [opts]
 */
export async function runLive(cfg, { date = today(), sinceDays, log = () => {} } = {}) {
  if (!cfg.profile) throw new Error('live sweep needs a profile: run `ajs init`');

  const days = sinceDays ?? cfg.windows?.full_sweep_days ?? 3;
  const since = daysBefore(date, days);

  log(`live sweep ${date}: assembling boards`);
  const boards = await loadLiveBoards(cfg, log);
  if (!boards.length) {
    throw new Error(
      'live sweep found no boards. Add employers to config/portals.yml, or configure ' +
      'sources.full_sweep.live.slug_sources.'
    );
  }

  const ctx = {
    cfg,
    titles: buildTitleMatcher(cfg),
    lanes: buildLaneMatcher(cfg),
    geo: Geo.fromConfig(cfg),
    coverage: buildCoverage(cfg, boards.map(b => b.slug || b.tenant)),
    since: null, // applied below against each employer's own date
  };

  log(`live sweep: reading ${boards.length} boards, window ${since} .. ${date}`);
  const { rows, failed } = await scanBoards(cfg, boards, date);

  const seen = new Set();
  const kept = [];
  const counts = { shortlist: 0, check: 0, dropped: 0, irrelevant: 0 };
  const lanes = {};
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const classified = classify({ ...row, source: 'live' }, ctx);
    if (classified.verdict === 'dropped' && !classified.title_relevant) {
      counts.irrelevant++;
      continue;
    }
    if (classified.verdict !== 'dropped' && row.date_posted && row.date_posted < since) {
      classified.verdict = 'dropped';
      classified.verdict_reason = `posted ${row.date_posted}, before ${since}`;
    }
    counts[classified.verdict]++;
    if (classified.verdict !== 'dropped') lanes[classified.lane] = (lanes[classified.lane] || 0) + 1;
    kept.push(classified);
  }

  // Written under the sweep's name so enrichment and reporting pick it up unchanged.
  const outPath = workPath(cfg, `ranked-sweep-${date}.jsonl`);
  const out = createWriteStream(outPath, { encoding: 'utf8' });
  for (const row of kept) out.write(`${JSON.stringify(row)}\n`);
  await new Promise(resolve => out.end(resolve));

  log(
    `live sweep: ${rows.length} postings from ${boards.length} boards ` +
    `(${failed.length} unreachable) | shortlist ${counts.shortlist} · check ${counts.check} · ` +
    `dropped ${counts.dropped}`
  );

  return { date, out: outPath, counts, lanes, boards: boards.length, postings: rows.length, failed, engine: 'live' };
}
