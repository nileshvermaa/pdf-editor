from __future__ import annotations

import re
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
OBJECT_TYPES = {"text", "shape", "comment", "signature", "image"}
SHAPE_TYPES = {"rect", "circle", "line", "arrow"}


def _validate_hex(value: str) -> str:
    if not HEX_RE.match(value):
        raise ValueError("Must be a 6-digit hex color like #18A0FB")
    return value.lower()


def _validate_rect(value: List[float], *, allow_line: bool = False) -> List[float]:
    if len(value) != 4:
        raise ValueError("bbox must contain exactly four numbers")
    x0, y0, x1, y1 = [float(v) for v in value]
    if allow_line:
        # Lines/arrows are directional: [x0, y0] is the start point and
        # [x1, y1] the end point, so any orientation is valid except a dot.
        if x0 == x1 and y0 == y1:
            raise ValueError("bbox must span a visible area or line")
    elif x1 <= x0 or y1 <= y0:
        raise ValueError("bbox must describe a rectangle with positive width and height")
    return [x0, y0, x1, y1]


class HistoryState(BaseModel):
    can_undo: bool
    can_redo: bool
    version: int
    total_versions: int


class ReplaceRequest(BaseModel):
    search_term: str = Field(min_length=1)
    replacement: str = ""
    page_number: Optional[int] = Field(default=None, ge=1)
    case_sensitive: bool = False
    whole_word: bool = False


class EditBlockRequest(BaseModel):
    page_number: int = Field(ge=1)
    original_bbox: List[float]
    new_text: str = ""
    font_size: float = Field(default=12.0, ge=4.0, le=144.0)
    font_name: str = "Helvetica"
    hex_color: str = "#000000"
    align: int = Field(default=0, ge=0, le=3)
    auto_shrink: bool = True

    @field_validator("original_bbox")
    @classmethod
    def validate_original_bbox(cls, value: List[float]) -> List[float]:
        return _validate_rect(value)

    @field_validator("hex_color")
    @classmethod
    def validate_hex_color(cls, value: str) -> str:
        return _validate_hex(value)


class CommandRequest(BaseModel):
    command: str = Field(min_length=1)


class RotateRequest(BaseModel):
    page_numbers: Optional[List[int]] = None
    degrees: int

    @field_validator("page_numbers")
    @classmethod
    def validate_pages(cls, value: Optional[List[int]]) -> Optional[List[int]]:
        if value is None:
            return value
        if not value:
            raise ValueError("page_numbers cannot be empty")
        if any(p < 1 for p in value):
            raise ValueError("page_numbers must be >= 1")
        return value


class DeletePagesRequest(BaseModel):
    page_numbers: List[int] = Field(min_length=1)

    @field_validator("page_numbers")
    @classmethod
    def validate_pages(cls, value: List[int]) -> List[int]:
        if any(p < 1 for p in value):
            raise ValueError("page_numbers must be >= 1")
        return value


class ReorderRequest(BaseModel):
    order: List[int] = Field(min_length=1)


class DuplicatePageRequest(BaseModel):
    page_number: int = Field(ge=1)


class PageNumberRequest(BaseModel):
    position: Literal[
        "top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"
    ] = "bottom-center"
    start: int = Field(default=1, ge=0)
    fmt: str = Field(default="{n}", min_length=1, max_length=64)
    font_size: float = Field(default=10.0, ge=4.0, le=72.0)
    hex_color: str = "#000000"

    @field_validator("hex_color")
    @classmethod
    def _hex(cls, value: str) -> str:
        return _validate_hex(value)


class InsertBlankRequest(BaseModel):
    after_page: int = Field(ge=0)
    width: Optional[float] = Field(default=None, gt=0)
    height: Optional[float] = Field(default=None, gt=0)


class DrawShapeRequest(BaseModel):
    page_number: int = Field(ge=1)
    shape_type: Literal["rect", "circle", "line", "arrow"]
    bbox: List[float]
    stroke_color: str = "#000000"
    fill_color: Optional[str] = None
    line_width: float = Field(default=2.0, gt=0, le=24.0)

    @field_validator("bbox")
    @classmethod
    def validate_bbox(cls, value: List[float], info) -> List[float]:
        shape_type = info.data.get("shape_type")
        return _validate_rect(value, allow_line=shape_type in {"line", "arrow"})

    @field_validator("stroke_color")
    @classmethod
    def validate_stroke_color(cls, value: str) -> str:
        return _validate_hex(value)

    @field_validator("fill_color")
    @classmethod
    def validate_fill_color(cls, value: Optional[str]) -> Optional[str]:
        return _validate_hex(value) if value else value


class HighlightRequest(BaseModel):
    page_number: int = Field(ge=1)
    bbox: List[float]
    color: str = "#fff200"

    @field_validator("bbox")
    @classmethod
    def validate_bbox(cls, value: List[float]) -> List[float]:
        return _validate_rect(value)

    @field_validator("color")
    @classmethod
    def validate_color(cls, value: str) -> str:
        return _validate_hex(value)


