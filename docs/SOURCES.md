# Sources

Every place this tool fetches from, what permits it, and what we checked. Also the sources we
rejected, so nobody re-tests the same dead ends.

**The standing rule:** read public APIs and public feeds, identify the client honestly, cache
instead of re-fetching, and never work around a bot wall or a login. If a site's terms forbid
automated access, it is a browser-only source and does not belong in the pipeline.

---

## In use

### Public posting index — job-board-aggregator

- **What:** a daily index of roughly 1.4M active postings across Greenhouse, Lever, Ashby,
  Workday, iCIMS, BambooHR and Paylocity, published as 59 gzipped JSON chunks (~70 MB).
- **Where:** [github.com/Feashliaa/job-board-aggregator](https://github.com/Feashliaa/job-board-aggregator)
  (code, MIT) and its generated data repository, served over GitHub Pages.
- **Basis:** public repository; code is MIT. The data repository carries no license of its own,
  so we fetch at runtime, cache with ETags, and do not redistribute it.
- **Caveat:** each record's `first_seen` is the indexer's first sighting, not the employer's
  posting date. Never reported as a posting date — see [DECISIONS](DECISIONS.md#dates).
- **Politeness:** one CDN fetch per chunk per day, skipped entirely when the ETag is unchanged.

### Employer ATS APIs

Read directly for the employers in `config/portals.yml`, and for enrichment of anything
shortlisted.

| Platform | Endpoint | Gives us |
|---|---|---|
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{slug}/jobs` | `first_published`, location, description |
| Lever | `api.lever.co/v0/postings/{slug}` | `createdAt`, location, description |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{slug}` | `publishedAt`, locations, description |
| Workday | `{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` | posted date (relative), full location list, description |
| iCIMS | the posting page | description only; no machine-readable date |
| BambooHR | `{company}.bamboohr.com/careers/{id}/detail` | `datePosted`, structured location, description |
| Paylocity | the posting page's Open Graph metadata | full description; the page publishes no date |
| anything else | the posting page | schema.org `JobPosting` when published, otherwise page text |

The last row is the fallback for postings a remote feed points at, which land on an employer's
own site rather than a known ATS. It reads the page the same way a search engine would: the
structured data the site publishes for exactly that purpose, or failing that the visible text.

**Basis:** these are the public endpoints that power each employer's own careers page — the same
data any visitor's browser receives. We request only postings, never candidate data, and never
authenticate.

**Politeness:** configured concurrency (6 board fetches, 8 description fetches), a 25s timeout,
three retries with backoff, and no per-posting fetch until a posting has passed filtering.

### Remote job feeds

| Feed | Endpoint | Checked |
|---|---|---|
| We Work Remotely | `weworkremotely.com/remote-jobs.rss` | robots.txt allows `/`; RSS is published for syndication |
| Jobicy | `jobicy.com/api/v2/remote-jobs` | public documented API; no robots.txt served |
| Working Nomads | `workingnomads.com/api/exposed_jobs/` | robots.txt has an empty `Disallow`, i.e. allow all |

Polled once a day. Adding a feed is a config change; check its robots.txt and terms first, and
record the check here with a date.

---

## Rejected, and why

Keep this list. Each of these looked promising and cost time to disprove.

| Source | Why not |
|---|---|
| **Remotive** | robots.txt disallows the API path |
| **Remote OK** | No usable location field; everything reads "worldwide" |
| **Himalayas** | Thin results after filtering; not worth the request |
| **Built In** | Cloudflare bot wall |
| **Hiring Cafe** | Search endpoint rejects plain requests |
| **Juju** | Its data lives behind a disallowed `/api/` path |
| **Glassdoor** | Bot wall ("Humans only"). Read it in a browser; do not automate |
| **ClearanceJobs** | robots.txt disallows `/jobs?`; terms prohibit robots and data mining. Browser use is fine, automation is not |
| **LinkedIn** | Terms prohibit scraping. Use it as a human |
| **RecruitMilitary** | JavaScript-only pages; robots.txt returns HTTP 405 |

---

## How access is judged

1. **robots.txt, `User-agent: *`.** That's the line that applies to us. A directive aimed at a
   specific AI crawler (GPTBot and similar) governs that crawler, not a tool a person runs for
   their own job search.
2. **Terms of service.** An explicit prohibition on robots or data mining settles it, whatever
   robots.txt says.
3. **Bot protection.** A CAPTCHA or a "verify you are human" page is an answer. We do not solve
   or bypass them.
4. **Data minimization.** Fetch postings, not people. No candidate data, no authenticated
   endpoints, no private pages.

When a source is off-limits to the pipeline but fine in a browser, that belongs in the runbook as
a manual step, not in code.

---

## Identifying ourselves

`http.user_agent` in `scan-config.yml` should name the tool and carry a contact address:

```yaml
user_agent: "auto-job-search/0.1 (+you@example.com)"
```

A site owner who wants to ask us to stop should be able to. Don't impersonate a browser.
