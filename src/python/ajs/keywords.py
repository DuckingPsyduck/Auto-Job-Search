"""Keyword tuning: which of the user's keywords are working, and what they are missing.

Keywords decide what the scan can see, and they are the one part of the configuration a user
is expected to get wrong at first. A search for "data engineer" that has never heard of
"analytics engineer" does not look broken — it just looks like a quiet day. This turns a day's
run into the two facts that fix that:

    which configured keywords actually matched a posting today
    which titles the scan threw away that look like the user's kind of work

The second half reads `.work/unmatched-titles-{date}.json`, the tally the sweep keeps of
everything its keywords did not touch.
"""
from __future__ import annotations

import json
import math
import re
from collections import Counter
from pathlib import Path

from .cvread import TITLE_TERMS, titles_in

#: A suggested title needs to be this common before it is worth a user's attention.
MIN_SUGGESTION_COUNT = 3


def configured_keywords(cfg) -> list[str]:
    """Every title keyword in the profile, in configuration order, de-duplicated."""
    seen: dict[str, None] = {}
    for archetype in (cfg.profile or {}).get("targets", {}).get("archetypes", []):
        for keyword in archetype.get("keywords", []):
            clean = str(keyword).strip().lower()
            if clean:
                seen.setdefault(clean, None)
    return list(seen)


def _matcher(keyword: str) -> re.Pattern[str]:
    return re.compile(rf"\b{re.escape(keyword)}\b", re.I)


def keyword_hits(rows: list[dict], keywords: list[str]) -> dict[str, int]:
    """How many of today's kept postings each keyword matched."""
    matchers = {kw: _matcher(kw) for kw in keywords}
    hits = dict.fromkeys(keywords, 0)
    for row in rows:
        title = row.get("title") or ""
        for keyword, matcher in matchers.items():
            if matcher.search(title):
                hits[keyword] += 1
    return hits


def _words(phrase: str) -> set[str]:
    return {w for w in re.split(r"[^a-z0-9]+", phrase.lower()) if len(w) > 2}


def suggestions(
    unmatched: list[dict], keywords: list[str], limit: int = 12, terms_path=TITLE_TERMS
) -> list[tuple[str, int]]:
    """
    Title phrases worth adding, closest to the user's own keywords first.

    Two filters, both load-bearing. Phrases already covered by a keyword are left out: they are
    not missing, they are the negative filters doing their job. And a phrase must share a word
    with something the user already searches for — on a board of 1.4M postings the raw
    frequency list is "forklift operator" and "retail sales representative", which is true and
    useless. Sharing a word is what makes "analytics engineer" surface for someone searching
    "data engineer".
    """
    covered = [_matcher(kw) for kw in keywords]
    keyword_words = set().union(*(_words(kw) for kw in keywords)) if keywords else set()
    counts: Counter[str] = Counter()
    document_frequency: Counter[str] = Counter()
    for entry in unmatched:
        title = entry.get("title", "")
        weight = int(entry.get("count", 1))
        document_frequency.update(_words(title))
        if any(matcher.search(title) for matcher in covered):
            continue
        for phrase in set(titles_in(title, terms_path)):
            if any(matcher.search(phrase) for matcher in covered):
                continue
            if _words(phrase) & keyword_words:
                counts[phrase] += weight

    # Not every shared word is worth the same. Someone searching "nurse manager" shares
    # "manager" with every project, account and branch manager on the board; "nurse" is the
    # word that means something. Rank by the rarest word a phrase shares, so the distinctive
    # overlap wins over the generic one.
    total = max(len(unmatched), 1)

    def distinctiveness(phrase: str) -> float:
        shared = _words(phrase) & keyword_words
        return max((total / (1 + document_frequency[w]) for w in shared), default=0.0)

    # Frequency counts, but sub-linearly: a title seen 500 times is not ten times more worth
    # suggesting than one seen 50 times, and without the dampening the generic managers drown
    # out the specific nurses.
    ranked = sorted(
        ((phrase, n) for phrase, n in counts.items() if n >= MIN_SUGGESTION_COUNT),
        key=lambda kv: (-(math.log1p(kv[1]) * distinctiveness(kv[0])), -kv[1], kv[0]),
    )
    # Chosen by relevance, then shown by frequency: a list that jumps around in count reads as
    # unsorted, whichever order it was actually picked in.
    return sorted(ranked[:limit], key=lambda kv: (-kv[1], kv[0]))


def load_day(cfg, date: str) -> tuple[list[dict], list[dict], Path | None]:
    """(kept rows, unmatched title tally, which file the tally came from) for one run date."""
    rows: list[dict] = []
    for name in (f"enriched-{date}.jsonl", f"ranked-sweep-{date}.jsonl",
                 f"ranked-tracked-{date}.jsonl", f"ranked-remote-{date}.jsonl"):
        path = cfg.work_path(name)
        if not path.exists():
            continue
        with open(path, encoding="utf-8") as fh:
            rows.extend(json.loads(line) for line in fh if line.strip())
        if name.startswith("enriched"):
            break  # enrichment supersedes the ranked sweep it was built from

    tally_path = cfg.work_path(f"unmatched-titles-{date}.json")
    unmatched: list[dict] = []
    if tally_path.exists():
        unmatched = json.loads(tally_path.read_text(encoding="utf-8")).get("top", [])
    return rows, unmatched, tally_path if tally_path.exists() else None


def report(cfg, date: str) -> str:
    """The keyword report as text, ready to print."""
    keywords = configured_keywords(cfg)
    if not keywords:
        return "no keywords configured: add them to profile.targets[].keywords, or run `ajs init`."

    rows, unmatched, tally_path = load_day(cfg, date)
    if not rows and not unmatched:
        return f"no run data for {date}. Run `ajs daily` first."

    kept = [r for r in rows if r.get("verdict") != "dropped"]
    hits = keyword_hits(kept, keywords)
    width = max(len(k) for k in keywords)

    lines = [f"Keywords for {date} — {len(kept):,} postings kept from {len(rows):,} scanned", ""]
    for keyword, count in sorted(hits.items(), key=lambda kv: (-kv[1], kv[0])):
        mark = "  " if count else "0 "
        lines.append(f"  {mark}{keyword.ljust(width)}  {count:>5}")
    dead = [k for k, n in hits.items() if not n]
    if dead:
        lines += ["", f"  {len(dead)} keyword(s) matched nothing today. One quiet day is not a verdict;",
                  "  a week of zeros means the phrase is not what employers call the job."]

    proposals = suggestions(unmatched, keywords)
    lines += ["", "Titles the scan threw away that look like your work:"]
    if not proposals:
        lines.append("  (nothing above the noise floor — your keywords are catching this field)")
    elif tally_path is None:
        lines.append("  (no tally for this date; it is written by `ajs sweep`)")
    else:
        pad = max(len(p) for p, _ in proposals)
        for phrase, count in proposals:
            lines.append(f"    {phrase.ljust(pad)}  {count:>5}")
        lines += ["", "  Add the ones that are your work to profile.targets[].keywords.",
                  "  They are titles other people hold, not claims about your experience."]
    return "\n".join(lines)
