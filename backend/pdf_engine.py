"""
pdf_engine
==========

Pure, stateless PDF logic built on PyMuPDF (fitz).  Every public function takes
an **already-open** ``fitz.Document`` and mutates it in place — opening, saving,
locking and versioning are the SessionManager's job (see ``sessions.py``).  This
separation lets a single mutation open the file once and save once, instead of
the old one-open-one-save *per page*.

Design improvements over the original prototype
------------------------------------------------
* **Background-aware redaction** – the fill colour under removed text is sampled
  from the page instead of being hard-coded white, so edits survive on coloured
  or scanned backgrounds.
* **Accurate baselines** – inserted text uses the glyph *origin* captured during
  extraction rather than a magic ``y1 - height*0.15`` fudge.
* **Reliable font style** – bold/italic/serif/mono are read from PyMuPDF span
  *flags* (not just the font name string), then mapped to a base-14 font whose
  glyph set is guaranteed to render the new characters.  (Re-embedding the
  original subsetted font is intentionally avoided: subsets omit glyphs for any
  character the user newly types, which renders as blank .notdef boxes.)
* **Overflow-safe block edits** – text is measured on a scratch page and the
  font auto-shrinks to fit, so edits never silently lose trailing text.
* **Image-preserving redaction** – ``apply_redactions`` is told not to wipe
  overlapping images/graphics.
"""
from __future__ import annotations

from collections import Counter
from typing import Any, Callable, Dict, List, Optional, Tuple

import fitz

from logging_config import get_logger

log = get_logger("pdf_engine")

# --- PyMuPDF span flag bits ------------------------------------------------- #
_FLAG_ITALIC = 1 << 1
_FLAG_SERIF = 1 << 2
_FLAG_MONO = 1 << 3
_FLAG_BOLD = 1 << 4

MIN_FONT_SIZE = 4.0
WHITE: Tuple[float, float, float] = (1.0, 1.0, 1.0)


# --------------------------------------------------------------------------- #
#  Colour helpers
# --------------------------------------------------------------------------- #
def _int_to_hex(color_val: int) -> str:
    r = (color_val >> 16) & 255
    g = (color_val >> 8) & 255
    b = color_val & 255
    return f"#{r:02x}{g:02x}{b:02x}"


def hex_to_rgb01(hex_color: str) -> Tuple[float, float, float]:
    s = hex_color.lstrip("#")
    return (int(s[0:2], 16) / 255.0, int(s[2:4], 16) / 255.0, int(s[4:6], 16) / 255.0)


def detect_fill_color(page: "fitz.Page", rect: "fitz.Rect") -> Tuple[float, float, float]:
    """Sample the page background around ``rect`` so redaction blends in.

    We rasterise a thin frame just outside the text rectangle and take the most
    common pixel colour.  Falls back to white on any error (the historic
    behaviour), so this can never make an edit fail.
    """
    try:
        pad = 2.0
        sample = fitz.Rect(
            max(rect.x0 - pad, page.rect.x0),
            max(rect.y0 - pad, page.rect.y0),
            min(rect.x1 + pad, page.rect.x1),
            min(rect.y1 + pad, page.rect.y1),
        )
        if sample.is_empty or sample.is_infinite:
            return WHITE
        pix = page.get_pixmap(clip=sample, colorspace=fitz.csRGB, alpha=False, dpi=72)
        if pix.width < 3 or pix.height < 3:
            return WHITE

        samples = pix.samples  # bytes, 3 per pixel
        stride = pix.stride
        counter: Counter = Counter()

        def px(x: int, y: int) -> Tuple[int, int, int]:
            o = y * stride + x * pix.n
            return samples[o], samples[o + 1], samples[o + 2]

        # Perimeter pixels are very likely background, not glyph ink.
        for x in range(pix.width):
            counter[px(x, 0)] += 1
            counter[px(x, pix.height - 1)] += 1
        for y in range(pix.height):
            counter[px(0, y)] += 1
            counter[px(pix.width - 1, y)] += 1

        (r, g, b), _ = counter.most_common(1)[0]
        return (r / 255.0, g / 255.0, b / 255.0)
    except Exception as exc:  # pragma: no cover - defensive
        log.debug("fill-colour sampling failed, defaulting to white: %s", exc)
        return WHITE


