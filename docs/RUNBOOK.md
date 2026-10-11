# Runbook

How to actually run a job search with this, day to day. The first week is setup and tuning; after
that it's twenty minutes a morning.

---

## Daily

```bash
ajs daily
```

One command, about a minute. It runs discovery from all three sources, enriches the survivors,
scores them against your CVs, and writes the workbook.

**Then, in the workbook** (every sheet and column: [WORKBOOK.md](WORKBOOK.md)):

1. **Open the Shortlist sheet.** It's sorted by call, then by tailored fit. Start at the top.
2. **Read the `apply` rows first.** For each: does the location work, does the pay clear your
   floor, is the clearance requirement one you can meet? Those three kill more applications than
   skills ever do.
3. **Open the postings you're serious about** and read the description. The score is keyword
   overlap; it cannot tell you the job is boring, the team is three people, or the title is
   misleading. Titles mislead often — a "Database Administrator" once turned out to be an Oracle
   EBS specialist role.
4. **Pick two to five.** Tailor and submit those rather than firing off fifteen untailored.
5. **Glance at the Check location sheet.** These are postings whose location couldn't be
   verified. Usually a handful are real and domestic.

**Tailoring each one:** follow the method in [AGENTS.md §6](../AGENTS.md#6-tailoring-a-cv-for-one-posting).
Fit line, call, then summary → bullets → skills → skills field, and a closing line naming what
has no basis in your CV. Edit your own `.docx`, export to PDF, submit it yourself.

**Recording as you go:** when you discover you've done something your CV doesn't mention, add it
to `confirmed_facts` in `config/profile.yml` with what it supports and what's still unverified.
Tomorrow's scores improve, and future tailoring uses it without overreaching.

---

## Weekly

**Check the Dropped sheet.** Sort by reason and look for counts that surprise you.

| What you see | What it means | What to do |
|---|---|---|
| Huge "title outside target keywords" | Normal — most postings aren't yours | Nothing |
| Many "excluded title keyword" | An exclusion is too broad | Narrow it in `titles.extra_negative` |
| Many "posted before …" | Your window is short or the index lagged | Raise `windows.full_sweep_days` |
| Many "outside home country" | Normal, unless you accept foreign roles | Check `location.home_country` |
| Many "pay below floor" | Your floor may be above your market | Reconsider or accept fewer results |
| Almost nothing kept | Keywords too narrow | Add variants; see below |

**Tune keywords.** They matter more than every other setting combined, so don't guess:

```bash
ajs keywords
```

It lists every keyword with the number of postings it matched today, and then the titles the
scan threw away that share vocabulary with your searches — the "analytics engineer" you never
thought to look for. Add the ones that are your work to `profile.targets[].keywords`; they are
titles other people hold, not claims about your experience.

A keyword at zero for one day means nothing. A week of zeros means the phrase is not what
employers call the job.

**Add employers.** Any company you'd genuinely join goes in `config/portals.yml`. The tracked
scan reads their board directly, so you see postings on day one with exact dates.

**Review what got replies.** If a lane is silent after 30 applications, the problem is upstream
of the applications — the lane, the level, or the CV.

---

## Monthly

- **Re-read your own CV masters.** They drift as you tailor. Fold the good phrasings back in.
- **Prune `portals.yml`.** Boards that never produce a match are just latency.
- **Update `ats-vocab.yml`** with terms from postings you've read this month. The score sharpens
  as the vocabulary matches your field.
- **Check `no reader for X` counts.** If one ATS keeps appearing, those postings are arriving
  without dates or pay.

---

## When something looks wrong

**No results at all.** Run `ajs config` and confirm the profile loaded and the keyword count
isn't zero. Then `ajs sweep --chunks 2` for a fast check against a slice of the index.

**A location is misclassified.** Add the place to `config/geo-terms.json` — `us_city` for a
domestic city, `foreign` for anywhere else. Add a case to `tests/geo_cases.json` so it stays
fixed. Both language implementations read the same file.

**A posting keeps reappearing.** Employers repost, which resets the date on the board. Check
`repost_signal` and `date_first_seen` in the JSONL; an old `first_seen` with a new `date_posted`
is a repost.

**Dates look stale.** Check your system clock. The pipeline reads the date from the clock at
runtime, never from anywhere else.

**The sweep fails entirely.** The public index is a third-party project. `ajs tracked` and
`ajs remote` still work; you'll see fewer postings until it returns.

**Enrichment says "detail fetch failed".** Usually transient — a board rate-limiting or briefly
down. Re-running the day is cheap because descriptions are cached.

---

## Files

| Path | What it is |
|---|---|
| `output/*.xlsx` | The workbook you read |
| `.work/ranked-*-{date}.jsonl` | Per-source discovery results |
| `.work/enriched-{date}.jsonl` | The merged, enriched, scored run — the file to query |
| `.work/cache/jd/{id}.txt` | Cached job descriptions; re-running a day costs nothing |
| `.work/cache/chunks/` | Cached index chunks (~70 MB), refreshed daily |
| `config/profile.yml` | You. Never committed |
| `private/cv/*` | Your CV masters (.docx, .pdf, .txt, .md). Never committed |

Deleting `.work/` is always safe; it rebuilds.

---

## A realistic cadence

Two to five tailored applications a day beats twenty untailored ones. The scan exists to make
that possible: it removes the hour of searching so the hour of tailoring is the work you do.
