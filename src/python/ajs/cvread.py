"""Read a candidate's CV documents and propose scan keywords from them.

Used by onboarding: a new user should not have to invent search keywords, and keywords are the
single biggest lever on result quality. We read what their CV already says, match it against the
shared skill vocabulary, and propose role titles seen in the documents.

.docx text is pulled straight from the XML rather than through a dependency: a .docx is a zip
with one document part, and a run of text can be split across several <w:t> elements. Plain text
(.txt, .md) is read as-is.

PDF is the format people most often have and least often can export from, so it is supported —
but a PDF's text needs a real parser, so it requires `pypdf` (`pip install "auto-job-search[pdf]"`).
Without it, PDFs are skipped and `unreadable` says why, rather than the folder appearing empty.
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


def pdf_text(path: str | Path) -> str:
    """Plain text of a PDF. Raises ImportError when pypdf is not installed."""
    from pypdf import PdfReader  # optional dependency; imported where it is needed

    reader = PdfReader(str(path))
    pages = [page.extract_text() or "" for page in reader.pages]
    return "\n".join(line for line in "\n".join(pages).splitlines() if line.strip())


#: Extensions we attempt, in the order a folder listing is walked.
READERS = {
    ".docx": docx_text,
    ".pdf": pdf_text,
    ".txt": lambda p: Path(p).read_text(encoding="utf-8", errors="replace"),
    ".md": lambda p: Path(p).read_text(encoding="utf-8", errors="replace"),
}


def read_cv_dir(cv_dir: str | Path) -> tuple[dict[str, str], dict[str, str]]:
    """
    Read every CV in a directory.

    Returns ({filename: text}, {filename: why it could not be read}). The second half matters:
    a CV that silently failed to parse looks exactly like no CV at all, and the user would be
    left wondering why their fit scores are blank.
    """
    out: dict[str, str] = {}
    unreadable: dict[str, str] = {}
    for path in sorted(Path(cv_dir).iterdir() if Path(cv_dir).is_dir() else []):
        reader = READERS.get(path.suffix.lower())
        if reader is None or path.name.startswith("~$"):  # ~$ is a Word lock file
            continue
        try:
            text = reader(path)
        except ImportError:
            unreadable[path.name] = 'PDF support needs pypdf: pip install "auto-job-search[pdf]"'
            continue
        except (zipfile.BadZipFile, KeyError, OSError, ValueError) as err:
            unreadable[path.name] = f"{type(err).__name__}: {err}"
            continue
        if text.strip():
            out[path.name] = text
        else:
            unreadable[path.name] = "no text found (a scanned image, or an empty file)"
    return out, unreadable


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
    texts, unreadable = read_cv_dir(cv_dir)
    return {
        "files": sorted(texts),
        "unreadable": unreadable,
        "titles": suggest_titles(texts),
        "skills": suggest_skills(texts, vocab_path),
        "chars": {name: len(text) for name, text in texts.items()},
    }
