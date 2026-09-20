/**
 * Per-ATS detail fetching.
 *
 * Given a posting URL, return the employer's own record: the real posted date, the full
 * location list, and the description text. Discovery gives us a URL; only the source can give
 * us a trustworthy date — see docs/DECISIONS.md on why the dataset's `first_seen` is not one.
 *
 * Each provider returns the same shape, or null when the posting cannot be read:
 *   { date_posted, date_basis, locations, remote_type, text }
 */
import { fetchJson, fetchText } from './http.mjs';
import { htmlToText } from './extract.mjs';

const iso = value => {
  if (!value) return '';
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(Number(s) || s);
  return Number.isNaN(d.valueOf()) ? '' : d.toISOString().slice(0, 10);
};

/** Which provider handles a URL. Falls back to the `ats` label from discovery. */
export function providerFor(url, ats = '') {
  const u = String(url || '');
  if (/greenhouse\.io/.test(u) || /gh_jid=/.test(u)) return 'greenhouse';
  if (/jobs\.lever\.co/.test(u)) return 'lever';
  if (/jobs\.ashbyhq\.com/.test(u)) return 'ashby';
  if (/myworkdayjobs\.com/.test(u)) return 'workday';
  if (/icims\.com/.test(u)) return 'icims';
  return String(ats || '').toLowerCase();
}

const providers = {
  /** Greenhouse: board API by slug + job id; `first_published` is the posting date. */
  async greenhouse(url, cfg) {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const jobsAt = parts.indexOf('jobs');
    const slug = jobsAt > 0 ? parts[jobsAt - 1] : parts[0];
    const id = u.searchParams.get('gh_jid') || (jobsAt >= 0 ? parts[jobsAt + 1] : parts.at(-1));
    if (!slug || !id) return null;
    const job = await fetchJson(
      (cfg.sources?.ats?.greenhouse_job || 'https://boards-api.greenhouse.io/v1/boards/{slug}/jobs/{id}')
        .replace('{slug}', slug).replace('{id}', id),
      cfg
    );
    if (!job) return null;
    return {
      date_posted: iso(job.first_published || job.updated_at),
      date_basis: job.first_published ? 'greenhouse first_published' : 'greenhouse updated_at',
      locations: [job.location?.name].filter(Boolean),
      remote_type: '',
      text: htmlToText(job.content),
    };
  },

  /** Lever: posting API; `createdAt` is an epoch in milliseconds. */
  async lever(url, cfg) {
    const [site, id] = new URL(url).pathname.split('/').filter(Boolean);
    if (!site || !id) return null;
    const job = await fetchJson(
      (cfg.sources?.ats?.lever_job || 'https://api.lever.co/v0/postings/{slug}/{id}')
        .replace('{slug}', site).replace('{id}', id),
      cfg
    );
    if (!job) return null;
    const lists = (job.lists || []).map(l => `${l.text}: ${htmlToText(l.content)}`).join('\n');
    return {
      date_posted: iso(job.createdAt),
      date_basis: 'lever createdAt',
      locations: [job.categories?.location].filter(Boolean),
      remote_type: job.workplaceType || '',
      text: [job.descriptionPlain || htmlToText(job.description), lists, job.additionalPlain || ''].join('\n').trim(),
    };
  },

  /** Ashby: only a whole-board endpoint exists, so boards are cached per run. */
  async ashby(url, cfg, cache) {
    const [org, id] = new URL(url).pathname.split('/').filter(Boolean);
    if (!org || !id) return null;
    const key = `ashby:${org}`;
    if (!cache.has(key)) {
      cache.set(key, await fetchJson(
        (cfg.sources?.ats?.ashby_board || 'https://api.ashbyhq.com/posting-api/job-board/{slug}')
          .replace('{slug}', org),
        cfg
      ));
    }
    const board = cache.get(key);
    const job = board?.jobs?.find(j => j.id === id);
    if (!job) return null;
    return {
      date_posted: iso(job.publishedAt),
      date_basis: 'ashby publishedAt',
      locations: [job.location, ...(job.secondaryLocations || []).map(l => l?.location)].filter(Boolean),
      remote_type: job.isRemote ? 'Remote' : '',
      text: job.descriptionPlain || htmlToText(job.descriptionHtml),
    };
  },

  /**
   * Workday: the CXS API behind every myworkdayjobs site.
   * Its `postedOn` is relative prose ("Posted 3 Days Ago"), so it is resolved against the run
   * date; `startDate` is used when present because it is absolute.
   */
  async workday(url, cfg, _cache, runDate) {
    const u = new URL(url);
    const tenant = u.hostname.split('.')[0];
    const parts = u.pathname.split('/').filter(Boolean);
    const site = parts[0];
    const path = parts.slice(1).join('/');
    const data = await fetchJson(
      (cfg.sources?.ats?.workday_cxs || 'https://{host}/wday/cxs/{tenant}/{site}/{path}')
        .replace('{host}', u.hostname).replace('{tenant}', tenant)
        .replace('{site}', site).replace('{path}', path),
      cfg
    );
    const info = data?.jobPostingInfo;
    if (!info) return null;
    return {
      date_posted: iso(info.startDate) || relativeDate(info.postedOn, runDate),
      date_basis: info.startDate ? 'workday startDate' : 'workday postedOn (relative)',
      locations: [info.location, ...(info.additionalLocations || [])].filter(Boolean),
      remote_type: info.remoteType || '',
      text: htmlToText(info.jobDescription),
    };
  },

  /** iCIMS: no public API; the posting page carries the text. */
  async icims(url, cfg) {
    const html = await fetchText(`${url}${url.includes('?') ? '&' : '?'}in_iframe=1`, cfg);
    if (!html) return null;
    return { date_posted: '', date_basis: 'icims (page has no machine-readable date)', locations: [], remote_type: '', text: htmlToText(html) };
  },
};

/** "Posted 3 Days Ago" / "Posted Today" → an ISO date, relative to the run date. */
export function relativeDate(text, runDate) {
  const t = String(text || '').toLowerCase();
  if (!t || !runDate) return '';
  const base = new Date(`${runDate}T00:00:00Z`);
  const back = days => new Date(base.getTime() - days * 86400000).toISOString().slice(0, 10);
  if (t.includes('today')) return runDate;
  if (t.includes('yesterday')) return back(1);
  const m = /posted\s+(\d+)\+?\s*day/.exec(t);
  if (m) return back(Number(m[1]));
  const weeks = /posted\s+(\d+)\+?\s*week/.exec(t);
  if (weeks) return back(Number(weeks[1]) * 7);
  const months = /posted\s+(\d+)\+?\s*month/.exec(t);
  if (months) return back(Number(months[1]) * 30);
  return '';
}

/**
 * Fetch one posting's detail record.
 * @param {object} posting normalized posting (needs `url`, optionally `ats`)
 * @param {object} cfg
 * @param {Map} cache per-run cache for board-level endpoints
 * @param {string} runDate resolves Workday's relative dates
 * @returns {Promise<object|null>}
 */
export async function fetchDetail(posting, cfg, cache, runDate) {
  const provider = providers[providerFor(posting.url, posting.ats)];
  if (!provider) return null;
  try {
    return await provider(posting.url, cfg, cache, runDate);
  } catch {
    return null;
  }
}

export const SUPPORTED = Object.keys(providers);