# --------------------------------------------------------------------------- #
#  Font resolution (base-14, glyph-safe)
# --------------------------------------------------------------------------- #
def resolve_pdf_font(font_name: str, flags: int = 0) -> str:
    """Map an extracted font to a base-14 alias, preferring span *flags*."""
    fn = (font_name or "").lower()
    is_bold = bool(flags & _FLAG_BOLD) or "bold" in fn or "black" in fn or "heavy" in fn
    is_italic = bool(flags & _FLAG_ITALIC) or "italic" in fn or "oblique" in fn
    is_serif = bool(flags & _FLAG_SERIF) or any(k in fn for k in ("times", "serif", "roman", "georgia", "garamond"))
    is_mono = bool(flags & _FLAG_MONO) or any(k in fn for k in ("courier", "mono", "consol", "code"))

    if is_mono:
        return {(0, 0): "cour", (1, 0): "cobo", (0, 1): "coit", (1, 1): "cobi"}[(int(is_bold), int(is_italic))]
    if is_serif:
        return {(0, 0): "times", (1, 0): "tibo", (0, 1): "tiit", (1, 1): "tibi"}[(int(is_bold), int(is_italic))]
    return {(0, 0): "helv", (1, 0): "hebo", (0, 1): "heio", (1, 1): "hebi"}[(int(is_bold), int(is_italic))]


# --------------------------------------------------------------------------- #
#  Extraction
# --------------------------------------------------------------------------- #
def extract_pdf_data(doc: "fitz.Document") -> Dict[str, Any]:
    """Serialise the document's pages, blocks, spans, images and geometry."""
    result: Dict[str, Any] = {
        "metadata": {
            "title": doc.metadata.get("title", "") if doc.metadata else "",
            "author": doc.metadata.get("author", "") if doc.metadata else "",
            "pages": doc.page_count,
            "encrypted": bool(doc.is_encrypted),
        },
        "pages": [],
    }

    for page_index in range(doc.page_count):
        page = doc[page_index]
        rect = page.rect
        text_dict = page.get_text("dict", flags=fitz.TEXTFLAGS_SEARCH)

        blocks: List[Dict[str, Any]] = []
        for b in text_dict.get("blocks", []):
            if b.get("type") != 0:  # 0 == text
                continue
            block_data: Dict[str, Any] = {"bbox": list(b["bbox"]), "lines": []}
            for line in b.get("lines", []):
                line_data: Dict[str, Any] = {"bbox": list(line["bbox"]), "spans": []}
                for span in line.get("spans", []):
                    line_data["spans"].append(
                        {
                            "text": span["text"],
                            "bbox": list(span["bbox"]),
                            "origin": list(span.get("origin", (span["bbox"][0], span["bbox"][3]))),
                            "font": span["font"],
                            "size": span["size"],
                            "flags": span.get("flags", 0),
                            "color": _int_to_hex(span["color"]),
                        }
                    )
                if line_data["spans"]:
                    block_data["lines"].append(line_data)
            if block_data["lines"]:
                blocks.append(block_data)

        images = []
        for img in page.get_images(full=True):
            xref = img[0]
            try:
                rects = page.get_image_rects(xref)
            except Exception:
                rects = []
            images.append(
                {
                    "xref": xref,
                    "bbox": list(rects[0]) if rects else [0, 0, 0, 0],
                    "width": img[2],
                    "height": img[3],
                }
            )

        result["pages"].append(
            {
                "number": page_index + 1,
                "width": rect.width,
                "height": rect.height,
                "rotation": page.rotation,
                "is_scanned": len(blocks) == 0 and len(images) > 0,
                "blocks": blocks,
                "images": images,
            }
        )

    return result


