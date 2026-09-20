"""Location classification and ranking (Python twin of src/node/geo.mjs).

Rule (see docs/DECISIONS.md): a location counts as domestic only on POSITIVE evidence.
Anything unrecognised is "check" — it goes to a review sheet, never onto a domestic shortlist.
Both twins read the same ``config/geo-terms.json`` so a new place is added once.
"""
from __future__ import annotations

import io
import json
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote

US_STATE_NAMES = {
    "AL": "alabama", "AK": "alaska", "AZ": "arizona", "AR": "arkansas", "CA": "california",
    "CO": "colorado", "CT": "connecticut", "DE": "delaware", "FL": "florida", "GA": "georgia",
    "HI": "hawaii", "ID": "idaho", "IL": "illinois", "IN": "indiana", "IA": "iowa",
    "KS": "kansas", "KY": "kentucky", "LA": "louisiana", "ME": "maine", "MD": "maryland",
    "MA": "massachusetts", "MI": "michigan", "MN": "minnesota", "MS": "mississippi",
    "MO": "missouri", "MT": "montana", "NE": "nebraska", "NV": "nevada", "NH": "new hampshire",
    "NJ": "new jersey", "NM": "new mexico", "NY": "new york", "NC": "north carolina",
    "ND": "north dakota", "OH": "ohio", "OK": "oklahoma", "OR": "oregon", "PA": "pennsylvania",
    "RI": "rhode island", "SC": "south carolina", "SD": "south dakota", "TN": "tennessee",
    "TX": "texas", "UT": "utah", "VT": "vermont", "VA": "virginia", "WA": "washington",
    "WV": "west virginia", "WI": "wisconsin", "WY": "wyoming", "DC": "district of columbia",
    "PR": "puerto rico",
}

_WORKDAY_URL_LOC = re.compile(r"myworkdayjobs\.com/(?:[a-z]{2}-[A-Z]{2}/)?[^/]+/job/([^/]+)/")


def _words(items: list[str]) -> re.Pattern[str]:
    return re.compile(r"\b(" + "|".join(items) + r")\b", re.I)


@dataclass
class Geo:
    """Classifier built from the shared term lists plus the candidate's home state."""

    strong: re.Pattern[str]
    state_code: re.Pattern[str]
    city: re.Pattern[str]
    foreign: re.Pattern[str]
    foreign_code: re.Pattern[str]
    remote_rx: re.Pattern[str]
    home: re.Pattern[str] | None

    @classmethod
    def from_terms(cls, terms: dict, home_state: str = "", home_state_cities: list[str] | None = None) -> "Geo":
        home = None
        if home_state:
            known = terms.get("state_cities", {}).get(home_state.upper(), [])
            parts = [rf"\b{re.escape(home_state)}\b", US_STATE_NAMES.get(home_state.upper(), "")]
            parts += [*known, *(home_state_cities or [])]
            home = re.compile("|".join(p for p in parts if p), re.I)
        return cls(
            strong=re.compile("|".join(terms["us_strong"]), re.I),
            state_code=re.compile(terms["us_state_code"]),      # case-sensitive on purpose
            city=_words(terms["us_city"]),
            foreign=_words(terms["foreign"]),
            foreign_code=re.compile(terms["foreign_code"]),     # case-sensitive on purpose
            remote_rx=re.compile(terms["remote"], re.I),
            home=home,
        )

    @classmethod
    def from_config(cls, cfg) -> "Geo":
        terms = json.load(io.open(cfg.paths["geo_terms"], encoding="utf-8"))
        loc = (cfg.profile or {}).get("location", {})
        return cls.from_terms(terms, loc.get("home_state", ""), loc.get("home_state_cities", []))

    def is_remote(self, text: str | None) -> bool:
        return bool(self.remote_rx.search(text or ""))

    def is_home_state(self, text: str | None) -> bool:
        return bool(self.home.search(text or "")) if self.home else False

    def domestic(self, loc: str | None) -> str:
        """Return 'yes' (domestic), 'no' (recognised foreign) or 'check' (unrecognised)."""
        s = (loc or "").strip()
        if not s:
            return "check"
        if self.strong.search(s):
            return "yes"
        if self.foreign.search(s) or self.foreign_code.search(s):
            return "no"
        if self.state_code.search(s) or self.city.search(s):
            return "yes"
        return "check"

    def rank(self, locs: list[str], all_text: str | None = None, url: str = "") -> int:
        """Rank a posting: 1 remote · 2 on-site away · 3 home state · 4 foreign · 5 check.

        When the only location is a summary like "3 Locations", fall back to the location
        embedded in a Workday URL before giving up.
        """
        locs = [l for l in (locs or []) if l]
        text = all_text if all_text is not None else "; ".join(locs)
        if locs and all(self.domestic(l) == "check" for l in locs) and url:
            from_url = workday_url_location(url)
            if from_url:
                locs, text = [from_url], f"{text} {from_url}"
        if not locs:
            return 5

        states = [self.domestic(l) for l in locs]
        domestic_locs = [l for l, s in zip(locs, states) if s == "yes"]

        if all(s == "no" for s in states):
            return 4
        if self.is_remote(text):
            if domestic_locs:
                return 1
            if "no" not in states:
                return 5
        if any(not self.is_home_state(l) for l in domestic_locs):
            return 2
        if domestic_locs:
            return 3
        return 5


def workday_url_location(url: str | None) -> str:
    """Workday URLs carry the primary location: .../job/<Location-Slug>/<Title>_<Req>."""
    m = _WORKDAY_URL_LOC.search(url or "")
    if not m:
        return ""
    # "---" is a separator, "-" is an intra-word space: split on the separator first, or a
    # chained replace would also blank out the separator's own hyphen.
    return " - ".join(part.replace("-", " ").strip() for part in unquote(m.group(1)).split("---"))


def load_terms(path: str | Path) -> dict:
    return json.load(io.open(path, encoding="utf-8"))
