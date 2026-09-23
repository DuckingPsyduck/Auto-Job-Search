"""Excel reporting.

Turns an enriched JSONL run into the workbook a person actually reads. Five sheets:

    Shortlist       postings that passed every gate, best location rank first
    Check location  postings whose location could not be verified — a human decides
    Dropped         everything a keyword touched but a gate rejected, with the reason
    All (today)     the full picture for one day, when someone wants to scroll
    Method          what ran, with what settings, and the caveats that matter

The dropped sheet is not a courtesy: a filter that quietly eats good postings is invisible
without it. See docs/DECISIONS.md.
"""
from __future__ import annotations

import json
from collections.abc import Iterable
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

FONT = "Arial"
INK = "1F2937"
HEAD = "12626B"
BAND = "F2F5F6"

#: Location rank -> (fill, text) so the eye can sort ranks without reading them.
RANK_STYLE = {
    1: ("DCEBEC", "0E5058"),
    2: ("E4EEF7", "1F4E79"),
    3: ("FBF0D8", "8A6410"),
    4: ("F1E3DF", "8C4A3F"),
    5: ("EEEEEE", "555555"),
}
TAG_STYLE = {
    "new": ("DCEBEC", "0E5058"),
    "tracked": ("E5E7EB", "374151"),
    "senior+": ("FBF0D8", "8A6410"),
    "yes": ("F1E3DF", "8C4A3F"),
    "apply": ("DCEBEC", "0E5058"),
    "maybe": ("FBF0D8", "8A6410"),
    "skip": ("F1E3DF", "8C4A3F"),
}

#: (header, width, record key). Keys missing from a record render blank.
MAIN_COLUMNS = [
    ("Call", 8, "call"),
    ("Fit % (as-is)", 12, "fit_as_is"),
    ("Fit % (tailored)", 14, "fit_tailored"),
    ("Location Rank", 15, "_rank_label"),
    ("Posted", 11, "date_posted"),
    ("Lane", 26, "_lane_label"),
    ("Company", 22, "company"),
    ("Role Title", 50, "title"),
    ("Location", 34, "_locations"),
    ("Clearance", 26, "clearance"),
    ("Pay (posted)", 22, "pay_text"),
    ("Seniority", 10, "seniority"),
    ("Employer", 12, "employer_coverage"),
    ("Applied Before", 13, "_applied"),
    ("ATS", 12, "ats"),
    ("Best CV", 24, "fit_best_cv"),
    ("Missing Terms", 44, "fit_missing"),
    ("Note", 28, "_note"),
    ("URL", 62, "url"),
]
DROPPED_COLUMNS = [
    ("Drop Reason", 52, "verdict_reason"),
    ("Lane", 26, "_lane_label"),
    ("Company", 22, "company"),
    ("Role Title", 50, "title"),
    ("Location", 34, "_locations"),
    ("Posted", 11, "date_posted"),
    ("URL", 62, "url"),
]


def read_jsonl(path: str | Path) -> list[dict]:
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def _decorate(row: dict, cfg) -> dict:
    """Add display-only fields. The stored record keeps raw values."""
    labels = cfg.get("location.ranks", {}) or {}
    lanes = cfg.get("lanes.labels", {}) or {}
    row["_rank_label"] = labels.get(row.get("location_rank"), row.get("location_rank", ""))
    row["_lane_label"] = lanes.get(row.get("lane"), row.get("lane", ""))
    row["_locations"] = "; ".join(row.get("locations") or [])
    row["_applied"] = "Yes" if row.get("applied_before") else ""
    notes = [row.get("note", ""), row.get("repost_signal", ""), row.get("enrich_status", "")]
    row["_note"] = " · ".join(n for n in notes if n and n != "ok")
    return row