# --------------------------------------------------------------------------- #
#  Internal style lookup
# --------------------------------------------------------------------------- #
def _style_for_rect(page: "fitz.Page", text_dict: Dict, rect: "fitz.Rect") -> Dict[str, Any]:
    """Find the span overlapping ``rect`` and return its style + baseline."""
    best = None
    best_overlap = 0.0
    for b in text_dict.get("blocks", []):
        if b.get("type") != 0:
            continue
        for line in b.get("lines", []):
            for span in line.get("spans", []):
                sr = fitz.Rect(span["bbox"])
                inter = sr & rect
                area = inter.get_area() if not inter.is_empty else 0.0
                if area > best_overlap:
                    best_overlap = area
                    best = span

    if best is None:
        return {
            "font_name": "helv",
            "font_size": 11.0,
            "font_color": (0.0, 0.0, 0.0),
            "baseline_y": rect.y1 - (rect.height * 0.2),
        }

    c = best["color"]
    origin = best.get("origin", (best["bbox"][0], best["bbox"][3]))
    return {
        "font_name": resolve_pdf_font(best["font"], best.get("flags", 0)),
        "font_size": best["size"],
        "font_color": (((c >> 16) & 255) / 255.0, ((c >> 8) & 255) / 255.0, (c & 255) / 255.0),
        "baseline_y": origin[1],
    }


# --------------------------------------------------------------------------- #
#  Find & replace
# --------------------------------------------------------------------------- #
def _word_rects(page: "fitz.Page", term: str, case_sensitive: bool) -> List["fitz.Rect"]:
    """Whole-word matches: compare against tokenised page words."""
    target = term if case_sensitive else term.lower()
    rects = []
    for x0, y0, x1, y1, word, *_ in page.get_text("words"):
        cmp = word if case_sensitive else word.lower()
        if cmp == target:
            rects.append(fitz.Rect(x0, y0, x1, y1))
    return rects


def replace_on_page(
    page: "fitz.Page",
    search_term: str,
    replacement: str,
    case_sensitive: bool = False,
    whole_word: bool = False,
) -> int:
    """Redact every match of ``search_term`` and lay down ``replacement``."""
    if whole_word:
        rects = _word_rects(page, search_term, case_sensitive)
    else:
        # search_for is case-insensitive in modern PyMuPDF; when the caller
        # wants case sensitivity we keep only rects whose actual glyphs match.
        rects = page.search_for(search_term)
        if case_sensitive:
            rects = [r for r in rects if page.get_textbox(r).strip() == search_term]

    if not rects:
        return 0

    text_dict = page.get_text("dict")
    plan: List[Dict[str, Any]] = []
    for rect in rects:
        style = _style_for_rect(page, text_dict, rect)
        plan.append(
            {
                "rect": rect,
                "fill": detect_fill_color(page, rect),
                "style": style,
                "point": fitz.Point(rect.x0, style["baseline_y"]),
            }
        )

    # 1) annotate all, 2) apply ONCE (applying per-iteration corrupts the stream)
    for item in plan:
        page.add_redact_annot(item["rect"], fill=item["fill"])
    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)

    if replacement:
        for item in plan:
            s = item["style"]
            page.insert_text(
                item["point"],
                replacement,
                fontsize=s["font_size"],
                fontname=s["font_name"],
                color=s["font_color"],
            )
    return len(rects)


def replace_text(
    doc: "fitz.Document",
    search_term: str,
    replacement: str,
    page_number: Optional[int] = None,
    case_sensitive: bool = False,
    whole_word: bool = False,
) -> int:
    """Replace across one page (1-based) or the whole document."""
    if page_number is not None:
        if not 1 <= page_number <= doc.page_count:
            raise IndexError("Page number out of bounds")
        targets = [page_number - 1]
    else:
        targets = list(range(doc.page_count))

    total = 0
    for pno in targets:
        total += replace_on_page(doc[pno], search_term, replacement, case_sensitive, whole_word)
    return total


