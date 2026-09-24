"""Keyword tuning tests.

Keywords decide what the scan can see, so the two failure modes that matter are a keyword that
quietly matches nothing and a whole vocabulary the user never thought to search for.
"""
from __future__ import annotations

from ajs.keywords import keyword_hits, suggestions


def _tally(pairs):
    return [{"title": title, "count": count} for title, count in pairs]


def test_hits_are_counted_per_keyword():
    rows = [
        {"title": "Senior Data Engineer"},
        {"title": "Data Engineer II"},
        {"title": "Systems Administrator"},
    ]
    hits = keyword_hits(rows, ["data engineer", "systems administrator", "database engineer"])
    assert hits == {"data engineer": 2, "systems administrator": 1, "database engineer": 0}


def test_a_keyword_matching_nothing_is_still_listed():
    # The zero is the whole point: a dead keyword is invisible in the results it fails to find.
    assert keyword_hits([{"title": "Cook"}], ["charge nurse"]) == {"charge nurse": 0}


def test_partial_words_do_not_count():
    assert keyword_hits([{"title": "Data Engineering Manager"}], ["data engineer"]) == {"data engineer": 0}


def test_suggestions_surface_the_neighbouring_title():
    tally = _tally([("Analytics Engineer", 40), ("Data Engineer", 30), ("Forklift Operator", 900)])
    proposed = dict(suggestions(tally, ["data engineer"]))
    assert "analytics engineer" in proposed
    assert "data engineer" not in proposed, "already searched for, so not a suggestion"
    assert "forklift operator" not in proposed, "shares no word with anything the user searches"


def test_a_distinctive_shared_word_beats_a_generic_one():
    # "nurse manager" shares "manager" with half a job board; the useful overlap is "nurse".
    tally = _tally([
        ("Project Manager", 500), ("Account Manager", 480), ("Product Manager", 460),
        ("Branch Manager", 440), ("Operations Manager", 420),
        ("Nurse Practitioner", 60), ("Practical Nurse", 55),
    ])
    proposed = [phrase for phrase, _ in suggestions(tally, ["nurse manager"], limit=3)]
    assert "nurse practitioner" in proposed
    assert "practical nurse" in proposed


def test_rare_titles_stay_below_the_noise_floor():
    assert suggestions(_tally([("Analytics Engineer", 1)]), ["data engineer"]) == []


def test_suggestions_read_in_frequency_order():
    tally = _tally([("Analytics Engineer", 9), ("Platform Engineer", 40), ("Cloud Engineer", 20)])
    counts = [n for _, n in suggestions(tally, ["data engineer"])]
    assert counts == sorted(counts, reverse=True)


def test_no_keywords_means_no_suggestions():
    assert suggestions(_tally([("Data Engineer", 50)]), []) == []
