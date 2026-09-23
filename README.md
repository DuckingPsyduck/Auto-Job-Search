# Auto Job Search

Find the job postings worth your time, every morning, in about a minute.

Auto Job Search scans roughly 1.4 million live postings, keeps the ones that match your target
roles and your location rules, checks each survivor against the employer's own job board for the
real posting date and pay, and scores it against your CV. You get a ranked shortlist with a
plain verdict on each one: **apply**, **maybe**, or **skip**.

It does not apply to anything for you. It decides what deserves an application, and tells you
why — which is the part that actually takes time.

```
$ ajs daily

sweep 2026-09-22: window 2026-09-19 .. 2026-09-22, keywords 8
dataset: 1,434,516 records in 58 chunks | shortlist 159 · check 100 · dropped 9,575
tracked: 3,983 postings across 7 boards | shortlist 3 · check 1
remote 2026-09-22: We Work Remotely: 83 · Jobicy: 100 · Working Nomads: 55
enriched 230 (15 unreadable, 14 no reader) | rank changed 43 | dropped as out-of-window 93
scored 129 postings | apply 40 · maybe 56 · skip 33

output/ATS-Sweep-2026-09-22.xlsx
```

---

## Quickstart

Requires **Node 20+**. Python 3.10+ with `openpyxl` and `PyYAML` is optional and adds Excel
reports and CV scoring.

```bash
git clone https://github.com/YOUR-USER/auto-job-search
cd auto-job-search
npm install

node bin/ajs.mjs demo     # see a sample workbook first — no setup, no network
node bin/ajs.mjs init     # interactive setup, ~3 minutes
node bin/ajs.mjs daily    # first scan
```

Prefer not to answer prompts? `ajs init --answers answers.json` takes the same questions from a
JSON file — see `fixtures/demo-answers.json`.

`init` asks what the tool cannot infer — your target roles, where you will and won't work, a
pay floor, clearance status — and reads your CV files to propose the keywords it searches on.
Put your CV masters (`.docx`) in `private/cv/` before running it, and the suggestions get much
better.

Everything it writes lands in two places: `output/` for the workbook you read, and `.work/` for
the machine-readable run data. Both are gitignored, as is your profile.

---

## What you get

A workbook with four sheets:

| Sheet | What's in it |
|---|---|
| **Shortlist** | Postings that passed every gate, sorted by verdict then fit. Call, fit %, location rank, posted date, company, title, location, clearance, pay, missing keywords, link |
| **Check location** | Postings whose location couldn't be verified — "3 Locations", a bare "Remote", a city the term list doesn't know. For a human glance, never silently dropped |
| **Dropped** | Every posting a keyword touched but a gate rejected, with the reason |
| **Method** | What ran, with which settings, and the caveats that matter |

The dropped sheet is not filler. A filter that quietly eats good postings is invisible without
it, and that has happened to us.

---

## How it works

```
DISCOVER   public daily index (~1.4M postings)  +  your tracked employer boards  +  remote feeds
              │
FILTER     title keywords → lane → location rank → pay floor        every row keeps a verdict
              │                                                      and a reason
ENRICH     survivors only: the employer's own record —
           true posted date, full locations, clearance, pay
              │
SCORE      keyword overlap against your CV masters → apply / maybe / skip
              │
REPORT     Excel workbook + JSONL
```

**Three discovery sources, because each catches what the others miss.** The public index is
broad. Your tracked boards give exact dates and cover employers the index doesn't. Remote feeds
surface companies with no ATS board at all. On a typical day, a third of tracked hits also
appear in the index — mutual confirmation — and the rest are found by only one source.

**Enrichment is narrow on purpose.** Hundreds of requests a day instead of tens of thousands:
the index tells us what exists, the employer tells us the truth about it. That matters more than
it sounds — in one sample of 25 postings the index listed as new, 15 had actually been published
one to six days earlier.

**Locations need positive evidence.** A location counts as domestic only when something says so:
a state, a country name, a known city. Anything unrecognized goes to the check sheet rather than
being assumed. This came from a real failure, when Vilnius, Budapest and Kyiv reached a US-only
shortlist.

---

## The fit score, honestly

`fit_as_is` and `fit_tailored` measure **keyword overlap** between a posting and your CV
documents — the share of a posting's recognized terms your CV also contains.

That is not an ATS score. Real applicant-tracking systems rank applications against each other,
per posting, using filters a recruiter configures. Nobody outside the company can see that
number, and any tool claiming to compute it is guessing.

What the two numbers are good for:

- **`fit_as_is`** — the best single CV master, unedited. What happens if you apply right now.
- **`fit_tailored`** — all your masters plus facts you've confirmed but not yet written down.
  The ceiling tailoring can reach without inventing anything.
