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

import json
import re
import zipfile
from collections import Counter
from functools import lru_cache
from pathlib import Path

import yaml

#: Default location of the shared job-title vocabulary.
TITLE_TERMS = Path(__file__).resolve().parents[3] / "config" / "title-terms.json"

#: Words that introduce an employer or a place, so the phrase after them is not a title.
_CONNECTORS = frozenset({"at", "for", "with", "in", "of", "to", "from", "by"})

#: A word inside a job title: letters, and the joiners titles actually use.
_WORD = re.compile(r"[A-Za-z][A-Za-z'&/.-]*")

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
        except Exception as err:  # noqa: BLE001 - a third-party parser can raise anything,
            # and one damaged CV must never stop onboarding. pypdf alone raises PdfStreamError,
            # PdfReadError, DependencyError and more; naming them is a losing game.
            unreadable[path.name] = f"{type(err).__name__}: {err}"
            continue
        if text.strip():
            out[path.name] = text
        else:
            unreadable[path.name] = "no text found (a scanned image, or an empty file)"
    return out, unreadable


@lru_cache(maxsize=4)
def load_title_terms(path: str | Path = TITLE_TERMS) -> tuple[frozenset, frozenset, frozenset, frozenset]:
    """(role nouns, qualifiers, stop words, trailing markers) from the shared vocabulary."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return (
        frozenset(w.lower() for w in data.get("role_nouns", [])),
        frozenset(w.lower() for w in data.get("qualifiers", [])),
        frozenset(w.lower() for w in data.get("stop_words", [])),
        frozenset(w.lower() for w in data.get("trailing", [])),
    )


def titles_in(text: str, path: str | Path = TITLE_TERMS, max_words: int = 4) -> list[str]:
    """
    Every job title in a block of text, lowercased.

    A title is a short noun phrase ending in a role noun — "registered nurse", "senior data
    engineer", "diesel mechanic". Reading it that way finds titles in any field; the previous
    version matched a hard-coded list of IT roles, so a nurse's CV proposed nothing at all.
    """
    nouns, qualifiers, stops, trailing = load_title_terms(path)
    found: list[str] = []
    # Punctuation ends a phrase: a title never runs across a comma, a period or a line break.
    for segment in re.split(r"[^A-Za-z'&/\- ]+", text):
        words = _WORD.findall(segment)
        lowered = [w.lower().strip(".") for w in words]
        for i, word in enumerate(lowered):
            if word not in nouns:
                continue
            # Walk left from the role noun for the longest phrase that still reads as a title.
            start = i
            while start > 0 and i - start + 1 < max_words:
                previous = lowered[start - 1]
                # A role noun may sit inside a title ("nurse manager", "engineer supervisor"),
                # so it does not stop the walk — only prose and level markers do.
                if previous in stops or previous in trailing:
                    break
                if len(previous) < 2:
                    break
                # "Senior Data Engineer at Acme Systems Administrator" — a word introduced by a
                # preposition is an employer or a place, not part of the title before it.
                if start > 1 and lowered[start - 2] in _CONNECTORS:
                    break
                start -= 1
            phrase = lowered[start : i + 1]
            while phrase and (phrase[0] in qualifiers or phrase[0] in trailing):
                phrase = phrase[1:]
            if phrase and phrase[-1] in nouns:
                found.append(" ".join(phrase))
    return found


def suggest_titles(
    texts: dict[str, str], limit: int = 12, terms_path: str | Path = TITLE_TERMS
) -> list[str]:
    """Role titles that appear in the documents, most frequent first."""
    counter: Counter[str] = Counter()
    for text in texts.values():
        counter.update(titles_in(text, terms_path))
    # A bare role noun ("manager") is only worth proposing when nothing qualifies it, because
    # on its own it matches half a job board.
    qualified = {t for t in counter if " " in t}
    for title in list(counter):
        if " " not in title and any(q.endswith(f" {title}") for q in qualified):
            del counter[title]
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
