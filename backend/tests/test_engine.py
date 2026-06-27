"""
Unit tests for the PDF engine and session manager.

Run from the backend directory:  ``python -m pytest``
"""
from __future__ import annotations

import os
import sys

import fitz
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pdf_engine as engine  # noqa: E402


def _make_pdf(text: str = "Hello Draft world", size: float = 12.0) -> bytes:
    doc = fitz.open()
    page = doc.new_page(width=300, height=200)
    page.insert_text((50, 100), text, fontsize=size, fontname="helv")
    data = doc.tobytes()
    doc.close()
    return data


def _open(data: bytes) -> "fitz.Document":
    return fitz.open(stream=data, filetype="pdf")


# --------------------------------------------------------------------------- #
#  Font resolution
# --------------------------------------------------------------------------- #
def test_font_flags_take_priority():
    # Bold flag set even though name has no "bold".
    assert engine.resolve_pdf_font("CustomSans", flags=1 << 4) == "hebo"
    assert engine.resolve_pdf_font("Times New Roman") == "times"
    assert engine.resolve_pdf_font("Courier", flags=(1 << 4) | (1 << 1)) == "cobi"


def test_hex_roundtrip():
    assert engine.hex_to_rgb01("#ffffff") == (1.0, 1.0, 1.0)
    assert engine._int_to_hex(0x000000) == "#000000"


# --------------------------------------------------------------------------- #
#  Extraction
# --------------------------------------------------------------------------- #
def test_extract_reports_geometry_and_spans():
    doc = _open(_make_pdf())
    data = engine.extract_pdf_data(doc)
    assert data["metadata"]["pages"] == 1
    page = data["pages"][0]
    assert page["width"] == 300 and page["height"] == 200
    assert page["is_scanned"] is False
    spans = page["blocks"][0]["lines"][0]["spans"]
    assert any("Draft" in s["text"] for s in spans)
    assert "origin" in spans[0]
    doc.close()


# --------------------------------------------------------------------------- #
#  Replace
# --------------------------------------------------------------------------- #
def test_replace_changes_text_and_counts():
    doc = _open(_make_pdf("The Draft is a Draft"))
    n = engine.replace_text(doc, "Draft", "Final")
    assert n == 2
    text = doc[0].get_text()
    assert "Draft" not in text
    assert "Final" in text
    doc.close()


def test_replace_missing_term_is_noop():
    doc = _open(_make_pdf())
    assert engine.replace_text(doc, "Nonexistent", "X") == 0
    doc.close()


def test_replace_out_of_bounds_raises():
    doc = _open(_make_pdf())
    with pytest.raises(IndexError):
        engine.replace_text(doc, "Draft", "X", page_number=99)
    doc.close()


# --------------------------------------------------------------------------- #
#  Block edit overflow safety
# --------------------------------------------------------------------------- #
def test_edit_block_autoshrinks_long_text():
    doc = _open(_make_pdf())
    long_text = "word " * 200
    warnings = engine.edit_block(
        doc, 1, [50, 90, 120, 110], long_text, font_size=12, font_name="Helvetica", hex_color="#000000"
    )
    # Should either fit after shrinking or warn — never raise.
    assert isinstance(warnings, list)
    doc.close()


def test_edit_block_replaces_content():
    doc = _open(_make_pdf("Original text here"))
    engine.edit_block(doc, 1, [40, 88, 260, 112], "Brand new content", 12, "Helvetica", "#112233")
    assert "Original" not in doc[0].get_text()
    assert "Brand" in doc[0].get_text()
    doc.close()


# --------------------------------------------------------------------------- #
#  Page operations
# --------------------------------------------------------------------------- #
def test_page_ops():
    doc = fitz.open()
    for _ in range(3):
        doc.new_page(width=200, height=200)
    assert doc.page_count == 3

    engine.rotate_pages(doc, [1], 90)
    assert doc[0].rotation == 90

    engine.duplicate_page(doc, 1)
    assert doc.page_count == 4

    engine.delete_pages(doc, [4])
    assert doc.page_count == 3

    engine.reorder_pages(doc, [3, 2, 1])
    assert doc.page_count == 3

    engine.insert_blank_page(doc, after_page=3, width=None, height=None)
    assert doc.page_count == 4
    doc.close()


def test_cannot_delete_all_pages():
    doc = fitz.open()
    doc.new_page()
    with pytest.raises(ValueError):
        engine.delete_pages(doc, [1])
    doc.close()


def test_reorder_must_be_permutation():
    doc = fitz.open()
    doc.new_page()
    doc.new_page()
    with pytest.raises(ValueError):
        engine.reorder_pages(doc, [1, 1])
    doc.close()


def _two_page_pdf_bytes() -> bytes:
    src = fitz.open()
    src.new_page(width=200, height=200)
    src.new_page(width=200, height=200)
    data = src.tobytes()
    src.close()
    return data


def test_merge_appends_at_end():
    doc = fitz.open()
    doc.new_page(width=300, height=300)
    n = engine.merge_pdf(doc, _two_page_pdf_bytes())  # append
    assert n == 2
    assert doc.page_count == 3
    doc.close()


