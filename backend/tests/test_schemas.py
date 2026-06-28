from __future__ import annotations

import os
import sys

import pytest
from pydantic import ValidationError

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from schemas import (  # noqa: E402
    BatchDeleteRequest,
    BatchMoveRequest,
    DrawShapeRequest,
    EditorObjectCreateRequest,
    PersistOCRRequest,
)


def test_draw_shape_bbox_must_be_valid_rect():
    with pytest.raises(ValidationError):
        DrawShapeRequest(
            page_number=1,
            shape_type="rect",
            bbox=[10, 10, 10, 12],
            stroke_color="#000000",
            fill_color="#ffffff",
            line_width=2,
        )


def test_draw_shape_allows_directional_line_bbox():
    # Lines and arrows are directional: drawing right-to-left / bottom-to-top
    # produces x1 < x0 or y1 < y0 and must be accepted.
    for shape in ("line", "arrow"):
        req = DrawShapeRequest(
            page_number=1,
            shape_type=shape,
            bbox=[200, 300, 50, 40],
            stroke_color="#000000",
            line_width=2,
        )
        assert req.bbox == [200.0, 300.0, 50.0, 40.0]  # direction preserved

    # ...but a zero-length point is still rejected.
    with pytest.raises(ValidationError):
        DrawShapeRequest(page_number=1, shape_type="line", bbox=[50, 50, 50, 50], stroke_color="#000000")


def test_object_create_validates_line_bbox_after_shape_type():
    # shape_type is declared after bbox; validation must still honour it
    # (a horizontal line has zero height and is valid).
    req = EditorObjectCreateRequest(
        page_number=1,
        type="shape",
        bbox=[10, 100, 200, 100],
        shape_type="line",
    )
    assert req.bbox == [10.0, 100.0, 200.0, 100.0]

    with pytest.raises(ValidationError):
        EditorObjectCreateRequest(page_number=1, type="shape", bbox=[10, 100, 200, 100], shape_type="rect")


def test_persist_ocr_requires_non_empty_blocks():
    with pytest.raises(ValidationError):
        PersistOCRRequest(page_number=1, blocks=[])


def test_batch_move_requires_four_coord_bbox_and_nonempty():
    ok = BatchMoveRequest(moves=[{"id": "a", "bbox": [1, 2, 3, 4]}])
    assert ok.moves[0].id == "a"
    with pytest.raises(ValidationError):
        BatchMoveRequest(moves=[])
    with pytest.raises(ValidationError):
        BatchMoveRequest(moves=[{"id": "a", "bbox": [1, 2, 3]}])


def test_batch_delete_requires_ids():
    assert BatchDeleteRequest(ids=["a", "b"]).ids == ["a", "b"]
    with pytest.raises(ValidationError):
        BatchDeleteRequest(ids=[])