# --------------------------------------------------------------------------- #
#  Block edit (reflow into a box, overflow-safe)
# --------------------------------------------------------------------------- #
def _measure_leftover(rect: "fitz.Rect", text: str, fontname: str, fontsize: float, align: int) -> float:
    """Return insert_textbox's leftover height on a scratch page (no drawing)."""
    scratch = fitz.open()
    try:
        page = scratch.new_page(width=rect.width + 2, height=rect.height + 2)
        box = fitz.Rect(1, 1, rect.width + 1, rect.height + 1)
        return page.insert_textbox(box, text, fontsize=fontsize, fontname=fontname, align=align)
    finally:
        scratch.close()


def _fit_fontsize(rect: "fitz.Rect", text: str, fontname: str, start: float, align: int) -> Tuple[float, bool]:
    """Largest size <= ``start`` (down to MIN_FONT_SIZE) whose text fits."""
    if not text.strip():
        return start, True
    size = start
    while size >= MIN_FONT_SIZE:
        if _measure_leftover(rect, text, fontname, size, align) >= 0:
            return size, True
        size -= 0.5
    return MIN_FONT_SIZE, False


def edit_block(
    doc: "fitz.Document",
    page_number: int,
    original_bbox: List[float],
    new_text: str,
    font_size: float,
    font_name: str,
    hex_color: str,
    align: int = 0,
    auto_shrink: bool = True,
) -> List[str]:
    """Erase ``original_bbox`` and reflow ``new_text`` into it. Returns warnings."""
    if not 1 <= page_number <= doc.page_count:
        raise IndexError("Page number out of bounds")

    page = doc[page_number - 1]
    rect = fitz.Rect(original_bbox)
    warnings: List[str] = []

    fill = detect_fill_color(page, rect)
    page.add_redact_annot(rect, fill=fill)
    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)

    if not new_text:
        return warnings

    resolved_font = resolve_pdf_font(font_name)
    size = max(MIN_FONT_SIZE, float(font_size))
    if auto_shrink:
        size, fits = _fit_fontsize(rect, new_text, resolved_font, size, align)
        if not fits:
            warnings.append("Text is too long for the block even at minimum size; it may be clipped.")

    leftover = page.insert_textbox(
        rect,
        new_text,
        fontsize=size,
        fontname=resolved_font,
        color=hex_to_rgb01(hex_color),
        align=align,
    )
    if leftover < 0 and not warnings:
        warnings.append("Some text did not fit inside the block and was clipped.")
    return warnings


# --------------------------------------------------------------------------- #
#  Page operations
# --------------------------------------------------------------------------- #
def _validate_pages(doc: "fitz.Document", pages: List[int]) -> List[int]:
    for p in pages:
        if not 1 <= p <= doc.page_count:
            raise IndexError(f"Page {p} out of bounds (1..{doc.page_count})")
    return pages


def rotate_pages(doc: "fitz.Document", page_numbers: Optional[List[int]], degrees: int) -> None:
    targets = range(doc.page_count) if page_numbers is None else [p - 1 for p in _validate_pages(doc, page_numbers)]
    for pno in targets:
        page = doc[pno]
        page.set_rotation((page.rotation + degrees) % 360)


def delete_pages(doc: "fitz.Document", page_numbers: List[int]) -> None:
    _validate_pages(doc, page_numbers)
    if len(set(page_numbers)) >= doc.page_count:
        raise ValueError("Cannot delete every page of the document")
    doc.delete_pages([p - 1 for p in sorted(set(page_numbers))])


