"""Documentation that has to stay true.

Most docs can drift a little. A column reference cannot: docs/WORKBOOK.md is what a user reads
to understand the spreadsheet, so a column added to the builder and not to the page leaves them
with an undocumented column and no way to know what it holds.
"""
from __future__ import annotations

from pathlib import Path

from ajs.workbook import DROPPED_COLUMNS, MAIN_COLUMNS

WORKBOOK_DOC = Path(__file__).resolve().parents[1] / "docs" / "WORKBOOK.md"


def test_every_workbook_column_is_documented():
    page = WORKBOOK_DOC.read_text(encoding="utf-8")
    undocumented = [
        header for header, _, _ in MAIN_COLUMNS + DROPPED_COLUMNS if f"| {header} |" not in page
    ]
    assert not undocumented, f"add these to docs/WORKBOOK.md: {undocumented}"


def test_the_page_documents_no_column_that_does_not_exist():
    # The other direction: a renamed column leaves a stale row behind.
    page = WORKBOOK_DOC.read_text(encoding="utf-8")
    real = {header for header, _, _ in MAIN_COLUMNS + DROPPED_COLUMNS}
    documented = {
        # One row may cover several columns: "Company, Role Title, Location, Posted, URL".
        name.strip()
        for line in page.splitlines()
        if line.startswith("| ") and line.count("|") >= 3
        for name in line.split("|")[1].split(",")
    }
    # Table headers and the prose tables elsewhere on the page are not column rows.
    documented -= {"Column", "---", "What it holds"}
    assert documented <= real, f"not real columns: {sorted(documented - real)}"
