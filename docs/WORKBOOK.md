# The workbook

What `ajs report` produces, sheet by sheet. To follow along with a real one, run `ajs demo` —
it builds `output/Demo-{date}.xlsx` from fixture data, with no network and no profile — and keep
it open beside this page.

Every sheet has a frozen header row, an autofilter across all columns, banded rows, and live
links in the URL column. One file per run, named from `paths.outputs` in `scan-config.yml`.

---

## Sheet 1 — Shortlist

Postings that passed every gate. Sorted by call, then by tailored fit. This is the sheet you
work from.

| Column | What it holds |
|---|---|
| Call | `apply` / `maybe` / `skip` — the threshold decision, colour-coded |
| Fit % (as-is) | Keyword overlap with your best single CV, unmodified |
| Fit % (tailored) | The ceiling, using every CV plus your confirmed facts |
| Location Rank | 1 Remote · 2 On-site outside home state · 3 On-site home state · 5 Check — colour-coded |
| Posted | The employer's own date. Blank means the platform publishes none |
| Lane | Which of your target roles this is, from your own lane patterns |
| Company | As published |
| Role Title | As published |
| Location | Every location the posting lists, joined |
| Clearance | Security clearance found in the description, or "not stated" |
| Pay (posted) | The pay range as the posting words it |
| Seniority | `senior+` when the title carries a seniority marker |
| Employer | `new` or `tracked` — whether this is a board you already follow |
| Applied Before | `Yes` when your tracker shows a past application there |
| ATS | Which platform hosts it: greenhouse, lever, ashby, workday, icims, bamboohr, paylocity |
| Best CV | Which of your CVs scored highest |
| Missing Terms | Terms the posting wants that no CV of yours supports — your tailoring list |
| Note | Enrichment status, repost signal, aggregator warning |
| URL | Clickable, straight to the posting |

**Read it in this order:** call, then location rank, then pay, then clearance. Those three kill
more applications than skills ever do.

## Sheet 2 — Check location

Same columns. Postings whose location could not be verified from positive evidence — "Remote",
"Multiple locations", an unrecognised city. They are never auto-dropped, because the alternative
is silently discarding real domestic jobs. Usually a handful are worth a look.

## Sheet 3 — Dropped

Everything a keyword touched that a gate then rejected.

| Column | What it holds |
|---|---|
| Drop Reason | Which gate, in words: "excluded title keyword: director", "pay below floor (90000)", "outside home country: Vilnius, Lithuania" |
| Lane | Which kind of work it was |
| Company, Role Title, Location, Posted, URL | As above |

This sheet is not a courtesy. A filter that quietly eats good postings is invisible without it —
sort by reason and look for counts that surprise you. Titles that matched no keyword at all are
counted but not listed; `ajs keywords` reports those instead.

## Sheet 4 — Method

What ran and under what settings: source file and row count, the discovery window, your
keywords, your location ranking rule, your pay floor. It exists so a number you distrust can be
traced back to the configuration that produced it.

---

## What the numbers are not

**Fit %** is keyword overlap between a posting's text and your CVs, scored against
`config/ats-vocab.yml`. It is a sorting aid, not a prediction. It cannot tell you the team is
three people, the title is misleading, or the role is a backfill for someone who just quit. Below
`scoring.min_terms_for_reliable_score` matched terms, treat it as noise.

The shipped vocabulary is IT-shaped (~122 technical terms), so a nurse or a teacher will see
understated percentages until they add their field's vocabulary to that file. Discovery and
ranking are unaffected.

**Posted** is the employer's date wherever a platform publishes one. The index's own
`first_seen` is a discovery signal and is never reported as a posting date — measured, 15 of 25
"new" postings were already 1–6 days old. See [DECISIONS.md](DECISIONS.md).