def reorder_pages(doc: "fitz.Document", order: List[int]) -> None:
    if sorted(order) != list(range(1, doc.page_count + 1)):
        raise ValueError("order must be a permutation of all page numbers")
    doc.select([p - 1 for p in order])


def duplicate_page(doc: "fitz.Document", page_number: int) -> None:
    _validate_pages(doc, [page_number])
    # Insert the copy right after the source; -1 appends when it's the last page
    # (PyMuPDF rejects to == page_count).
    to = page_number if page_number < doc.page_count else -1
    doc.fullcopy_page(page_number - 1, to=to)


def insert_blank_page(
    doc: "fitz.Document", after_page: int, width: Optional[float], height: Optional[float]
) -> None:
    if not 0 <= after_page <= doc.page_count:
        raise IndexError("after_page out of bounds")
    ref = doc[min(after_page, doc.page_count) - 1] if doc.page_count else None
    w = width or (ref.rect.width if ref else 595.0)
    h = height or (ref.rect.height if ref else 842.0)
    doc.new_page(pno=after_page, width=w, height=h)


_NUMBER_POSITIONS = {"top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"}


def add_page_numbers(
    doc: "fitz.Document",
    position: str = "bottom-center",
    start: int = 1,
    fmt: str = "{n}",
    font_size: float = 10.0,
    hex_color: str = "#000000",
    margin: float = 28.0,
) -> None:
    """Stamp a page number on every page. ``fmt`` supports {n} and {total}."""
    if position not in _NUMBER_POSITIONS:
        raise ValueError(f"position must be one of {sorted(_NUMBER_POSITIONS)}")
    color = hex_to_rgb01(hex_color)
    total = doc.page_count
    for i in range(total):
        page = doc[i]
        label = fmt.replace("{n}", str(start + i)).replace("{total}", str(total))
        rect = page.rect
        text_w = fitz.get_text_length(label, fontname="helv", fontsize=font_size)
        if "left" in position:
            x = margin
        elif "right" in position:
            x = rect.width - margin - text_w
        else:
            x = (rect.width - text_w) / 2
        y = margin + font_size if position.startswith("top") else rect.height - margin
        page.insert_text(fitz.Point(x, y), label, fontsize=font_size, fontname="helv", color=color)


def merge_pdf(
    doc: "fitz.Document",
    other_bytes: bytes,
    after_page: Optional[int] = None,
    max_total_pages: Optional[int] = None,
) -> int:
    """Insert all pages of another PDF after ``after_page`` (1-based; None = append).

    Returns the number of pages inserted.
    """
    try:
        src = fitz.open(stream=other_bytes, filetype="pdf")
    except Exception as exc:
        raise ValueError(f"Could not open the PDF to insert: {exc}") from exc
    try:
        if src.is_encrypted and not src.authenticate(""):
            raise ValueError("The PDF to insert is password-protected.")
        if src.page_count == 0:
            raise ValueError("The PDF to insert has no pages.")
        if max_total_pages is not None and doc.page_count + src.page_count > max_total_pages:
            raise ValueError(
                f"Merging would exceed the {max_total_pages}-page limit "
                f"({doc.page_count} + {src.page_count})."
            )
        # start_at is the 0-based index the source is inserted *in front of*;
        # inserting after a 1-based page N means index N. None => append.
        start_at = doc.page_count if after_page is None else max(0, min(after_page, doc.page_count))
        doc.insert_pdf(src, start_at=start_at)
        return src.page_count
    finally:
        src.close()


# --------------------------------------------------------------------------- #
#  Annotations & Drawing
# --------------------------------------------------------------------------- #
def insert_image(doc: "fitz.Document", page_number: int, image_bytes: bytes, rect: List[float]) -> None:
    if not 1 <= page_number <= doc.page_count:
        raise IndexError("Page number out of bounds")
    page = doc[page_number - 1]
    r = fitz.Rect(rect)
    if r.width <= 0 or r.height <= 0:
        raise ValueError("Image rectangle must have positive width and height")
    if r.x0 < page.rect.x0 or r.y0 < page.rect.y0 or r.x1 > page.rect.x1 or r.y1 > page.rect.y1:
        raise ValueError("Image rectangle is outside page bounds")
    page.insert_image(r, stream=image_bytes)

