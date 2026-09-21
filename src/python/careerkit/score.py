"""ATS keyword scoring and the apply/maybe/skip call.

What this measures, and what it does not:

    It measures keyword overlap — the share of a posting's recognised terms that also appear in
    the candidate's CV. Real applicant-tracking systems rank applications against each other,
    per posting, using filters a recruiter configures. No external tool can see that ranking.
    So a score here is an estimate of how well a CV *reads* against one posting, useful for
    deciding where tailoring pays off, and not a prediction of being shortlisted.

Two numbers are produced:

    as_is     the best single CV master, unedited — what happens if they apply right now
    tailored  every CV master plus facilitator-confirmed facts — the ceiling tailoring can
              reach without inventing anything

The gap between them is the value of tailoring; the terms missing from both are the honest
limits, and belong in the "not added — no basis" line of any tailoring reply.
"""
from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

import yaml

from .cvread import read_cv_dir


def load_vocab(path: str | Path) -> dict[str, re.Pattern[str]]:
    """Compile the shared term vocabulary. Keys are display names, values are patterns."""
    raw = (yaml.safe_load(io.open(path, encoding="utf-8")) or {}).get("terms", {})
    return {term: re.compile(pattern, re.I) for term, pattern in raw.items()}


def terms_in(text: str, vocab: dict[str, re.Pattern[str]]) -> set[str]:
    """Which vocabulary terms a piece of text uses."""
    return {term for term, rx in vocab.items() if rx.search(text or "")}


def confirmed_text(profile: dict | None) -> str:
    """Facts the facilitator confirmed that are not yet written into a CV.

    These count towards the tailored ceiling because the candidate can honestly add them; they
    never count towards the as-is score, which reflects the document as it stands today.
    """
    if not profile:
        return ""
    parts: list[str] = []
    for entry in profile.get("confirmed_facts") or []:
        if isinstance(entry, dict):
            parts.append(str(entry.get("fact", "")))
            parts.extend(str(s) for s in entry.get("supports", []) or [])
        else:
            parts.append(str(entry))
    return " ".join(parts)


@dataclass
class Score:
    """One posting scored against one candidate."""

    as_is: int
    tailored: int
    best_cv: str
    terms: int
    hits: list[str]
    missing: list[str]
    gained_by_tailoring: list[str]
    thin: bool
    call: str
    call_reason: str

    def as_dict(self) -> dict:
        return {
            "fit_as_is": self.as_is,
            "fit_tailored": self.tailored,
            "fit_best_cv": self.best_cv,
            "fit_terms": self.terms,
            "fit_missing": ", ".join(self.missing),
            "fit_gained": ", ".join(self.gained_by_tailoring),
            "fit_thin": self.thin,
            "call": self.call,
            "call_reason": self.call_reason,
        }


@dataclass
class Scorer:
    """Holds the candidate's documents so many postings can be scored in one pass."""

    vocab: dict[str, re.Pattern[str]]
    cv_terms: dict[str, set[str]]
    union_terms: set[str]
    min_terms: int = 10
    apply_at: int = 75
    maybe_at: int = 65

    @classmethod
    def from_config(cls, cfg) -> "Scorer":
        vocab = load_vocab(cfg.paths["ats_vocab"])
        cvs = read_cv_dir(cfg.paths["cv_dir"]) if Path(cfg.paths["cv_dir"]).is_dir() else {}
        cv_terms = {name: terms_in(text, vocab) for name, text in cvs.items()}
        union = set().union(*cv_terms.values()) if cv_terms else set()
        union |= terms_in(confirmed_text(cfg.profile), vocab)
        scoring = cfg.get("scoring", {}) or {}
        rule = scoring.get("apply_rule", {}) or {}
        return cls(
            vocab=vocab,
            cv_terms=cv_terms,
            union_terms=union,
            min_terms=int(scoring.get("min_terms_for_reliable_score", 10)),
            apply_at=int(rule.get("apply_at", 75)),
            maybe_at=int(rule.get("maybe_at", 65)),
        )

    @classmethod
    def from_texts(cls, vocab_path: str | Path, cv_texts: dict[str, str], confirmed: str = "", **kw) -> "Scorer":
        """Build from raw text instead of a config — used by tests and by one-off scoring."""
        vocab = load_vocab(vocab_path)
        cv_terms = {name: terms_in(text, vocab) for name, text in cv_texts.items()}
        union = set().union(*cv_terms.values()) if cv_terms else set()
        union |= terms_in(confirmed, vocab)
        return cls(vocab=vocab, cv_terms=cv_terms, union_terms=union, **kw)

    @property
    def ready(self) -> bool:
        return bool(self.cv_terms)

    def score(self, jd_text: str, required_missing: Iterable[str] = ()) -> Score:
        """Score one job description.

        `required_missing` lets a caller name terms the posting treats as required that the
        candidate lacks; any of them forces a skip regardless of the percentage, because a
        missing core tool is a pass/fail screen, not a few lost points.
        """
        jd_terms = terms_in(jd_text, self.vocab)
        total = len(jd_terms)
        if not total:
            return Score(0, 0, "", 0, [], [], [], True, "skip", "no recognisable terms in the posting")

        best_cv, best_hits = "", set()
        for name, terms in self.cv_terms.items():
            hits = jd_terms & terms
            if len(hits) > len(best_hits):
                best_cv, best_hits = name, hits

        tailored_hits = jd_terms & self.union_terms
        as_is = round(100 * len(best_hits) / total)
        tailored = round(100 * len(tailored_hits) / total)
        missing = sorted(jd_terms - self.union_terms)
        thin = total < self.min_terms

        call, reason = self._call(tailored, thin, missing, list(required_missing))
        return Score(
            as_is=as_is,
            tailored=tailored,
            best_cv=best_cv,
            terms=total,
            hits=sorted(tailored_hits),
            missing=missing,
            gained_by_tailoring=sorted(tailored_hits - best_hits),
            thin=thin,
            call=call,
            call_reason=reason,
        )

    def _call(self, tailored: int, thin: bool, missing: list[str], required_missing: list[str]) -> tuple[str, str]:
        if required_missing:
            return "skip", f"required and missing: {', '.join(required_missing)}"
        if thin:
            return "maybe", "too few recognisable terms to score reliably — read the posting"
        if tailored >= self.apply_at:
            return "apply", f"{tailored}% after tailoring"
        if tailored >= self.maybe_at:
            return "maybe", f"{tailored}% after tailoring — worth it with a small pool or a referral"
        gap = ", ".join(missing[:4]) or "not enough overlap"
        return "skip", f"{tailored}% after tailoring; missing {gap}"
