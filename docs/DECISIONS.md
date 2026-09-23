# Decisions

Why the pipeline behaves the way it does. Most of these rules exist because something went wrong
first; the incident is recorded with each one, because a rule without its reason gets "simplified
away" by the next person to read the code.

---

## Location

### A location is domestic only on positive evidence

**Rule.** A posting counts as domestic when something says so: a country token, a state name or
code, a known city, a recognized pattern like `US-AL-Redstone`. A recognized foreign place makes
it foreign. Anything else is `check` — reported for a human, never assumed.

**Why.** The original rule was the opposite: domestic unless the location matched a short list of
foreign countries. On 2026-09-18 that list had no entry for Lithuania, Hungary or Ukraine, so
Vilnius, Budapest and Kyiv sat on a US-only shortlist. Four of 48 rows that day, seven across the
week. The bug was invisible because the rows looked plausible.

**Consequence.** A vague location like "3 Locations" or a bare "Remote" lands in `check` rather
than the shortlist. That's the intended trade: a few rows for a human to glance at, instead of
silent false positives. Enrichment resolves most of them by fetching the full location list.

### Mixed foreign and unknown locations are foreign

A posting listing "Sydney; Melbourne, VIC; Brisbane, QLD; Perth" used to land in `check`, because
Perth wasn't in the term list. If several locations are recognized as foreign and none is
domestic, the posting is foreign.

### Substring matching is a trap

"Indianapolis" contains "india". "New Mexico" contains "mexico". "IN Remote" means Indiana. Term
lists are matched on word boundaries, strong evidence is checked before foreign evidence, and
country codes are matched case-sensitively so "IN" is a state and "in" is a preposition. All
three cases are in `tests/geo_cases.json`.

### Home-state ranking comes from the profile

On-site work in the state someone is leaving ranks last. That's a preference, not a property of
the world, so it lives in `profile.yml` and the term list stays neutral.

---

## Dates

### The index's `first_seen` is not a posting date

