"""Read a candidate's CV documents and propose scan keywords from them.

Used by onboarding: a new user should not have to invent search keywords, and keywords are the
single biggest lever on result quality. We read what their CV already says, match it against the
shared skill vocabulary, and propose role titles seen in the documents.

Only .docx is parsed (the format candidates actually keep masters in). Text is pulled straight
from the XML rather than through a dependency: a .docx is a zip with one document part, and a
run of text can be split across several <w:t> elements.
"""
from __future__ import annotations

import re
import zipfile
from collections import Counter
from pathlib import Path

import yaml

#: Role words that make a job title. Used to propose archetype keywords from CV headings.
TITLE_WORDS = re.compile(
    r"\b("
    r"(?:senior |lead |staff |principal |mid[- ]level )?"
    r"(?:data|software|systems?|security|network|cloud|platform|site reliability|devops|database|"
    r"analytics|business intelligence|machine learning|intelligence|support|infrastructure|qa|test)"
    r"[ -]?(?:engineer|engineering|administrator|analyst|architect|developer|scientist|specialist|"
    r"technician|manager)"
    r")\b",
    re.I,
)

_PARAGRAPH = re.compile(r"<w:p[ >].*?</w:p>", re.S)
_TEXT = re.compile(r"<w:t[^>]*>([^<]*)</w:t>")


def docx_text(path: str | Path) -> str:
    """Plain text of a .docx, one line per paragraph."""
    with zipfile.ZipFile(path) as zf:
        xml = zf.read("word/document.xml").decode("utf-8", "replace")
    lines = []
    for para in _PARAGRAPH.findall(xml):
        text = "".join(_TEXT.findall(para))
        if text.strip():
            lines.append(text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">"))
    return "\n".join(lines)


def read_cv_dir(cv_dir: str | Path) -> dict[str, str]:
    """{filename: text} for every readable .docx in a directory (Word lock files skipped)."""
    out: dict[str, str] = {}
    for path in sorted(Path(cv_dir).glob("*.docx")):
        if path.name.startswith("~$"):
            continue
        try:
            out[path.name] = docx_text(path)
        except (zipfile.BadZipFile, KeyError):
            continue
    return out


def suggest_titles(texts: dict[str, str], limit: int = 12) -> list[str]:
    """Role titles that appear in the documents, most frequent first."""
    counter: Counter[str] = Counter()
    for text in texts.values():
        for match in TITLE_WORDS.findall(text):
            counter[re.sub(r"\s+", " ", match).strip().lower()] += 1
    return [title for title, _ in counter.most_common(limit)]


def suggest_skills(texts: dict[str, str], vocab_path: str | Path, limit: int = 30) -> list[str]:
    """Vocabulary terms the CVs actually support, most-mentioned first."""
    vocab = (yaml.safe_load(Path(vocab_path).read_text(encoding="utf-8")) or {}).get("terms", {})
    joined = "\n".join(texts.values())
    hits: Counter[str] = Counter()
    for term, pattern in vocab.items():
        found = re.findall(pattern, joined, re.I)
        if found:
            hits[term] = len(found)
    return [term for term, _ in hits.most_common(limit)]


def summarize(cv_dir: str | Path, vocab_path: str | Path) -> dict:
    """Everything onboarding needs from a CV folder, in one call."""
    texts = read_cv_dir(cv_dir)
    return {
        "files": sorted(texts),
        "titles": suggest_titles(texts),
        "skills": suggest_skills(texts, vocab_path),
        "chars": {name: len(text) for name, text in texts.items()},
    }
