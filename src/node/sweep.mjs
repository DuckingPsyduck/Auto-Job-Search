/**
 * Full sweep: discover postings from the public dataset, filter them locally, and write one
 * JSONL file per stage.
 *
 * Deliberately does no network work per posting. Enrichment (true posted date, clearance, pay)
 * runs afterwards against the employer's own ATS, and only for what survives here — hundreds of
 * requests a day instead of tens of thousands.
 */
import { createWriteStream } from 'node:fs';
import { Geo } from './geo.mjs';
import { walkDataset } from './dataset.mjs';
import { buildTitleMatcher, buildLaneMatcher, buildCoverage, classify } from './filters.mjs';
import { today, workPath } from './config.mjs';
import { runLive } from './live.mjs';

/** ISO date N days before `date`. */
export function daysBefore(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * @param {object} cfg loaded config
 * @param {{date?: string, sinceDays?: number, limitChunks?: number, log?: Function}} [opts]
 * @returns {Promise<{date: string, out: string, counts: object, lanes: object, errors: string[]}>}
 */
export async function runSweep(cfg, { date = today(), sinceDays, limitChunks, log = () => {} } = {}) {
  if (!cfg.profile) {
    throw new Error(
      'no profile found. Run `ajs init`, or point paths.profile at a filled-in profile.yml.\n' +
      'The scan needs your target keywords and location rules to filter anything.'
    );
  }

  const engine = cfg.sources?.full_sweep?.engine || 'dataset';
  if (engine === 'off') {
    log('sweep disabled (sources.full_sweep.engine: off)');
    return { date, out: null, counts: {}, lanes: {}, errors: [] };
  }
  if (engine === 'live') return runLive(cfg, { date, sinceDays, log });

  const days = sinceDays ?? cfg.windows?.full_sweep_days ?? 1;
  const since = daysBefore(date, days);

  const ctx = {
    cfg,
    titles: buildTitleMatcher(cfg),
    lanes: buildLaneMatcher(cfg),
    geo: Geo.fromConfig(cfg),
    coverage: buildCoverage(cfg, cfg.trackedSlugs || []),
    since,
  };

  const outPath = workPath(cfg, `ranked-sweep-${date}.jsonl`);
  const out = createWriteStream(outPath, { encoding: 'utf8' });
  const counts = { seen: 0, shortlist: 0, check: 0, dropped: 0, duplicates: 0, irrelevant: 0 };
  const lanes = {};
  const seenIds = new Set();

  log(`sweep ${date}: window ${since} .. ${date} (${days}d), keywords ${ctx.titles.positive.length}`);

  let stats;
  try {
    stats = await walkDataset(
    cfg,
    posting => {
      counts.seen++;
      if (seenIds.has(posting.id)) {
        counts.duplicates++;
        return;
      }
      seenIds.add(posting.id);

      const row = classify(posting, ctx);
      // Titles that never matched a target keyword are the overwhelming majority and carry no
      // signal; they are counted, not written. Everything a keyword touched is kept on disk.
      if (row.verdict === 'dropped' && !row.title_relevant) {
        counts.irrelevant++;
        return;
      }
      counts[row.verdict]++;
      if (row.verdict !== 'dropped') lanes[row.lane] = (lanes[row.lane] || 0) + 1;
      out.write(`${JSON.stringify(row)}\n`);
    },
      {
        limitChunks,
        onProgress: (s, chunk) => log(`  ${chunk.name}: ${s.records.toLocaleString()} records read`),
      }
    );
  } catch (err) {
    // The index is one third-party project. If it cannot be read, fall back to reading boards
    // directly rather than returning an empty day.
    await new Promise(resolve => out.end(resolve));
    log(`public index unavailable (${err.message}); falling back to a live sweep`);
    return runLive(cfg, { date, sinceDays, log });
  }

  await new Promise(resolve => out.end(resolve));

  log(
    `dataset: ${stats.records.toLocaleString()} records in ${stats.chunks} chunks ` +
    `(${stats.cached} cached) | shortlist ${counts.shortlist} · check ${counts.check} · ` +
    `dropped ${counts.dropped} · duplicate urls ${counts.duplicates}`
  );
  if (stats.errors.length) log(`chunk errors: ${stats.errors.length} (${stats.errors[0]})`);

  return { date, out: outPath, counts, lanes, errors: stats.errors };
}