**Rule.** `date_first_seen` (when the public index first saw a posting) and `date_posted` (the
employer's own date) are separate fields. Only the second is ever reported as the posting date,
and the workbook shows which basis produced it.

**Why.** Measured on a sample of 25 postings the index listed as new: 15 had been published one
to six days earlier. Merging the fields would have meant reporting stale jobs as fresh, daily.

### Discovery runs wider than reporting

Discovery uses a three-day window; enrichment re-applies the real one-day window against the
employer's date. A wide net costs nothing — filtering is local — and catches postings the index
was slow to see.

### The date comes from the system clock at runtime

Never from a value carried in from elsewhere. A date that is one day stale silently changes what
"today" means for every window in the run.

---

## Filtering

### Nothing is dropped silently

Every posting a keyword touched keeps a verdict and a reason, and lands in the workbook's Dropped
sheet. Titles that matched no keyword are counted but not written — otherwise the file would be
1.4M rows of noise.

**Why.** A filter that quietly eats good postings is invisible. The Vilnius bug was found by
reading rows, not by reading code.

### Positives are tested before negatives

A title that never matched a target keyword is irrelevant and is only counted. A title that
matched and was *then* excluded ("Data Engineer Intern") is written with its reason, because
that's how an over-broad exclusion gets noticed. Ordering it the other way produced 4,584 written
rows where 686 were informative.

### Titles mislead; read the posting

A CACI posting titled "Application Database Administrator" turned out to require five years of
Oracle EBS ERP administration. The scan ranks on titles because it must; the human reads the
description before applying. The tool is a filter, not a judgment.

---

## Enrichment

### Discovery is wide, enrichment is narrow

The index says what exists; the employer says what's true. Only postings that survive filtering
get a live fetch — hundreds of requests a day instead of tens of thousands. Politer, faster, and
the accuracy is spent where it matters.

### Location rank is recomputed after enrichment

Workday summarizes as "3 Locations", which no classifier can resolve. Once the full list arrives,
rank is recomputed: 43 of 308 postings changed rank in one run, in both directions — Boeing
resolved from `check` to domestic on-site, AutoStore resolved to Oslo and was dropped.

### "No reader" and "fetch failed" are different

One is a coverage gap in our providers (BambooHR, Paylocity), the other is a transient network
problem. They used to look identical in the output, which made the gap invisible.

---

## Scoring

### Two numbers, never merged

`fit_as_is` is the best single CV master, unedited. `fit_tailored` adds every other master plus
confirmed facts. The gap is what tailoring is worth; the terms missing from both are the honest
limits.

### Confirmed facts raise the ceiling only

A fact recorded in the profile ("uses Kubernetes daily") lifts `fit_tailored` and never
`fit_as_is`, because the document still says what it says. There is a test asserting this. The
alternative — letting a recorded fact improve the as-is score — would mean the tool quietly
claims things the CV doesn't.

### A missing required tool forces a skip

Regardless of percentage. A posting requiring "hands-on Power BI with DAX" is a pass/fail screen
for a candidate with no Power BI; scoring it at 60% and calling it "maybe" misreads how screening
works.

### Thin postings are flagged, not scored

Under ten recognized terms, a percentage is noise. Those are marked and sent to a human.

### The score is not an ATS score

It's keyword overlap against one posting. Real ATS platforms rank applications against each other
per posting, using recruiter-configured filters nobody outside can see. Everything user-facing
says so, because overclaiming here is both wrong and easy to disprove.

---

## Content and honesty

These apply to anything generated for a person: CVs, form answers, outreach.

- **Keywords are reformulated, never fabricated.** If the CV doesn't support a term, it goes in
  the "not added — no basis" line.
- **Coursework is not work experience.** Studying MITRE ATT&CK in a degree belongs under
  Education, not in a bullet that implies practice.
- **Using a tool is not building it.** Never claim authorship of something the person used.
- **Dates, titles and employers are never adjusted.** A background check finds those.
- **Nothing is submitted automatically.** The tool prepares; the person clicks.

---

## Architecture

### One term list, two implementations, one fixture file

The location classifier exists in Node (scanning) and Python (reporting). Both read
`config/geo-terms.json` and both run `tests/geo_cases.json`. Duplicated logic drifts; shared data
plus shared fixtures makes drift a test failure.

### Stages write files

Each stage reads and writes JSONL. Slower than passing objects in memory, and worth it: any stage
can be re-run alone, any day can be rebuilt from cache without network access, and every
intermediate result can be inspected when a number looks wrong.

### Config over code

Paths, endpoints, windows, thresholds, lane definitions, clearance and pay patterns all live in
`scan-config.yml`. The rule of thumb: if a second user would need a different value, it isn't a
constant.

### We didn't vendor the upstream sweep

The original plan was to copy career-ops' `scan-ats-full.mjs`. Tracing its imports found 33 files
and 13,357 lines, most of it tracker and plugin machinery we don't use. Reading the public index
directly took about 200 lines, covers two additional ATS platforms, and runs in seconds instead
of hours. MIT allowed the copy; the maintenance burden argued against it.

### The sweep has a second engine, and switches to it on its own

Discovery rests on one third-party index. That is a fine dependency until the morning it does not
publish, and a job search that skips a day is worse than a job search that runs slowly. So the
same filtering pipeline can be fed from employer boards read directly — the tracked scan, pointed
at public per-ATS company lists instead of one user's portals file.

It is the fallback, not the default: 25 boards yielded ~4,000 postings against the index's
1.4M, so its coverage is a fraction, and every board is a request. `max_boards` caps it, boards
from `portals.yml` go first so the cap never cuts the employers a user chose, and a failed
dataset read falls through to it automatically with a line saying so. Both engines return the
same shape, so nothing downstream knows which one ran — except the `source` field on each row,
which says `live`.
