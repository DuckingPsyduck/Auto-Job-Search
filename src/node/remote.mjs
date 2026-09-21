/**
 * Remote-board pull: public feeds that list remote roles across many employers.
 *
 * These are small, fast and complementary — they surface employers with no ATS board of their
 * own. Sources are configured, not hardcoded, and each one's access basis is recorded in
 * docs/SOURCES.md. Check robots.txt and terms before enabling a new feed.
 */
import { createWriteStream } from 'node:fs';
import { Geo } from './geo.mjs';
import { fetchRaw, idFor, normalizeUrl } from './http.mjs';
import { buildTitleMatcher, buildLaneMatcher, buildCoverage, classify } from './filters.mjs';
import { today, workPath } from './config.mjs';
import { daysBefore } from './sweep.mjs';

const clean = s => String(s || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ')
  .trim();

const isoDate = value => {
  if (!value) return '';
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.valueOf()) ? '' : d.toISOString().slice(0, 10);
};

/** Pull `<item>` elements out of an RSS feed without an XML dependency. */
function parseRss(xml) {
  return [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => {
    const tag = name => {
      const m = new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`).exec(item);
      return m ? clean(m[1]) : '';
    };
    return { title: tag('title'), link: tag('link'), date: tag('pubDate'), region: tag('region') || tag('category') };
  });
}

/** Feed shapes differ; each adapter returns our posting shape. */
const adapters = {
  rss(body, source) {
    return parseRss(body).map(item => {
      // We Work Remotely titles read "Company: Role".
      const [company, role] = item.title.includes(':')
        ? [item.title.split(':')[0], item.title.split(':').slice(1).join(':')]
        : ['', item.title];
      return {
        source: 'remote',
        ats: source.name,
        company: clean(company) || source.name,
        company_name: clean(company),
        title: clean(role),
        url: normalizeUrl(item.link),
        locations: [item.region].filter(Boolean),
        date_posted: isoDate(item.date),
        date_basis: `${source.name} pubDate`,
      };
    });
  },

  json(body, source) {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return [];
    }
    const items = Array.isArray(data) ? data : (data?.[source.items_path || 'jobs'] || []);
    return items.map(job => ({
      source: 'remote',
      ats: source.name,
      company: job.companyName || job.company_name || job.company || source.name,
      company_name: job.companyName || job.company_name || job.company || '',
      title: job.jobTitle || job.title || job.position || '',
      url: normalizeUrl(job.url || job.jobUrl || job.link || ''),
      locations: [job.jobGeo || job.location || job.candidate_required_location].filter(Boolean),
      date_posted: isoDate(job.pubDate || job.pub_date || job.publication_date || job.date),
      date_basis: `${source.name} publication date`,
    }));
  },
};

/**
 * @param {object} cfg
 * @param {{date?: string, sinceDays?: number, log?: Function}} [opts]
 */
export async function runRemote(cfg, { date = today(), sinceDays, log = () => {} } = {}) {
  if (!cfg.profile) throw new Error('remote pull needs a profile: fill config/profile.yml');

  const sources = (cfg.sources?.remote_boards || []).filter(s => s.enabled !== false);
  if (!sources.length) {
    log('no remote boards enabled in sources.remote_boards');
    return { date, out: null, counts: {}, sources: 0 };
  }

  const days = sinceDays ?? cfg.windows?.remote_boards_days ?? 0;
  const since = daysBefore(date, days);
  const ctx = {
    cfg,
    titles: buildTitleMatcher(cfg),
    lanes: buildLaneMatcher(cfg),
    geo: Geo.fromConfig(cfg),
    coverage: buildCoverage(cfg, []),
    since: null,
  };

  const rows = [];
  const report = [];
  for (const source of sources) {
    const res = await fetchRaw(source.url, cfg, {
      accept: source.kind === 'rss' ? 'application/rss+xml,text/xml' : 'application/json',
    });
    if (!res.ok || !res.body) {
      report.push(`${source.name}: ${res.error || 'no response'}`);
      continue;
    }
    const adapter = adapters[source.kind] || adapters.json;
    const postings = adapter(res.body.toString('utf8'), source).filter(p => p.url && p.title);
    report.push(`${source.name}: ${postings.length}`);
    rows.push(...postings.map(p => ({ id: idFor(p.url), date_first_seen: p.date_posted || date, scraped_at: date, ...p })));
  }

  const seen = new Set();
  const kept = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const classified = classify(row, ctx);
    if (classified.verdict === 'dropped' && !classified.title_relevant) continue;
    if (classified.verdict !== 'dropped' && row.date_posted && row.date_posted < since) {
      classified.verdict = 'dropped';
      classified.verdict_reason = `posted ${row.date_posted}, before ${since}`;
    }
    kept.push(classified);
  }

  const outPath = workPath(cfg, `ranked-remote-${date}.jsonl`);
  const out = createWriteStream(outPath, { encoding: 'utf8' });
  for (const row of kept) out.write(`${JSON.stringify(row)}\n`);
  await new Promise(resolve => out.end(resolve));

  const counts = kept.reduce((acc, r) => ((acc[r.verdict] = (acc[r.verdict] || 0) + 1), acc), {});
  log(`remote ${date}: ${report.join(' · ')} | shortlist ${counts.shortlist || 0} · check ${counts.check || 0}`);
  return { date, out: outPath, counts, sources: sources.length, fetched: rows.length };
}