def draw_shape(
    doc: "fitz.Document", page_number: int, shape_type: str, bbox: List[float],
    stroke_color: str, fill_color: Optional[str], line_width: float
) -> None:
    if not 1 <= page_number <= doc.page_count:
        raise IndexError("Page number out of bounds")
    page = doc[page_number - 1]
    if line_width <= 0:
        raise ValueError("line_width must be > 0")

    # Lines/arrows are directional: bbox is [start_x, start_y, end_x, end_y]
    # in any orientation.  Normalise only for the bounds check so the drawn
    # direction is preserved.
    x0, y0, x1, y1 = (float(v) for v in bbox)
    norm = fitz.Rect(min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))
    if shape_type in {"rect", "circle"} and (norm.width <= 0 or norm.height <= 0):
        raise ValueError("Shape bbox must have positive width and height")
    if norm.x0 < page.rect.x0 or norm.y0 < page.rect.y0 or norm.x1 > page.rect.x1 or norm.y1 > page.rect.y1:
        raise ValueError("Shape bbox is outside page bounds")
    sc = hex_to_rgb01(stroke_color)
    fc = hex_to_rgb01(fill_color) if fill_color else None

    if shape_type == "arrow":
        # Annotation, because Shape has no arrowhead primitive.
        annot = page.add_line_annot(fitz.Point(x0, y0), fitz.Point(x1, y1))
        annot.set_line_ends(0, fitz.PDF_ANNOT_LE_OPEN_ARROW)
        annot.set_colors(stroke=sc)
        annot.set_border(width=line_width)
        annot.update()
        return

    shape = page.new_shape()
    if shape_type == "rect":
        shape.draw_rect(norm)
    elif shape_type == "circle":
        shape.draw_oval(norm)
    elif shape_type == "line":
        shape.draw_line(fitz.Point(x0, y0), fitz.Point(x1, y1))
    shape.finish(color=sc, fill=fc, width=line_width)
    shape.commit()

def add_highlight(doc: "fitz.Document", page_number: int, bbox: List[float], color: str) -> None:
    if not 1 <= page_number <= doc.page_count:
        raise IndexError("Page number out of bounds")
    page = doc[page_number - 1]
    rect = fitz.Rect(bbox)
    if rect.width <= 0 or rect.height <= 0:
        raise ValueError("Highlight bbox must have positive width and height")
    if rect.x0 < page.rect.x0 or rect.y0 < page.rect.y0 or rect.x1 > page.rect.x1 or rect.y1 > page.rect.y1:
        raise ValueError("Highlight bbox is outside page bounds")
    c = hex_to_rgb01(color)
    annot = page.add_highlight_annot(rect)
    annot.set_colors(stroke=c)
    annot.update()