def test_merge_inserts_after_page():
    doc = fitz.open()
    for _ in range(3):
        doc.new_page(width=300, height=300)
    engine.merge_pdf(doc, _two_page_pdf_bytes(), after_page=1)  # after page 1
    assert doc.page_count == 5
    doc.close()


def test_merge_respects_page_limit():
    doc = fitz.open()
    doc.new_page()
    with pytest.raises(ValueError):
        engine.merge_pdf(doc, _two_page_pdf_bytes(), max_total_pages=2)
    doc.close()


def test_merge_rejects_invalid_bytes():
    doc = fitz.open()
    doc.new_page()
    with pytest.raises(ValueError):
        engine.merge_pdf(doc, b"not a pdf")
    doc.close()


def test_add_page_numbers_stamps_every_page():
    doc = fitz.open()
    for _ in range(3):
        doc.new_page(width=400, height=400)
    engine.add_page_numbers(doc, position="bottom-center", fmt="{n} of {total}")
    assert "1 of 3" in doc[0].get_text()
    assert "3 of 3" in doc[2].get_text()
    doc.close()


def test_add_page_numbers_rejects_bad_position():
    doc = fitz.open()
    doc.new_page()
    with pytest.raises(ValueError):
        engine.add_page_numbers(doc, position="middle")
    doc.close()


def test_insert_ocr_blocks_adds_text():
    doc = fitz.open()
    doc.new_page(width=300, height=200)
    warnings = engine.insert_ocr_blocks(
        doc,
        1,
        [
            {
                "text": "Scanned OCR Text",
                "bbox": [20, 20, 250, 60],
                "font_name": "Helvetica",
                "font_size": 12,
                "hex_color": "#000000",
            }
        ],
    )
    assert warnings == []
    assert "Scanned OCR Text" in doc[0].get_text()
    doc.close()


def test_insert_ocr_blocks_rejects_out_of_bounds():
    doc = fitz.open()
    doc.new_page(width=200, height=200)
    with pytest.raises(ValueError):
        engine.insert_ocr_blocks(
            doc,
            1,
            [{"text": "Bad", "bbox": [0, 0, 260, 40]}],
        )
    doc.close()


def test_insert_image_rejects_outside_page():
    doc = fitz.open()
    doc.new_page(width=200, height=200)
    png = (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc`\x00\x00"
        b"\x00\x02\x00\x01\xe2!\xbc3\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    with pytest.raises(ValueError):
        engine.insert_image(doc, 1, png, [180, 180, 260, 260])
    doc.close()


def test_flatten_objects_writes_text_and_shape():
    doc = fitz.open()
    doc.new_page(width=300, height=200)
    engine.flatten_objects(
        doc,
        [
            {
                "id": "shape-1",
                "page_number": 1,
                "type": "shape",
                "bbox": [20, 20, 120, 80],
                "shape_type": "rect",
                "stroke_color": "#000000",
                "fill_color": "#ff0000",
                "line_width": 2,
                "z_index": 0,
            },
            {
                "id": "text-1",
                "page_number": 1,
                "type": "text",
                "bbox": [30, 100, 220, 140],
                "text": "Overlay text",
                "font_family": "Inter",
                "font_size": 14,
                "color": "#000000",
                "align": "left",
                "z_index": 1,
            },
        ],
        lambda _: "",
    )
    assert "Overlay text" in doc[0].get_text()
    doc.close()


def test_draw_shape_directional_line_and_arrow():
    """Lines/arrows drawn right-to-left or bottom-to-top must work and keep direction."""
    doc = fitz.open()
    doc.new_page(width=300, height=200)
    # start bottom-right, end top-left — previously rejected
    engine.draw_shape(doc, 1, "line", [250, 150, 30, 20], "#000000", None, 2.0)
    engine.draw_shape(doc, 1, "arrow", [250, 20, 30, 150], "#ff0000", None, 2.0)
    drawings = doc[0].get_drawings()
    assert drawings, "line should be in the content stream"
    # the drawn line preserves its start/end direction
    items = [item for d in drawings for item in d["items"] if item[0] == "l"]
    assert any(abs(p1.x - 250) < 1 and abs(p2.x - 30) < 1 for _, p1, p2 in items)
    # arrow is a line annotation with raw endpoints
    annots = list(doc[0].annots() or [])
    assert len(annots) == 1
    doc.close()


def test_draw_shape_directional_line_rejected_when_outside_page():
    doc = fitz.open()
    doc.new_page(width=300, height=200)
    # start point is beyond the right edge; normalised bounds check must catch it
    with pytest.raises(ValueError):
        engine.draw_shape(doc, 1, "line", [350, 50, 100, 50], "#000000", None, 2.0)
    doc.close()


def test_flatten_objects_directional_line():
    doc = fitz.open()
    doc.new_page(width=300, height=200)
    engine.flatten_objects(
        doc,
        [
            {
                "id": "line-1",
                "page_number": 1,
                "type": "shape",
                "bbox": [250, 150, 30, 20],  # right-to-left, bottom-to-top
                "shape_type": "line",
                "stroke_color": "#000000",
                "line_width": 2,
                "z_index": 0,
            }
        ],
        lambda _: "",
    )
    assert doc[0].get_drawings()
    doc.close()