- **The gap between them** — what an hour of tailoring is worth on this posting.
- **`fit_missing`** — terms in neither. The honest limits, and the basis for a "not added" line
  in any tailored CV.

The call follows: **apply** at 75%+, **maybe** at 65–75%, **skip** below that or whenever a
required core tool is missing outright, because that's a pass/fail screen rather than a few
lost points.

---

## Working with an AI agent

The repository is written to be driven by an AI assistant. Point yours at
**[AGENTS.md](AGENTS.md)** — it documents the commands, every field in the output, the tailoring
method, and the rules the agent must follow (never invent experience, never submit an
application, never edit your profile uninvited).

`CLAUDE.md`, `GEMINI.md` and `.cursorrules` point at the same file, so most agents find it on
their own. Agents without shell access can still use the tailoring method on a pasted job
description.

---

## Configuration

Two files, both gitignored, both created for you by `init`:

- **`config/profile.yml`** — you: contact details, work authorization, clearance, location rules,
  pay floor, target roles and their keywords, and a ledger of facts confirmed over time. This is
  the only file with personal data, and the only source for claims made on your behalf.
- **`config/scan-config.yml`** — the pipeline: paths, sources, windows, thresholds, the patterns
  used to read clearance and pay out of a posting. Every setting is documented inline in
  `config/scan-config.example.yml`.

Two more you can edit as you learn what works:

- **`config/portals.yml`** — employers to watch directly. Start with 10–30 you would genuinely
  take a job at.
- **`config/ats-vocab.yml`** — the ~120 skill terms used for scoring. Add the vocabulary of your
  field; the score gets sharper.

Keywords are the single biggest lever on result quality. Too broad and you drown; too narrow and
you miss. Check the dropped sheet weekly and adjust.

---

## Commands

```
ajs demo        build a sample workbook from fixture data
ajs init        set up your profile and configuration
ajs daily       sweep + tracked + remote + enrich + score + report
ajs sweep       discovery from the public index only
ajs tracked     your employer boards only
ajs remote      remote-job feeds only
ajs enrich      fetch employer records for the day's survivors
ajs score       score the day's postings against your CVs
ajs report      build the workbook
ajs config      print the resolved configuration
```

Flags: `--date YYYY-MM-DD`, `--since N` (discovery window), `--chunks N` (sample the index),
`--limit N`, `--config <path>`, `--quiet`.

---

## What it does not do

- **It does not apply for you.** It prepares; you review and submit. Every time.
- **It does not create accounts or log in anywhere.**
- **It does not scrape sites whose terms forbid it,** and it does not work around bot
  protection. It reads public APIs and public feeds.
- **It does not invent experience.** Tailoring reformulates what your CV says; anything else is
  reported as missing.

---

## Limitations

- **The public index is a third-party project** ([job-board-aggregator](https://github.com/Feashliaa/job-board-aggregator),
  refreshed daily). If it stops, the broad sweep stops with it; tracked boards and remote feeds
  keep working.
- **Its `first_seen` date lags the employer's.** That's why enrichment exists, and why the
  discovery window runs wider than the reporting window.
- **Two ATS platforms have no detail reader yet** (BambooHR, Paylocity). Their postings appear,
  marked `no reader`, without a confirmed date or pay.
- **Location terms are US-centric out of the box.** `config/geo-terms.json` is editable, and
  both the Node and Python classifiers read from it.
- **Excel reports and CV scoring need Python.** Scanning does not.

---

## Documentation

| Document | For |
|---|---|
| [AGENTS.md](AGENTS.md) | AI agents driving the tool — commands, output format, the tailoring method |
| [docs/ONBOARDING.md](docs/ONBOARDING.md) | Setting up, and what each answer changes |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | The daily and weekly rhythm; what to do with the workbook |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Why the pipeline behaves as it does, with the incidents behind each rule |
| [docs/SOURCES.md](docs/SOURCES.md) | Every data source, its access basis, and the ones we rejected |

## Development

```bash
npm test                              # Node tests
python -m pytest tests -q             # Python tests (needs PYTHONPATH=src/python)
```

The location classifier exists twice, once per language, and both read the same term list and
the same fixture file (`tests/geo_cases.json`) so they cannot drift apart. Fixtures carry real
regressions: foreign cities that once reached a domestic shortlist, and substring traps like
Indianapolis containing "india".

---

## License

MIT — see [LICENSE](LICENSE).

The full-sweep design was informed by [career-ops](https://github.com/santifer/career-ops) (MIT);
this implementation is original. Posting data comes from
[job-board-aggregator](https://github.com/Feashliaa/job-board-aggregator), fetched at runtime and
not redistributed here. See [NOTICE.md](NOTICE.md).
