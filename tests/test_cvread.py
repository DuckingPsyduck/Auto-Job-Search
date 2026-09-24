"""CV reading tests.

A CV that fails to parse looks exactly like an empty folder from the outside, and the user
sees only blank fit scores. These pin the part that tells them apart.
"""
from __future__ import annotations

import pytest
from ajs.cvread import read_cv_dir, suggest_titles

# A minimal one-page PDF with a single line of text, built by hand so the suite stays offline
# and does not need a writer library to test the reader.
_PDF_TEXT = b"BT /F1 12 Tf 72 720 Td (Registered Nurse) Tj ET"
_PDF_OBJECTS = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
    b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    b"<< /Length " + str(len(_PDF_TEXT)).encode() + b" >>\nstream\n" + _PDF_TEXT + b"\nendstream",
]


def _minimal_pdf() -> bytes:
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(_PDF_OBJECTS, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    start = len(out)
    out += f"xref\n0 {len(_PDF_OBJECTS) + 1}\n".encode() + b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(_PDF_OBJECTS) + 1} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n".encode()
    return bytes(out)


def test_plain_text_cv_is_read(tmp_path):
    (tmp_path / "cv.txt").write_text("Registered Nurse, 8 years. Epic EHR.", encoding="utf-8")
    texts, unreadable = read_cv_dir(tmp_path)
    assert "cv.txt" in texts
    assert "Epic EHR" in texts["cv.txt"]
    assert unreadable == {}


def test_markdown_counts_too(tmp_path):
    (tmp_path / "cv.md").write_text("# Sam\n\n- Charge nurse", encoding="utf-8")
    texts, _ = read_cv_dir(tmp_path)
    assert "cv.md" in texts


def test_unrelated_files_are_ignored_without_complaint(tmp_path):
    # A CV folder is a folder someone keeps files in; notes and images are not errors.
    (tmp_path / "notes.rtf").write_text("x", encoding="utf-8")
    (tmp_path / "headshot.png").write_bytes(b"\x89PNG")
    (tmp_path / "~$draft.docx").write_bytes(b"lock file")
    assert read_cv_dir(tmp_path) == ({}, {})


def test_an_empty_cv_is_reported_not_silently_dropped(tmp_path):
    (tmp_path / "blank.txt").write_text("   \n", encoding="utf-8")
    texts, unreadable = read_cv_dir(tmp_path)
    assert texts == {}
    assert "no text found" in unreadable["blank.txt"]


def test_a_corrupt_file_names_itself(tmp_path):
    (tmp_path / "cv.docx").write_bytes(b"this is not a zip")
    texts, unreadable = read_cv_dir(tmp_path)
    assert texts == {}
    assert "cv.docx" in unreadable


def test_missing_folder_is_not_an_error(tmp_path):
    assert read_cv_dir(tmp_path / "nope") == ({}, {})


def test_pdf_text_is_extracted(tmp_path):
    pytest.importorskip("pypdf")
    (tmp_path / "cv.pdf").write_bytes(_minimal_pdf())
    texts, unreadable = read_cv_dir(tmp_path)
    assert unreadable == {}
    assert "Registered Nurse" in texts["cv.pdf"]


def test_without_pypdf_the_message_says_how_to_fix_it(tmp_path, monkeypatch):
    # The failure mode we care about: a user whose only CV is a PDF must not see an empty folder.
    import builtins

    real_import = builtins.__import__

    def no_pypdf(name, *args, **kwargs):
        if name == "pypdf":
            raise ImportError("No module named 'pypdf'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_pypdf)
    (tmp_path / "cv.pdf").write_bytes(_minimal_pdf())
    texts, unreadable = read_cv_dir(tmp_path)
    assert texts == {}
    assert "pypdf" in unreadable["cv.pdf"]


def test_titles_are_proposed_from_whatever_format(tmp_path):
    (tmp_path / "cv.txt").write_text("Senior Data Engineer\nSystems Administrator", encoding="utf-8")
    texts, _ = read_cv_dir(tmp_path)
    assert "senior data engineer" in suggest_titles(texts)
