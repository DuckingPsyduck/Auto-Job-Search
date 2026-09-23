/**
 * Provider parsing tests.
 *
 * Payload shapes are pinned here rather than fetched, so the suite stays offline and a provider
 * changing its response is a visible test failure rather than a silent field of blanks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerFor, parseBambooHr, parsePaylocity, relativeDate, jsonLdJobPosting, SUPPORTED } from '../src/node/providers.mjs';

test('routes a URL to the right provider', () => {
  const cases = {
    'https://job-boards.greenhouse.io/acme/jobs/123': 'greenhouse',
    'https://acme.com/careers?gh_jid=123': 'greenhouse',
    'https://jobs.lever.co/acme/abc-123': 'lever',
    'https://jobs.ashbyhq.com/acme/abc': 'ashby',
    'https://acme.wd1.myworkdayjobs.com/careers/job/Denver/Engineer_R1': 'workday',
    'https://careers-acme.icims.com/jobs/123/engineer/job': 'icims',
    'https://acme.bamboohr.com/careers/26': 'bamboohr',
    'https://recruiting.paylocity.com/recruiting/Jobs/Details/4348703': 'paylocity',
  };
  for (const [url, expected] of Object.entries(cases)) {
    assert.equal(providerFor(url), expected, url);
  }
});

test('every routed provider has a reader', () => {
  for (const name of ['greenhouse', 'lever', 'ashby', 'workday', 'icims', 'bamboohr', 'paylocity']) {
    assert.ok(SUPPORTED.includes(name), `${name} is readable`);
  }
});

test('BambooHR detail payload yields a date, a location and text', () => {
  const payload = {
    result: {
      jobOpening: {
        jobOpeningName: 'Data Engineer',
        datePosted: '2026-01-14',
        locationType: 'onsite',
        location: { city: 'Denver', state: 'Colorado', addressCountry: 'United States' },
        description: '<p>Build <strong>ETL</strong> pipelines in Python.</p>',
      },
    },
  };
  const detail = parseBambooHr(payload);
  assert.equal(detail.date_posted, '2026-01-14');
  assert.equal(detail.date_basis, 'bamboohr datePosted');
  assert.deepEqual(detail.locations, ['Denver, Colorado, United States']);
  assert.equal(detail.remote_type, '');
  assert.match(detail.text, /Build ETL pipelines in Python/);
});

test('BambooHR remote postings are marked remote', () => {
  const detail = parseBambooHr({
    result: { jobOpening: { datePosted: '2026-01-14', locationType: 'remote', location: { city: 'Austin', state: 'Texas' }, description: 'x' } },
  });
  assert.equal(detail.remote_type, 'Remote');
});

test('BambooHR returns null when the payload is not a posting', () => {
  assert.equal(parseBambooHr({}), null);
  assert.equal(parseBambooHr(null), null);
});

test('Paylocity description comes out of the page metadata, fully decoded', () => {
  // Paylocity escapes the description twice on the way into the meta tag.
  const html = `<html><head>
    <meta property="og:title" content="Acme - Data Engineer - Denver" />
    <meta property="og:description" content="TITLE: Data Engineer&amp;amp;nbsp;R&amp;amp;D team. Python &amp;amp; SQL required." />
  </head><body></body></html>`;
  const detail = parsePaylocity(html);
  assert.match(detail.text, /Python & SQL required/, 'entities decoded, not left as &amp;');
  assert.doesNotMatch(detail.text, /&amp;/);
  assert.equal(detail.date_posted, '', 'Paylocity publishes no date');
  assert.match(detail.date_basis, /publishes no date/, 'and the record says so');
});

test('Paylocity returns null without a description', () => {
  assert.equal(parsePaylocity('<html><head></head><body>nothing</body></html>'), null);
});

test('unknown employer sites fall back to the generic reader', () => {
  // Remote feeds point at employers' own pages, which are still readable.
  assert.equal(providerFor('https://careers.example-co.com/jobs/42', 'Jobicy'), 'generic');
  assert.equal(providerFor('https://jobs.lever.co/acme/x', 'Jobicy'), 'lever', 'a known host still wins');
  assert.equal(providerFor('not-a-url', ''), '', 'nothing to fetch, no reader');
});

test('schema.org JobPosting is read from a page when present', () => {
  const html = `<html><head><script type="application/ld+json">
    {"@type":"JobPosting","title":"Data Engineer","datePosted":"2026-01-14",
     "jobLocation":{"address":{"addressLocality":"Denver","addressRegion":"CO","addressCountry":"US"}},
     "description":"<p>Build pipelines</p>"}
  </script></head><body></body></html>`;
  const posting = jsonLdJobPosting(html);
  assert.equal(posting.title, 'Data Engineer');
  assert.equal(posting.datePosted, '2026-01-14');
});

test('a malformed JSON-LD block does not stop the next one', () => {
  const html = `<html><head>
    <script type="application/ld+json">{ not json }</script>
    <script type="application/ld+json">{"@type":"JobPosting","title":"SRE"}</script>
  </head></html>`;
  assert.equal(jsonLdJobPosting(html).title, 'SRE');
});

test('pages without a JobPosting block yield nothing', () => {
  assert.equal(jsonLdJobPosting('<html><head></head><body>hi</body></html>'), null);
  assert.equal(jsonLdJobPosting('<script type="application/ld+json">{"@type":"Organization"}</script>'), null);
});

test('Workday relative dates resolve against the run date', () => {
  assert.equal(relativeDate('Posted Today', '2026-01-14'), '2026-01-14');
  assert.equal(relativeDate('Posted Yesterday', '2026-01-14'), '2026-01-13');
  assert.equal(relativeDate('Posted 3 Days Ago', '2026-01-14'), '2026-01-11');
  assert.equal(relativeDate('Posted 2 Weeks Ago', '2026-01-14'), '2025-12-31');
  assert.equal(relativeDate('', '2026-01-14'), '');
});
