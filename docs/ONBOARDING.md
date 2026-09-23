# Onboarding

Getting from a fresh clone to a shortlist you trust. Budget thirty minutes for setup, then a
week of tuning.

`ajs init` asks most of this interactively. This document explains what each answer does, so you
can give good ones — and it doubles as an interview script if you're setting the tool up for
someone else.

---

## See it first

Before setting anything up:

```bash
ajs demo
```

That builds a workbook from fifteen invented postings — no configuration, no network, no data of
yours. It is the fastest way to see what the tool produces and decide whether the rest is worth
thirty minutes.

---

## Before you start

**Gather your CV files.** Put every `.docx` master in `private/cv/`. If you keep one CV, that's
fine; if you keep several for different kinds of role, better — the scorer picks the best fit per
posting and uses the union of all of them as the tailoring ceiling.

**Know your constraints.** The three that decide most outcomes: where you will physically work,
the least money you'd accept, and whether you hold or can obtain a security clearance.

---

## The questions, and why they matter

### Identity

Name, email, phone, LinkedIn, GitHub. Used only to fill application answers; never sent anywhere
by the tool.

### Work authorization and clearance

- **Citizenship / work authorization** sets which country counts as domestic in location ranking.
- **Clearance**: `active`, `inactive` or `none`, plus the highest level ever held.

This one matters more than people expect in defense and government work. A role demanding an
*active* clearance on day one is closed to someone without one, however good the fit. A role that
says "ability to obtain" is open, and a lapsed clearance is a genuine advantage — the
investigation has been passed once before.

### Location

- **Home state or region.** If you're relocating away, on-site work there ranks last.
- **Preferred cities.** Named first in answers to "where would you work?"
- **Excluded cities.** Never suggested. Left unmentioned in answers rather than listed as
  refusals — saying "not Kentucky" reads as inflexible; naming where you *want* to be reads as
  motivated.
- **Remote.** Whether remote roles rank first.

### Pay floor

A posting whose stated maximum falls below your floor is dropped. Two cautions: set it from the
market rather than your current salary, and remember many postings state no range at all, so
those are never dropped on pay.

### Target roles and keywords

**This is the most important answer.** Keywords decide what the scan sees; everything downstream
only filters what they found.

Give two or three target roles, and for each the title phrases employers actually use. Not your
self-description — the words in job titles:

```yaml
- name: "Data Engineer (mid)"
  keywords: ["data engineer", "analytics engineer", "database engineer", "data platform"]
- name: "Systems Administrator / SRE"
  keywords: ["systems administrator", "system administrator", "site reliability", "devops engineer"]
```

`init` reads your CVs and proposes both the roles and the keywords. Accept what fits, edit the
rest.

**Too narrow** and you see five postings a day. **Too broad** and the shortlist fills with jobs
you'd never take. Adjust after the first few runs — the Dropped sheet tells you which way.

---

## Scripted setup

If you already know the answers — you're setting this up for someone else, or re-creating a
configuration — skip the prompts:

```bash
ajs init --answers answers.json
```

`fixtures/demo-answers.json` is a working example: one key per question, and an `archetypes` list
of `{name, keywords, cv}`. Anything you leave out falls back to the same default the prompt
would have offered.

## First run

```bash
ajs daily
```

Roughly a minute. Then open the workbook in `output/`.

**What a healthy first run looks like:** somewhere between 20 and 150 shortlist rows, a handful
in Check location, and a Dropped sheet dominated by "title outside target keywords".

**If you got almost nothing,** keywords are too narrow or your pay floor is too high. Run
`ajs config` to confirm the profile loaded and the keyword count isn't zero.

**If everything looks irrelevant,** keywords are too broad, or the lanes need adjusting for your
field.

---

## The first week

**Day 1–2 — tune keywords.** Run daily, read the Dropped sheet, add the variants you're missing
and exclude the ones you keep rejecting. This is the only setting worth iterating on early.

**Day 3 — add employers.** Put 10–30 companies you'd genuinely join into `config/portals.yml`.
The tracked scan reads their boards directly, so you see their postings with exact dates, and
you catch employers the public index misses.

**Day 4 — tailor one application end to end.** Follow the method in
[AGENTS.md §6](../AGENTS.md#6-tailoring-a-cv-for-one-posting). Notice how long it takes; that's
your real daily capacity.

**Day 5 — extend the vocabulary.** Add terms from the postings you've read to
`config/ats-vocab.yml`. The fit scores sharpen as the vocabulary matches your field.

**Through the week — record confirmed facts.** Every time you notice something true that your CV
doesn't say, add it to `confirmed_facts` in `config/profile.yml`, with what it supports and what
remains unverified. This is how the tailored ceiling rises honestly over time.

---

## Setting this up for someone else

If you're a recruiter, coach or friend running this for a candidate, the interview is the same,
with three additions:

1. **Ask them to talk you through their CV.** The keywords you get from a conversation beat the
   ones you get from a form.
2. **Write down what they tell you that isn't in the CV** — tools used, systems run, scope
   managed — into `confirmed_facts` with its limits. "Uses Kubernetes" is a fact; "runs
   production Kubernetes at scale" is a different claim and needs its own confirmation.
3. **Agree who clicks submit.** It should be them. The tool prepares; the candidate applies.

---

## What good looks like after two weeks

- Twenty to sixty shortlist rows a day, most of which you'd consider.
- Under ten rows a day in Check location.
- Tailoring two to five applications a day rather than searching for them.
- A `confirmed_facts` list that's grown, and CV masters that have absorbed the best phrasings.

If you're not there, it's almost always keywords. Go back to the Dropped sheet.
