"""Location classifier tests (Python side).

Runs the same fixtures as tests/geo.test.mjs so the Node and Python twins stay in agreement.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from ajs.geo import Geo, workday_url_location

ROOT = Path(__file__).resolve().parents[1]
TERMS = json.loads((ROOT / "config" / "geo-terms.json").read_text(encoding="utf-8"))
FIXTURES = json.loads((ROOT / "tests" / "geo_cases.json").read_text(encoding="utf-8"))
GEO = Geo.from_terms(TERMS, FIXTURES["home_state"])

CASES = FIXTURES["cases"]
URL_CASES = FIXTURES["workday_url_cases"]


@pytest.mark.parametrize("case", [c for c in CASES if c["locs"]], ids=lambda c: c["locs"][0])
def test_domestic_verdict(case):
    assert GEO.domestic(case["locs"][0]) == case["domestic"]


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["locs"][0] if c["locs"] else "(no location)")
def test_rank(case):
    assert GEO.rank(case["locs"]) == case["rank"]


@pytest.mark.parametrize("case", [c for c in CASES if c["domestic"] == "no"], ids=lambda c: c["locs"][0])
def test_foreign_never_domestic(case):
    assert GEO.rank(case["locs"]) == 4


@pytest.mark.parametrize("case", URL_CASES, ids=lambda c: c["location"])
def test_workday_url_location(case):
    assert workday_url_location(case["url"]) == case["location"]


@pytest.mark.parametrize("case", URL_CASES, ids=lambda c: c["location"])
def test_summary_location_falls_back_to_url(case):
    """A listing that only says "2 Locations" resolves through its Workday URL."""
    assert GEO.rank(["2 Locations"], url=case["url"]) == case["rank_from_summary"]


def test_home_state_is_profile_driven():
    ny = Geo.from_terms(TERMS, "NY")
    assert ny.rank(["Poughkeepsie, NY"]) == 3
    assert ny.rank(["US - TX, Houston"]) == 2