def _sheet(ws, rows: Iterable[dict], columns: list[tuple[str, int, str]]) -> None:
    head_font = Font(name=FONT, size=10, bold=True, color="FFFFFF")
    head_fill = PatternFill("solid", fgColor=HEAD)
    body_font = Font(name=FONT, size=10, color=INK)
    link_font = Font(name=FONT, size=9, color=HEAD, underline="single")
    band = PatternFill("solid", fgColor=BAND)
    top = Alignment(vertical="top")

    for col, (header, width, _) in enumerate(columns, 1):
        cell = ws.cell(row=1, column=col, value=header)
        cell.font, cell.fill = head_font, head_fill
        ws.column_dimensions[get_column_letter(col)].width = width

    for i, row in enumerate(rows, start=2):
        for col, (_, _, key) in enumerate(columns, 1):
            value = row.get(key, "")
            cell = ws.cell(row=i, column=col, value=value if value is not None else "")
            cell.font, cell.alignment = body_font, top
            if i % 2:
                cell.fill = band
            if key == "url" and value:
                cell.hyperlink = value
                cell.font = link_font
            elif key == "_rank_label":
                bg, fg = RANK_STYLE.get(row.get("location_rank"), (None, None))
                if bg:
                    cell.fill = PatternFill("solid", fgColor=bg)
                    cell.font = Font(name=FONT, size=10, bold=True, color=fg)
            elif (key in ("employer_coverage", "seniority", "_applied", "call")
                    and str(value).lower() in TAG_STYLE):
                bg, fg = TAG_STYLE[str(value).lower()]
                cell.fill = PatternFill("solid", fgColor=bg)
                cell.font = Font(name=FONT, size=10, bold=True, color=fg)

    ws.freeze_panes = "C2"
    last_column = get_column_letter(len(columns))
    ws.auto_filter.ref = f"A1:{last_column}{max(ws.max_row, 2)}"


def _method_sheet(ws, meta: dict) -> None:
    ws.column_dimensions["A"].width = 26
    ws.column_dimensions["B"].width = 112
    title = ws.cell(row=1, column=1, value=f"Run summary — {meta.get('date', '')}")
    title.font = Font(name=FONT, size=13, bold=True, color=HEAD)
    for i, (label, text) in enumerate(meta.get("notes", []), start=3):
        key = ws.cell(row=i, column=1, value=label)
        key.font = Font(name=FONT, size=10, bold=True, color=HEAD)
        key.alignment = Alignment(vertical="top")
        val = ws.cell(row=i, column=2, value=text)
        val.font = Font(name=FONT, size=10, color=INK)
        val.alignment = Alignment(vertical="top", wrap_text=True)
        ws.row_dimensions[i].height = max(15, 13 * (len(str(text)) // 100 + 1))


def build_workbook(cfg, rows: list[dict], out_path: str | Path, meta: dict | None = None) -> Path:
    """Write the workbook for one run and return the path."""
    rows = [_decorate(dict(r), cfg) for r in rows]
    touched = [r for r in rows if r.get("verdict")]

    call_order = {"apply": 0, "maybe": 1, "skip": 2, "": 3}
    shortlist = sorted(
        (r for r in touched if r["verdict"] == "shortlist"),
        key=lambda r: (
            call_order.get(r.get("call", ""), 3),
            -(r.get("fit_tailored") or 0),
            r.get("location_rank", 9),
            r.get("company", ""),
        ),
    )
    check = sorted(
        (r for r in touched if r["verdict"] == "check"),
        key=lambda r: (r.get("lane", ""), r.get("company", "")),
    )
    dropped = sorted(
        (r for r in touched if r["verdict"] == "dropped"),
        key=lambda r: (r.get("verdict_reason", ""), r.get("company", "")),
    )

    wb = Workbook()
    ws = wb.active
    ws.title = "Shortlist"
    _sheet(ws, shortlist, MAIN_COLUMNS)
    _sheet(wb.create_sheet("Check location"), check, MAIN_COLUMNS)
    _sheet(wb.create_sheet("Dropped"), dropped, DROPPED_COLUMNS)

    meta = dict(meta or {})
    meta.setdefault("date", "")
    meta.setdefault("notes", [])
    meta["notes"] = [
        ("Counts",
         f"shortlist {len(shortlist)} · check location {len(check)} · dropped {len(dropped)}"),
        *meta["notes"],
        (
            "Posted date",
            "Taken from the employer's own ATS record during enrichment; the column is blank when that "
            "record could not be read. Discovery uses a public index whose 'first seen' date lags the "
            "employer's, so it is never reported as the posted date.",
        ),
        (
            "Check location",
            "Postings whose location could not be verified as domestic — a summary like '2 Locations', a "
            "bare 'Remote', or a place the term list does not know. They are never assumed domestic and "
            "never silently dropped.",
        ),
        (
            "Clearance",
            "Read from the posting text. 'active required' means a clearance on day one; 'obtainable' means "
            "the employer will sponsor; 'not stated' means the posting says nothing.",
        ),
        (
            "Dropped",
            "Every posting a target keyword matched but a gate rejected, with the reason. Titles "
            "that matched "
            "no keyword are counted, not listed.",
        ),
    ]
    _method_sheet(wb.create_sheet("Method"), meta)

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(out)
    return out
