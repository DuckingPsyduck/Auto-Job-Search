/**
 * Dataset discovery: read the daily public index of ATS postings instead of walking every
 * employer board.
 *
 * Source: the job-board-aggregator project publishes ~1.4M active postings as gzipped JSON
 * chunks, refreshed daily (see docs/SOURCES.md for the access note and attribution). We fetch
 * the chunks with ETag caching, stream them through the filters, and only then go back to the
 * employer's own ATS for the few postings that survive.
 *
 * Caveat the pipeline must respect: a record's `first_seen` is when the aggregator first saw
 * the posting, NOT when the employer published it. Treat it as a discovery signal and take the
 * real date from the ATS during enrichment.
 */
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fetchJson, fetchToCache, cachePath, idFor, normalizeUrl, pool } from './http.mjs';

/** Providers the aggregator labels, mapped to our internal names. */
const ATS_NAMES = {
  greenhouse: 'greenhouse',
  lever: 'lever',
  ashby: 'ashby',
  workday: 'workday',
  icims: 'icims',
  bamboohr: 'bamboohr',
  paylocity: 'paylocity',
};

/**
 * List the chunk files published today.
 * Uses the repository contents API, which also gives each file's sha for cache naming.
 * @returns {Promise<Array<{name: string, url: string, sha: string, size: number}>>}
 */
export async function listChunks(cfg) {
  const ds = cfg.sources?.full_sweep?.dataset || {};
  const listing = await fetchJson(ds.chunks_api, cfg);
  if (!Array.isArray(listing)) {
    throw new Error(`dataset chunk listing unavailable: ${ds.chunks_api}`);
  }
  return listing
    .filter(f => f.type === 'file' && f.name.endsWith('.json.gz'))
    .map(f => ({ name: f.name, url: f.download_url, sha: f.sha, size: f.size }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
}

/**
 * Download one chunk (ETag-cached) and return its records.
 * @returns {Promise<{records: object[], fromCache: boolean, error: string|null}>}
 */
export async function readChunk(cfg, chunk) {
  const path = cachePath(cfg, 'chunks', `${chunk.sha.slice(0, 12)}-${chunk.name}`);
  const got = await fetchToCache(chunk.url, cfg, path);
  if (!got.path) return { records: [], fromCache: false, error: got.error };
  try {
    const records = JSON.parse(gunzipSync(readFileSync(got.path)).toString('utf8'));
    return { records: Array.isArray(records) ? records : [], fromCache: got.fromCache, error: got.error };
  } catch (err) {
    return { records: [], fromCache: got.fromCache, error: `unreadable chunk: ${err.message}` };
  }
}

/**
 * Convert an aggregator record into the kit's posting shape.
 * Only fields we can trust are copied; everything derived is added by later stages.
 */
export function toPosting(raw) {
  const url = String(raw.url || '').trim();
  if (!url || !raw.title) return null;
  const location = typeof raw.location === 'string' ? raw.location.trim() : '';
  return {
    id: idFor(url),
    source: 'dataset',
    ats: ATS_NAMES[String(raw.ats || '').toLowerCase()] || String(raw.ats || '').toLowerCase(),
    company: String(raw.company || '').trim(),
    company_name: '',
    title: String(raw.title).trim(),
    url: normalizeUrl(url),
    locations: location ? [location] : [],
    date_first_seen: String(raw.first_seen || '').slice(0, 10),
    date_posted: '',                       // filled during enrichment, from the ATS itself
    date_basis: 'dataset first_seen',
    scraped_at: String(raw.scraped_at || '').slice(0, 10),
    skill_level: String(raw.skill_level || ''),
    is_recruiter: String(raw.is_recruiter || '') === 'True',
    salary_estimate: parseSalary(raw.salary),
  };
}

/** The aggregator stores a market salary estimate as a Python-style dict string. */
function parseSalary(value) {
  if (!value || value === 'None') return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value).replace(/'/g, '"'));
  } catch {
    return null;
  }
}

/**
 * Walk the dataset and hand every posting to `onPosting`.
 *
 * Chunks are processed one at a time so memory stays flat (~25k records per chunk) even though
 * the full dataset is well over a million rows.
 *
 * @param {object} cfg
 * @param {(posting: object, raw: object) => void} onPosting
 * @param {{concurrency?: number, limitChunks?: number, onProgress?: Function}} [opts]
 * @returns {Promise<{chunks: number, records: number, kept: number, cached: number, errors: string[]}>}
 */
export async function walkDataset(cfg, onPosting, { concurrency, limitChunks, onProgress } = {}) {
  const chunks = await listChunks(cfg);
  const selected = limitChunks ? chunks.slice(0, limitChunks) : chunks;
  const stats = { chunks: selected.length, records: 0, kept: 0, cached: 0, errors: [] };

  // Download in parallel, but hand records to the callback one chunk at a time.
  await pool(selected, concurrency || cfg.http?.concurrency?.default || 6, async chunk => {
    const { records, fromCache, error } = await readChunk(cfg, chunk);
    if (error) stats.errors.push(`${chunk.name}: ${error}`);
    if (fromCache) stats.cached++;
    for (const raw of records) {
      stats.records++;
      const posting = toPosting(raw);
      if (!posting) continue;
      stats.kept++;
      onPosting(posting, raw);
    }
    if (onProgress) onProgress(stats, chunk);
  });

  return stats;
}