def flatten_objects(
    doc: "fitz.Document",
    objects: List[Dict[str, Any]],
    asset_resolver: Callable[[str], str],
) -> None:
    """Flatten overlay editor objects into the PDF in z-index order."""
    align_map = {
        "left": 0,
        "center": 1,
        "right": 2,
        "justify": 3,
    }

    for obj in sorted(objects, key=lambda item: item.get("z_index", 0)):
        if obj.get("hidden"):
            continue

        page_number = int(obj["page_number"])
        if not 1 <= page_number <= doc.page_count:
            raise IndexError("Page number out of bounds")
        page = doc[page_number - 1]
        bbox = obj["bbox"]
        obj_type = obj["type"]

        if obj_type == "shape":
            draw_shape(
                doc,
                page_number,
                obj.get("shape_type", "rect"),
                bbox,
                obj.get("stroke_color", "#000000"),
                obj.get("fill_color"),
                float(obj.get("line_width", 2.0)),
            )
            continue

        rect = fitz.Rect(bbox)
        if rect.width <= 0 or rect.height <= 0:
            raise ValueError("Object bbox must have positive width and height")
        if rect.x0 < page.rect.x0 or rect.y0 < page.rect.y0 or rect.x1 > page.rect.x1 or rect.y1 > page.rect.y1:
            raise ValueError("Object bbox is outside page bounds")

        if obj_type == "image":
            # keep_proportion=False so the flattened image fills the frame the
            # user sized on screen (the canvas renders it with object-fit: fill).
            page.insert_image(rect, filename=asset_resolver(obj["asset_id"]), keep_proportion=False)
            continue

        if obj_type in {"text", "signature"}:
            fontname = "tiit" if obj_type == "signature" else resolve_pdf_font(obj.get("font_family", "Helvetica"))
            page.insert_textbox(
                rect,
                obj.get("text", ""),
                fontsize=float(obj.get("font_size", 12.0)),
                fontname=fontname,
                color=hex_to_rgb01(obj.get("color", "#000000")),
                align=align_map.get(obj.get("align", "left"), 0),
            )
            continue

        if obj_type == "comment":
            fill = hex_to_rgb01(obj.get("fill_color") or "#fff6bf")
            stroke = hex_to_rgb01(obj.get("stroke_color") or "#d7b200")
            shape = page.new_shape()
            shape.draw_rect(rect)
            shape.finish(color=stroke, fill=fill, width=max(1.0, float(obj.get("line_width", 1.0))))
            shape.commit()
            inset = fitz.Rect(rect.x0 + 6, rect.y0 + 6, rect.x1 - 6, rect.y1 - 6)
            if inset.width > 0 and inset.height > 0:
                page.insert_textbox(
                    inset,
                    obj.get("text", ""),
                    fontsize=float(obj.get("font_size", 11.0)),
                    fontname=resolve_pdf_font(obj.get("font_family", "Helvetica")),
                    color=hex_to_rgb01(obj.get("color", "#000000")),
                )


def insert_ocr_blocks(
    doc: "fitz.Document",
    page_number: int,
    blocks: List[Dict[str, Any]],
) -> List[str]:
    """Insert OCR-derived text boxes onto a page and return non-fatal warnings."""
    if not 1 <= page_number <= doc.page_count:
        raise IndexError("Page number out of bounds")
    page = doc[page_number - 1]
    warnings: List[str] = []

    for idx, block in enumerate(blocks, start=1):
        text = (block.get("text") or "").strip()
        if not text:
            continue

        rect = fitz.Rect(block["bbox"])
        if rect.width <= 0 or rect.height <= 0:
            raise ValueError(f"OCR block {idx} has invalid bbox dimensions")
        if rect.x0 < page.rect.x0 or rect.y0 < page.rect.y0 or rect.x1 > page.rect.x1 or rect.y1 > page.rect.y1:
            raise ValueError(f"OCR block {idx} is outside page bounds")

        font_name = resolve_pdf_font(block.get("font_name", "Helvetica"))
        font_size = max(MIN_FONT_SIZE, float(block.get("font_size", 12.0)))
        color = hex_to_rgb01(block.get("hex_color", "#000000"))
        auto_shrink = bool(block.get("auto_shrink", True))

        if auto_shrink:
            fitted, fits = _fit_fontsize(rect, text, font_name, font_size, align=0)
            font_size = fitted
            if not fits:
                warnings.append(f"OCR block {idx} is too long and may be clipped.")

        leftover = page.insert_textbox(
            rect,
            text,
            fontsize=font_size,
            fontname=font_name,
            color=color,
            align=0,
        )
        if leftover < 0:
            warnings.append(f"OCR block {idx} overflowed and may be clipped.")

    return warnings