class OCRBlockRequest(BaseModel):
    text: str = Field(min_length=1)
    bbox: List[float]
    font_name: str = "Helvetica"
    font_size: float = Field(default=12.0, ge=4.0, le=144.0)
    hex_color: str = "#000000"
    auto_shrink: bool = True

    @field_validator("bbox")
    @classmethod
    def validate_bbox(cls, value: List[float]) -> List[float]:
        return _validate_rect(value)

    @field_validator("hex_color")
    @classmethod
    def validate_color(cls, value: str) -> str:
        return _validate_hex(value)


class PersistOCRRequest(BaseModel):
    page_number: int = Field(ge=1)
    blocks: List[OCRBlockRequest] = Field(min_length=1)


class EditorObjectCreateRequest(BaseModel):
    page_number: int = Field(ge=1)
    type: Literal["text", "shape", "comment", "signature", "image"]
    bbox: List[float]
    rotation: float = 0.0
    opacity: float = Field(default=1.0, ge=0.0, le=1.0)
    z_index: int = 0
    locked: bool = False
    hidden: bool = False
    text: Optional[str] = None
    font_family: str = "Inter"
    font_size: float = Field(default=12.0, ge=4.0, le=144.0)
    font_weight: str = "Regular"
    font_style: str = "normal"
    color: str = "#000000"
    align: Literal["left", "center", "right", "justify"] = "left"
    shape_type: Optional[Literal["rect", "circle", "line", "arrow"]] = None
    stroke_color: str = "#000000"
    fill_color: Optional[str] = None
    line_width: float = Field(default=2.0, gt=0, le=24.0)
    asset_id: Optional[str] = None

    @field_validator("color", "stroke_color")
    @classmethod
    def validate_hex_colors(cls, value: str) -> str:
        return _validate_hex(value)

    @field_validator("fill_color")
    @classmethod
    def validate_fill_color(cls, value: Optional[str]) -> Optional[str]:
        return _validate_hex(value) if value else value

    @model_validator(mode="after")
    def validate_object_fields(self) -> "EditorObjectCreateRequest":
        # bbox is validated here (not in a field_validator) because the rules
        # depend on shape_type, which is declared after bbox and therefore not
        # yet parsed when a bbox field_validator runs.
        allow_line = self.type == "shape" and self.shape_type in {"line", "arrow"}
        self.bbox = _validate_rect(self.bbox, allow_line=allow_line)
        if self.type == "shape" and not self.shape_type:
            raise ValueError("shape_type is required for shape objects")
        if self.type == "image" and not self.asset_id:
            raise ValueError("asset_id is required for image objects")
        if self.type in {"text", "comment", "signature"} and not (self.text or "").strip():
            raise ValueError("text is required for text-like objects")
        if self.type != "shape":
            self.shape_type = None
        if self.type != "image":
            self.asset_id = None
        return self


class EditorObjectUpdateRequest(BaseModel):
    page_number: Optional[int] = Field(default=None, ge=1)
    bbox: Optional[List[float]] = None
    rotation: Optional[float] = None
    opacity: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    z_index: Optional[int] = None
    locked: Optional[bool] = None
    hidden: Optional[bool] = None
    text: Optional[str] = None
    font_family: Optional[str] = None
    font_size: Optional[float] = Field(default=None, ge=4.0, le=144.0)
    font_weight: Optional[str] = None
    font_style: Optional[str] = None
    color: Optional[str] = None
    align: Optional[Literal["left", "center", "right", "justify"]] = None
    shape_type: Optional[Literal["rect", "circle", "line", "arrow"]] = None
    stroke_color: Optional[str] = None
    fill_color: Optional[str] = None
    line_width: Optional[float] = Field(default=None, gt=0, le=24.0)

    @field_validator("bbox")
    @classmethod
    def validate_bbox(cls, value: Optional[List[float]]) -> Optional[List[float]]:
        return _validate_rect(value, allow_line=True) if value is not None else value

    @field_validator("color", "stroke_color")
    @classmethod
    def validate_hex_colors(cls, value: Optional[str]) -> Optional[str]:
        return _validate_hex(value) if value is not None else value

    @field_validator("fill_color")
    @classmethod
    def validate_fill_color(cls, value: Optional[str]) -> Optional[str]:
        return _validate_hex(value) if value else value


class ObjectReorderRequest(BaseModel):
    object_ids: List[str] = Field(min_length=1)


class EditResponse(BaseModel):
    success: bool = True
    message: str = ""
    pages: List[Dict[str, Any]]
    metadata: Dict[str, Any]
    history: HistoryState
    replacements_made: Optional[int] = None
    warnings: List[str] = Field(default_factory=list)


class UploadResponse(BaseModel):
    success: bool = True
    session_id: str
    filename: str
    metadata: Dict[str, Any]
    pages: List[Dict[str, Any]]
    history: HistoryState
