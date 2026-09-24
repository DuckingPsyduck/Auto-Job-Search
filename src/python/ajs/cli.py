"""Python side of the command line: reporting and scoring.

The Node CLI (`ajs`) shells out to these commands, so a user only learns one entry point.
Run directly when debugging:

    python -m ajs.cli report --date 2026-09-21
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .config import ConfigError, load_config, today
from .workbook import build_workbook, read_jsonl


def _report(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    date = args.date or today()
    source = Path(args.input) if args.input else cfg.work_path(f"enriched-{date}.jsonl")
    if not source.exists():
        fallback = cfg.work_path(f"ranked-sweep-{date}.jsonl")
        if not fallback.exists():
            print(f"no run data for {date}: expected {source}", file=sys.stderr)
            return 1
        print(f"note: {source.name} not found, reporting the un-enriched run", file=sys.stderr)
        source = fallback

    rows = read_jsonl(source)
    out = cfg.output_path(args.kind, date)
    meta = {
        "date": date,
        "notes": [
            ("Source", f"{source.name} ({len(rows):,} rows)"),
            ("Discovery window", f"{cfg.get('windows.full_sweep_days')} day(s) before {date}"),
            ("Keywords", ", ".join(
                kw for a in (cfg.profile or {}).get("targets", {}).get("archetypes", [])
                for kw in a.get("keywords", [])
            ) or "(none configured)"),
            ("Location ranking", (cfg.profile or {}).get("location", {}).get("ranking_note", "").strip()),
            ("Pay floor", str((cfg.profile or {}).get("compensation", {}).get("base_floor", 0) or "not set")),
        ],
    }
    path = build_workbook(cfg, rows, out, meta)
    print(path)
    return 0


def _suggest(args: argparse.Namespace) -> int:
    """Propose keywords from a folder of CV documents. Onboarding calls this; output is JSON."""
    import json

    from .cvread import summarize

    vocab = args.vocab
    if not vocab:
        try:
            vocab = load_config(args.config).paths["ats_vocab"]
        except ConfigError:
            vocab = str(Path(__file__).resolve().parents[3] / "config" / "ats-vocab.yml")
    cv_dir = Path(args.cv_dir)
    if not cv_dir.is_dir():
        print(json.dumps({"error": f"not a directory: {cv_dir}", "files": [], "titles": [], "skills": []}))
        return 1
    print(json.dumps(summarize(cv_dir, vocab), indent=1))
    return 0


def _score(args: argparse.Namespace) -> int:
    """Score cached job descriptions against the candidate's CVs, or one pasted JD file."""
    import json

    from .score import Scorer

    cfg = load_config(args.config)
    scorer = Scorer.from_config(cfg)
    if not scorer.ready:
        cv_dir = cfg.paths["cv_dir"]
        print(f"no readable CV in {cv_dir} — add a .docx, .pdf, .txt or .md master", file=sys.stderr)
        # A CV that failed to parse looks identical to an empty folder from here. Say which.
        for name, why in getattr(scorer, "unreadable", {}).items():
            print(f"  {name}: {why}", file=sys.stderr)
        return 1

    if args.jd_file:
        text = Path(args.jd_file).read_text(encoding="utf-8", errors="replace")
        result = scorer.score(text)
        print(json.dumps(result.as_dict() | {"hits": result.hits}, indent=1))
        return 0

    date = args.date or today()
    source = cfg.work_path(f"enriched-{date}.jsonl")
    if not source.exists():
        print(f"no enriched run for {date}: {source}", file=sys.stderr)
        return 1

    rows = read_jsonl(source)
    scored = 0
    for row in rows:
        if row.get("verdict") not in ("shortlist", "check"):
            continue
        cached = cfg.work_path("cache", "jd", f"{row['id']}.txt")
        if not cached.exists():
            continue
        row.update(scorer.score(cached.read_text(encoding="utf-8", errors="replace")).as_dict())
        scored += 1

    with open(source, "w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row) + "\n")

    calls: dict[str, int] = {}
    for row in rows:
        if row.get("call"):
            calls[row["call"]] = calls.get(row["call"], 0) + 1
    print(f"scored {scored} postings | " + " · ".join(f"{k} {v}" for k, v in sorted(calls.items())))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ajs-py", description="auto-job-search reporting and scoring")
    parser.add_argument("--config", help="path to scan-config.yml")
    sub = parser.add_subparsers(dest="command", required=True)

    report = sub.add_parser("report", help="build the Excel workbook for a run")
    report.add_argument("--date", help="run date (default: today)")
    report.add_argument("--input", help="explicit JSONL input")
    report.add_argument("--kind", default="full_sweep", help="which configured output name to use")
    report.set_defaults(func=_report)

    suggest = sub.add_parser("suggest", help="propose keywords from a folder of CV documents")
    suggest.add_argument("--cv-dir", required=True)
    suggest.add_argument("--vocab", help="path to ats-vocab.yml (default: from config)")
    suggest.set_defaults(func=_suggest)

    score = sub.add_parser("score", help="score postings against the candidate's CVs")
    score.add_argument("--date", help="run date (default: today)")
    score.add_argument("--jd-file", help="score a single job description from a file instead")
    score.set_defaults(func=_score)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except ConfigError as err:
        print(f"config error: {err}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
