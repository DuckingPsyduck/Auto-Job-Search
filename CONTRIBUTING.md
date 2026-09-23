# Contributing

Thanks for looking. This is a small tool with a narrow job: find fresh, well-matched job
postings for one person, and be honest about what it knows. Contributions that make it work for
more people, on more boards, without making it noisier are very welcome.

Read [AGENTS.md](AGENTS.md) first if you are working through an AI agent — it is the operating
guide, and it applies to contributors too.

---

## Three rules that are not negotiable

**1. No personal data in the repository.** Not a name, an email, a phone number, a CV, a home
directory path, or a real `portals.yml`. Personal files live in `config/*.yml` (gitignored),
`private/` and `output/`; only `*.example.yml` is tracked. `node tools/privacy-check.mjs` runs
over git-tracked files in CI and must pass. If you need a realistic example, invent one — see
`fixtures/demo-postings.jsonl`.

**2. No source that doesn't permit it.** Before adding any board, feed or endpoint, check its
`robots.txt` (the `User-agent: *` block — that is the one that applies to us) and its terms of
service, and record what you checked, with a date, in [docs/SOURCES.md](docs/SOURCES.md). An
explicit prohibition on robots or data mining settles it whatever robots.txt says. A CAPTCHA or
a "verify you are human" page is an answer, not an obstacle. We do not authenticate, we do not
impersonate a browser, and we fetch postings, never people.

**3. The tool never invents and never submits.** Nothing may write a claim about a user's
experience that the user did not supply, and nothing may submit an application. Those are the
guarantees the whole thing rests on.

---

## Getting set up

```bash
npm install
python -m pip install -e ".[dev]"
npm run demo
```

`npm run demo` builds a workbook from fixture data — no network, no profile, no setup. If that
works, your environment is fine.

To run against real data you need a profile: `npm run init` walks the setup interview, or
`node bin/ajs.mjs init --answers fixtures/demo-answers.json` fills it from a file.

## Running the checks

```bash
npm test                              # Node tests
python -m pytest tests -q             # Python tests
python -m ruff check .                # Python lint
node tools/privacy-check.mjs          # no personal data in tracked files
```

`npm run check` runs the Node tests and the privacy check together. CI runs all four, on Linux,
macOS and Windows, against Node 20 and 22. Every suite is offline by design: no test may reach
the network. A test that needs a provider's response pins the payload in the test file instead —
that way a provider changing its shape is a visible failure, not a silent field of blanks.

---

## The common contributions

### Adding an ATS provider

`src/node/providers.mjs` holds one reader per platform. A reader takes the provider's payload and
returns `{ date_posted, date_basis, locations, remote_type, text }`. Three things to get right:

- **`date_basis` says where the date came from** ("greenhouse first_published", "bamboohr
  datePosted"). If the platform publishes no date, say so in `date_basis` and leave
  `date_posted` blank. Never substitute a date from somewhere else.
- **Route the URL** in `providerFor()`, and add the host to the routing test.
- **Pin a payload** in `tests/providers.test.mjs`. Real shapes have surprises worth recording —
  Paylocity escapes its description twice, Workday's dates are relative.

Then add a row to the platform table in [docs/SOURCES.md](docs/SOURCES.md).

### Adding a remote feed

Configuration, not code: a new entry under `sources.remote_boards` in
`config/scan-config.example.yml`. Check its terms first and record the check in
[docs/SOURCES.md](docs/SOURCES.md), including in the rejected table if it doesn't work out. That
table exists so nobody re-tests the same dead ends.

### Location terms

`config/geo-terms.json` is shared by both classifiers. The rule is positive evidence: a posting
is domestic because something in it says so, never because nothing said otherwise, and anything
unrecognised is ranked "check" for a human rather than assumed. If you change the terms, add a
case to `tests/geo_cases.json` — both the Node and the Python suite run it, which is what keeps
the two implementations from drifting apart. Real regressions belong there: foreign cities that
once reached a domestic shortlist, and substring traps like Indianapolis containing "india".

### Anything a second user would need a different value for

That is configuration, not a constant. Paths, endpoints, windows, thresholds, lane definitions
and extraction patterns all live in `scan-config.yml`, with the schema and comments in
`config/scan-config.example.yml`. Adding a key means updating the example file, because that is
the documentation.

---

## Style

Match the code around you. Briefly, what that means here:

- Comments explain **why**, not what. If a line looks odd, the comment says what went wrong that
  made it necessary.
- Every posting keeps a `verdict` and a `verdict_reason`. Nothing is dropped silently — a user
  must be able to ask why a job isn't on their list and get an answer.
- Stages read and write JSONL files. It is slower than passing objects around, and it means any
  stage can be re-run alone and any number can be inspected when it looks wrong.
- Two numbers, two meanings: `fit_as_is` is one CV as written, `fit_tailored` is the ceiling
  with everything a user has confirmed. Don't blur them, and don't round them upward.
- Errors say what to do next, not just what failed.

Node code is plain ESM, no build step, one runtime dependency (`js-yaml`). Python is formatted to
`ruff`'s defaults; run it before pushing. Please don't add a dependency without a reason that
survives being said out loud.

## Commits and pull requests

Write the commit subject as what the change does for a user, in the imperative: "Fall back to
reading employer boards when the index is down", not "fix sweep". The body is for why — the
problem, and what was rejected. If a decision will still matter in six months, it belongs in
[docs/DECISIONS.md](docs/DECISIONS.md) with the incident that prompted it.

A pull request should say what it changes, how you verified it, and — if it touches a source —
what you checked and when. Keep it to one thing. Small and boring merges fast.

## Reporting a bug

Open an issue with the command you ran, what you expected, and what happened. **Scrub it first**:
no name, email, employer list or file paths from your machine. A posting URL is fine; your
profile is not. If the bug needs your data to reproduce, say so and describe the shape of it
instead.

Security issues — anything that could expose a user's data — go through GitHub's private
vulnerability reporting rather than a public issue.

## License

By contributing you agree your work is released under the [MIT License](LICENSE), same as the
rest of the project.
