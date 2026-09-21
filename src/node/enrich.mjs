/**
 * Enrichment: for the postings that survived filtering, go to the employer's own ATS.
 *
 * What this stage adds, and why each one needs the source rather than the index:
 *   date_posted   — the employer's date; discovery only knows when an indexer first saw it
 *   locations     — the full list, replacing summaries like "3 Locations"
 *   location_rank — recomputed on that full list, so a posting can move between ranks here
 *   clearance     — from the description text; decides whether a role is even open to them
 *   pay           — the posted range, checked against the candidate's floor
 *   repost_signal — body text dated well before the listing
 *
 * Description text is cached per posting id, so re-running a day costs nothing and the tailoring
 * step can read the same text the scan used.
 */
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { Geo } from './geo.mjs';
import { fetchDetail, providerFor, SUPPORTED } from './providers.mjs';
import { clearance, pay, repostSignal } from './extract.mjs';
import { pool, cachePath } from './http.mjs';
import { today, workPath } from './config.mjs';

/** Read a JSONL file into memory. These files hold thousands of rows, not millions. */
export function readJsonl(path) {
  if (!existsSync(path)) throw new Error(`input not found: ${path}`);
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

/** Cached description text for a posting, or null when it has not been fetched. */
export function cachedText(cfg, id) {
  const p = cachePath(cfg, 'jd', `${id}.txt`);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/**
 * Merge every source's ranked file for a date into one list, de-duplicated by posting id.
 *
 * When two sources found the same posting, the record with the better date wins: a tracked
 * board read the employer's own date, while the public index only knows when it first saw the
 * posting. Source order below encodes that preference.
 */
export function mergeRanked(cfg, date) {
  const preference = ['tracked', 'remote', 'dataset'];
  const byId = new Map();
  for (const source of ['tracked', 'remote', 'sweep']) {
    const path = workPath(cfg, `ranked-${source}-${date}.jsonl`);
    if (!existsSync(path)) continue;
    for (const row of readJsonl(path)) {
      const existing = byId.get(row.id);
      if (!existing) {
        byId.set(row.id, row);
        continue;
      }
      const rank = r => preference.indexOf(r.source || 'dataset');
      if (rank(row) < rank(existing)) {
        byId.set(row.id, { ...row, also_seen_in: existing.source });
      } else {
        existing.also_seen_in = row.source;
      }
    }
  }
  return [...byId.values()];
}

/**
 * @param {object} cfg
 * @param {{date?: string, input?: string, verdicts?: string[], limit?: number, log?: Function}} [opts]
 */
export async function runEnrich(cfg, { date = today(), input, verdicts = ['shortlist', 'check'], limit, log = () => {} } = {}) {
  const rows = input ? readJsonl(input) : mergeRanked(cfg, date);
  if (!rows.length) throw new Error(`no ranked results for ${date} — run sweep, tracked or remote first`);
  const targets = rows.filter(r => verdicts.includes(r.verdict)).slice(0, limit || undefined);

  const geo = Geo.fromConfig(cfg);
  const cache = new Map();
  const stats = { targets: targets.length, fetched: 0, failed: 0, unsupported: 0, cached: 0, rank_changed: 0, out_of_window: 0 };
  const minJdChars = cfg.scoring?.min_jd_chars ?? 400;
  const floor = cfg.profile?.compensation?.base_floor || 0;
  const sinceDays = cfg.windows?.full_sweep_days ?? 1;
  const since = new Date(new Date(`${date}T00:00:00Z`).getTime() - sinceDays * 86400000).toISOString().slice(0, 10);

  log(`enrich ${date}: ${targets.length} postings (${verdicts.join(', ')})`);

  await pool(targets, cfg.http?.concurrency?.jd_fetch || 8, async row => {
    let text = cachedText(cfg, row.id);
    if (text) stats.cached++;

    // Distinguish "we have no reader for this ATS" from "the read failed": the first is a
    // coverage gap to fix in providers.mjs, the second is a transient network problem.
    if (!SUPPORTED.includes(providerFor(row.url, row.ats))) {
      stats.unsupported++;
      row.enrich_status = `no reader for ${row.ats || 'this ATS'}`;
      return;
    }

    const detail = await fetchDetail(row, cfg, cache, date);
    if (!detail && !text) {
      stats.failed++;
      row.enrich_status = 'detail fetch failed';
      return;
    }
    stats.fetched++;

    if (detail?.text && detail.text.length >= minJdChars) {
      text = detail.text;
      writeFileSync(cachePath(cfg, 'jd', `${row.id}.txt`), text, 'utf8');
    }

    if (detail?.date_posted) {
      row.date_posted = detail.date_posted;
      row.date_basis = detail.date_basis;
    }
    if (detail?.locations?.length) {
      row.locations = detail.locations;
      const all = detail.locations.join('; ') + (detail.remote_type ? ` [${detail.remote_type}]` : '');
      const { rank, domestic } = geo.rank(detail.locations, all);
      if (rank !== row.location_rank) {
        stats.rank_changed++;
        row.rank_before_enrich = row.location_rank;
      }
      row.location_rank = rank;
      row.domestic = domestic;
      row.remote_type = detail.remote_type || '';
    }

    if (text) {
      const c = clearance(text, cfg);
      row.clearance = c.status;
      row.clearance_evidence = c.evidence;
      const p = pay(text, cfg);
      row.pay_text = p.text;
      row.pay_min = p.min;
      row.pay_max = p.max;
      row.repost_signal = repostSignal(text, row.date_posted || row.date_first_seen);
      row.jd_chars = text.length;
    }

    // Re-apply the gates that only became checkable with the employer's own record.
    if (row.date_posted && row.date_posted < since) {
      row.verdict = 'dropped';
      row.verdict_reason = `posted ${row.date_posted}, before ${since} (index said ${row.date_first_seen})`;
      stats.out_of_window++;
    } else if (row.location_rank === 4) {
      row.verdict = 'dropped';
      row.verdict_reason = `outside home country after enrichment: ${row.locations.join('; ')}`;
    } else if (floor && typeof row.pay_max === 'number' && row.pay_max > 0 && row.pay_max < floor) {
      row.verdict = 'dropped';
      row.verdict_reason = `posted pay tops out at ${row.pay_max}, below floor ${floor}`;
    } else if (row.location_rank === 5) {
      row.verdict = 'check';
    } else {
      row.verdict = 'shortlist';
    }
    row.enrich_status = 'ok';
  });

  const outPath = workPath(cfg, `enriched-${date}.jsonl`);
  const out = createWriteStream(outPath, { encoding: 'utf8' });
  for (const row of rows) out.write(`${JSON.stringify(row)}\n`);
  await new Promise(resolve => out.end(resolve));

  const after = targets.reduce((acc, r) => ((acc[r.verdict] = (acc[r.verdict] || 0) + 1), acc), {});
  log(
    `enriched ${stats.fetched} (${stats.failed} unreadable, ${stats.unsupported} no reader, ` +
    `${stats.cached} text cached) | rank changed ${stats.rank_changed} | ` +
    `dropped as out-of-window ${stats.out_of_window}`
  );
  return { date, out: outPath, stats, after };
}
