"""Scorer tests.

Synthetic CVs and postings only — no candidate documents are needed to run the suite, and the
thresholds are exercised directly so a change to them is a visible test failure.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from careerkit.score import Scorer, confirmed_text, terms_in, load_vocab

ROOT = Path(__file__).resolve().parents[1]
VOCAB_PATH = ROOT / "config" / "ats-vocab.yml"

DATA_CV = """
Data engineer with seven years building pipelines in Python and SQL.
PostgreSQL, MongoDB, ETL/ELT pipelines, data modeling, AWS, Docker, Linux administration, Git.
Monitoring and troubleshooting production incidents; root cause analysis.
"""
SYSADMIN_CV = """
Systems administrator across Windows Server and Linux.
PowerShell and Bash scripting, VMware, Active Directory, networking, firewall configuration.
Troubleshooting, incident response, documentation and runbooks.
"""
DATA_POSTING = """
We are hiring a Data Engineer. You will build ETL pipelines in Python and SQL against
PostgreSQL and MongoDB, deploy with Docker on AWS, and monitor production data flows on Linux.
Experience with Git, REST APIs, JSON, Bash scripting and data modeling is required. You will
own troubleshooting and root cause analysis for pipeline incidents, keep documentation current,
and work in an Agile team.
"""
WINDOWS_POSTING = """
Systems Administrator wanted. Windows Server administration, Active Directory, VMware,
networking and firewall work, PowerShell scripting, hardware installation, desktop support.
"""
UNRELATED_POSTING = """
Registered nurse for our clinical team. Patient care, nursing documentation and HIPAA
compliance in a hospital setting. You will chart in our EHR, coordinate with pharmacy, answer
phone triage calls, handle scheduling and data entry, provide customer service to families,
escalate urgent cases, and use Microsoft Office including Excel for census reporting.
"""
THIN_POSTING = "Exciting opportunity for a motivated self-starter to join a growing team. Python."


@pytest.fixture(scope="module")
def scorer() -> Scorer:
    return Scorer.from_texts(VOCAB_PATH, {"data.docx": DATA_CV, "sysadmin.docx": SYSADMIN_CV})


def test_picks_the_best_cv_for_the_posting(scorer):
    assert scorer.score(DATA_POSTING).best_cv == "data.docx"
    assert scorer.score(WINDOWS_POSTING).best_cv == "sysadmin.docx"


def test_strong_match_says_apply(scorer):
    result = scorer.score(DATA_POSTING)
    assert result.call == "apply"
    assert result.tailored >= 75
    assert "Python" in result.hits
    # The single best CV scores lower than the union of all masters: terms this posting wants
    # (documentation, incident handling) live in the sysadmin CV. That gap is exactly what
    # tailoring closes, so the two numbers must not collapse into one.
    assert result.as_is < result.tailored


def test_unrelated_posting_says_skip(scorer):
    result = scorer.score(UNRELATED_POSTING)
    assert result.call == "skip"
    assert result.tailored < 65
    assert "pharmacy/clinical" in result.missing


def test_thin_posting_is_flagged_rather_than_scored(scorer):
    result = scorer.score(THIN_POSTING)
    assert result.thin is True
    assert result.call == "maybe"
    assert "read the posting" in result.call_reason


def test_missing_required_tool_overrides_a_high_score(scorer):
    result = scorer.score(DATA_POSTING, required_missing=["Snowflake"])
    assert result.call == "skip"
    assert "Snowflake" in result.call_reason


def test_confirmed_facts_raise_the_tailored_ceiling_only():
    plain = Scorer.from_texts(VOCAB_PATH, {"data.docx": DATA_CV})
    with_facts = Scorer.from_texts(
        VOCAB_PATH,
        {"data.docx": DATA_CV},
        confirmed="Uses Kubernetes and Terraform daily",
    )
    posting = DATA_POSTING + "\nKubernetes and Terraform experience required."
    before, after = plain.score(posting), with_facts.score(posting)
    assert after.tailored > before.tailored, "confirmed facts should lift the ceiling"
    assert after.as_is == before.as_is, "the unedited CV score must not move"
    assert set(after.gained_by_tailoring) >= {"Kubernetes", "Terraform"}


def test_confirmed_facts_are_read_from_a_profile():
    profile = {"confirmed_facts": [{"fact": "Uses Claude Code daily", "supports": ["AI coding tools"]}]}
    text = confirmed_text(profile)
    assert "Claude Code" in text and "AI coding tools" in text


def test_a_posting_with_no_recognisable_terms_scores_zero(scorer):
    result = scorer.score("...")
    assert result.terms == 0
    assert result.call == "skip"


def test_vocabulary_terms_are_detected_in_text():
    vocab = load_vocab(VOCAB_PATH)
    found = terms_in("We use PostgreSQL and Terraform on AWS.", vocab)
    assert {"PostgreSQL", "Terraform", "AWS"} <= found
