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
  if (/bamboohr\.com/.test(u)) return 'bamboohr';
  if (/recruiting\.paylocity\.com/.test(u)) return 'paylocity';
  const labelled = String(ats || '').toLowerCase();
  if (providers[labelled]) return labelled;
  // Remote feeds point at employers' own sites; those still have a readable page.
  return /^https?:\/\//.test(u) ? 'generic' : '';
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

  /**
   * BambooHR: every careers site exposes `/careers/{id}/detail` as JSON, with a real
   * `datePosted` and a structured location.
   */
  async bamboohr(url, cfg) {
    const u = new URL(url);
    const id = u.pathname.split('/').filter(Boolean).pop();
    if (!id) return null;
    const data = await fetchJson(`https://${u.hostname}/careers/${id}/detail`, cfg);
    return parseBambooHr(data);
  },

  /**
   * Paylocity: the posting page is client-rendered and exposes no JSON, but its Open Graph
   * metadata carries the full description (a few thousand characters). No date is published
   * anywhere on the page, so postings from here keep the discovery date and say so.
   */
  async paylocity(url, cfg) {
    const html = await fetchText(url, cfg);
    return html ? parsePaylocity(html) : null;
  },

  /** iCIMS: no public API; the posting page carries the text. */
  async icims(url, cfg) {
    const html = await fetchText(`${url}${url.includes('?') ? '&' : '?'}in_iframe=1`, cfg);
    if (!html) return null;
    return { date_posted: '', date_basis: 'icims (page has no machine-readable date)', locations: [], remote_type: '', text: htmlToText(html) };
  },

  /**
   * Anything else — chiefly postings a remote feed points at, which land on an employer's own
   * site rather than a known ATS. Reads structured data when the page publishes it (most job
   * pages carry schema.org JobPosting), otherwise falls back to the page text.
   */
  async generic(url, cfg) {
    const html = await fetchText(url, cfg);
    if (!html) return null;
    const posting = jsonLdJobPosting(html);
    if (posting) {
      const places = [posting.jobLocation].flat().filter(Boolean).map(l => {
        const a = l.address || {};
        return [a.addressLocality, a.addressRegion, a.addressCountry].filter(Boolean).join(', ');
      }).filter(Boolean);
      return {
        date_posted: iso(posting.datePosted),
        date_basis: 'schema.org JobPosting datePosted',
        locations: places,
        remote_type: posting.jobLocationType === 'TELECOMMUTE' ? 'Remote' : '',
        text: htmlToText(posting.description),
      };
    }
    const text = htmlToText(html);
    return text.length < 400
      ? null
      : { date_posted: '', date_basis: 'page text (no machine-readable date)', locations: [], remote_type: '', text };
  },
};

/** Pull a schema.org JobPosting out of a page's JSON-LD blocks, if it publishes one. */
export function jsonLdJobPosting(html) {
  for (const [, block] of String(html).matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(block.trim());
      for (const node of [data, ...(data['@graph'] || [])].flat()) {
        if (node && node['@type'] === 'JobPosting') return node;
      }
    } catch {
      // A malformed block is common on marketing pages; try the next one.
    }
  }
  return null;
}

/**
 * Shape a BambooHR `/careers/{id}/detail` payload into a detail record.
 * Exported so the parsing can be tested without a network call.
 */
export function parseBambooHr(data) {
  const job = data?.result?.jobOpening;
  if (!job) return null;
  const place = job.location || {};
  const parts = [place.city, place.state, place.addressCountry].filter(Boolean);
  const remote = /remote/i.test(String(job.locationType || ''));
  return {
    date_posted: iso(job.datePosted),
    date_basis: 'bamboohr datePosted',
    locations: parts.length ? [parts.join(', ')] : [],
    remote_type: remote ? 'Remote' : '',
    text: htmlToText(job.description),
  };
}

/**
 * Shape a Paylocity posting page into a detail record, reading the Open Graph metadata.
 * Exported for testing; see the note on the provider about the missing date.
 */
export function parsePaylocity(html) {
  const meta = name => {
    const m = new RegExp(`<meta property="og:${name}" content="([\\s\\S]*?)"\\s*/?>`, 'i').exec(html);
    return m ? htmlToText(m[1]) : '';
  };
  // Paylocity escapes the description twice on its way into the meta tag ("&amp;amp;"), so one
  // decoding pass leaves entities behind.
  const description = htmlToText(meta('description'));
  if (!description) return null;
  // og:title is "Company - Role - Location"; the tail is often the location, but not reliably,
  // so it is left to the discovery record rather than guessed at here.
  return {
    date_posted: '',
    date_basis: 'paylocity (page publishes no date)',
    locations: [],
    remote_type: '',
    text: description,
  };
}

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
