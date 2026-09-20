/**
 * HTTP helpers: one place for timeouts, retries, backoff, the user agent and ETag caching.
 *
 * Every network call in the kit goes through here so politeness settings live in config and
 * not in each scanner. Failures return a result object rather than throwing: a job board being
 * down is an expected condition, not an exception.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** @typedef {{ok: boolean, status: number|null, body: Buffer|null, etag: string|null, fromCache: boolean, error: string|null}} FetchResult */

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Fetch with retries and a configured timeout.
 * @param {string} url
 * @param {object} cfg loaded config (uses cfg.http)
 * @param {{accept?: string, etag?: string|null}} [opts]
 * @returns {Promise<FetchResult>}
 */
export async function fetchRaw(url, cfg, { accept = 'application/json', etag = null } = {}) {
  const { timeout_ms = 25000, retries = 3, backoff_ms = 600, user_agent, politeness_delay_s = 0 } = cfg.http || {};
  const headers = { Accept: accept, 'User-Agent': user_agent };
  if (etag) headers['If-None-Match'] = etag;

  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    if (politeness_delay_s) await sleep(politeness_delay_s * 1000);
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout_ms) });
      if (res.status === 304) return { ok: true, status: 304, body: null, etag, fromCache: true, error: null };
      if (res.ok) {
        const body = Buffer.from(await res.arrayBuffer());
        return { ok: true, status: res.status, body, etag: res.headers.get('etag'), fromCache: false, error: null };
      }
      // 4xx other than 429 will not improve on retry.
      if (res.status < 500 && res.status !== 429) {
        return { ok: false, status: res.status, body: null, etag: null, fromCache: false, error: `HTTP ${res.status}` };
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err?.name === 'TimeoutError' ? 'timeout' : String(err?.message || err);
    }
    if (attempt < retries) await sleep(backoff_ms * attempt);
  }
  return { ok: false, status: null, body: null, etag: null, fromCache: false, error: lastError };
}

/** Fetch and parse JSON. Returns null on any failure; callers decide how loud to be. */
export async function fetchJson(url, cfg, opts = {}) {
  const res = await fetchRaw(url, cfg, { accept: 'application/json', ...opts });
  if (!res.ok || !res.body) return null;
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    return null;
  }
}

/** Fetch text (HTML, RSS). Returns '' on failure. */
export async function fetchText(url, cfg, accept = 'text/html') {
  const res = await fetchRaw(url, cfg, { accept });
  return res.ok && res.body ? res.body.toString('utf8') : '';
}

/**
 * Fetch into a local cache file, skipping the download when the server says 304.
 * Used for the dataset chunks, which are large and change once a day.
 * @returns {Promise<{path: string|null, fromCache: boolean, error: string|null}>}
 */
export async function fetchToCache(url, cfg, cachePath) {
  const metaPath = `${cachePath}.meta.json`;
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
  const haveFile = existsSync(cachePath);

  const res = await fetchRaw(url, cfg, { accept: '*/*', etag: haveFile ? meta.etag : null });
  if (res.status === 304 && haveFile) return { path: cachePath, fromCache: true, error: null };
  if (!res.ok || !res.body) {
    // A stale cached copy beats no data; the caller reports that it is stale.
    return haveFile
      ? { path: cachePath, fromCache: true, error: res.error }
      : { path: null, fromCache: false, error: res.error };
  }
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, res.body);
  writeFileSync(metaPath, JSON.stringify({ etag: res.etag, url, fetched_at: new Date().toISOString() }, null, 1));
  return { path: cachePath, fromCache: false, error: null };
}

/**
 * Run an async worker over a queue with a fixed number of slots.
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<void>} worker
 */
export async function pool(items, limit, worker) {
  const queue = items.map((item, index) => ({ item, index }));
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
      while (queue.length) {
        const { item, index } = queue.shift();
        await worker(item, index);
      }
    })
  );
}

/** Stable short id for a posting, from its normalized URL. */
export function idFor(url) {
  return createHash('sha1').update(normalizeUrl(url)).digest('hex').slice(0, 16);
}

/**
 * Normalize a posting URL for deduplication: lowercase host, no tracking parameters,
 * no fragment, no trailing slash. Two sources pointing at the same posting collapse to one id.
 */
export function normalizeUrl(url) {
  try {
    const u = new URL(String(url));
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|gh_src|source|ref|referer|referrer|trk|src)/i.test(key)) u.searchParams.delete(key);
    }
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return String(url || '').trim();
  }
}

/** Convenience for building cache paths under the work directory. */
export function cachePath(cfg, ...parts) {
  const p = join(cfg.paths.work_dir, 'cache', ...parts);
  mkdirSync(dirname(p), { recursive: true });
  return p;
}
