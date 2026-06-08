# AeroPDF Architecture

This document describes how AeroPDF is structured today: its editing model, session/version storage, coordinate system, API shape, and the constraints that matter when extending the app.

## System Overview

AeroPDF has two runtime services.

| Service | Responsibility |
| --- | --- |
| React/Vite frontend | Upload UI, PDF rendering with PDF.js, text/shape selection overlays, client-side OCR, user controls |
| FastAPI backend | PDF parsing, validated PDF mutation, session/version storage, undo/redo, downloads |

High-level flow:

```text
PDF upload
  -> POST /api/upload
  -> SessionManager creates session and version 0000.pdf
  -> PyMuPDF extracts page geometry, text spans, images, metadata
  -> frontend renders PDF canvas and overlays editable regions

Editor mutation
  -> frontend calls a mutating API endpoint
  -> router validates request with Pydantic
  -> SessionManager opens current PDF version under a per-session lock
  -> pdf_engine mutates the open fitz.Document
  -> SessionManager saves a new version snapshot
  -> backend returns fresh page tree + history state
  -> frontend re-renders canvas using docVersion cache busting
```

## Backend Modules

| File | Role |
| --- | --- |
| `main.py` | FastAPI app assembly, middleware, health route, lifespan purge loop |
| `config.py` | `AEROPDF_` environment settings |
| `schemas.py` | Pydantic request and response contracts |
| `sessions.py` | Session lifecycle, version snapshots, undo/redo, locks, manifest persistence |
| `pdf_engine.py` | Stateless PDF extraction and mutation functions |
| `commands.py` | Small command parser for the header command bar |
| `deps.py` | Shared `SessionManager`, session lookup, `EditResponse` builder |
| `routers/documents.py` | Upload, download, delete session |
| `routers/editing.py` | Replace, block edit, persisted OCR, commands, undo/redo |
| `routers/pages.py` | Rotate, delete, reorder, duplicate, insert blank |
| `routers/annotations.py` | Image insertion, shapes, highlights |

The important boundary is intentional: routers validate and coordinate work; `SessionManager` owns open/save/versioning; `pdf_engine.py` mutates an already-open `fitz.Document`.

## Frontend Modules

| File | Role |
| --- | --- |
| `src/App.tsx` | Top-level document state, active tool state, history, toasts, mutation handlers |
| `src/api.ts` | Typed API client and `VITE_API_BASE` resolution |
| `src/components/PDFCanvas.tsx` | PDF.js rendering, text overlays, OCR, shape drawing gestures |
| `src/components/Sidebar.tsx` | Page list and thumbnails |
| `src/components/PropertiesPanel.tsx` | Text editing, find/replace, insert/draw entry points |
| `src/components/PageToolbar.tsx` | Page-level commands |
| `src/components/ShapeToolbar.tsx` | Active shape, stroke, fill, line width controls |
| `src/components/ImageInsertModal.tsx` | Image file and placement form |
| `src/components/CommandConsole.tsx` | Command bar input |

PDF.js worker code is bundled from `pdfjs-dist`; it is not loaded from a CDN.

## Coordinate Model

PyMuPDF and the browser overlay both use a top-left origin for the extracted text geometry. The app therefore does not flip Y coordinates.

Current render scale:

```ts
const SCALE = 1.25;
```

Overlay conversion:

```text
css_left   = pdf_x0 * SCALE
css_top    = pdf_y0 * SCALE
css_width  = (pdf_x1 - pdf_x0) * SCALE
css_height = (pdf_y1 - pdf_y0) * SCALE
font_size  = span_size * SCALE
```

Shape drawing conversion:

```text
pdf_x = pointer_x / SCALE
pdf_y = pointer_y / SCALE
```

OCR conversion:

```text
pdf_x = (ocr_pixel_x / canvas_width) * page_width
pdf_y = (ocr_pixel_y / canvas_height) * page_height
```

Any future zoom work should replace the fixed `SCALE` with a single zoom state shared by canvas rendering, overlays, drawing, and OCR conversion.

## Session and Versioning Model

Each upload creates a UUID session directory under `settings.temp_dir`.

```text
<temp_dir>/
  <session_id>/
    manifest.json
    versions/
      0000.pdf
      0001.pdf
      0002.pdf
```

`manifest.json` stores:

- `session_id`
- original filename
- version filenames
- current version index
- created/updated timestamps

Every mutating endpoint uses `SessionManager.mutate(session_id, mutator)`:

1. Acquire the session lock.
2. Open the current PDF version.
3. Run the mutator against the open `fitz.Document`.
4. Save a new PDF version.
5. Drop redo history if editing after an undo.
6. Trim old versions past `AEROPDF_MAX_HISTORY_VERSIONS`.
7. Save the manifest atomically.

This gives crash-resistant mutation boundaries and safe undo/redo. It also means no endpoint should open a session PDF and save it manually.

## Text Editing

### Find and Replace

Engine functions:

- `replace_text`
- `replace_on_page`

Behavior:

- Finds matches on one page or the full document.
- Adds redaction annotations for all matches on a page.
- Applies redactions once per page.
- Inserts replacement text at the captured baseline with a resolved base-14 font.
- Supports whole-word and case-sensitive options.

Important rule: call `apply_redactions()` after all redaction annotations for the page have been added. Calling it inside a per-match loop can corrupt content streams.

### Block Editing

Engine function:

- `edit_block`

Behavior:

- Redacts the original bbox using a sampled background fill.
- Resolves the requested font to a base-14 PDF font.
- Uses `insert_textbox` to reflow text inside the original rectangle.
- Auto-shrinks text until it fits or reaches `MIN_FONT_SIZE`.
- Returns warnings instead of silently ignoring overflow risk.

## OCR Pipeline

OCR remains client-side because it is CPU-heavy and works on free hosting without a worker queue.

Current flow:

1. `PDFCanvas.tsx` detects scanned pages when a page has images but no text blocks.
2. User starts OCR from the page overlay.
3. Tesseract.js reads `canvas.toDataURL("image/png")` in a web worker.
4. Paragraph bounding boxes are mapped from canvas pixels to PDF points.
5. Frontend sends normalized blocks to `POST /api/ocr/{session_id}`.
6. Backend inserts OCR text boxes into the current PDF through `insert_ocr_blocks`.
7. `SessionManager` saves a new version snapshot, so OCR is undoable and exportable.

OCR request shape:

```json
{
  "page_number": 1,
  "blocks": [
    {
      "text": "Recognized text",
      "bbox": [50, 80, 300, 120],
      "font_name": "Helvetica",
      "font_size": 12,
      "hex_color": "#000000",
      "auto_shrink": true
    }
  ]
}
```

Known limitation: OCR text is inserted as visible text into approximate paragraph boxes. The app does not yet store OCR confidence, expose a review queue, or preserve a hidden searchable text layer separate from visible text.

## Annotation and Drawing Model

Current annotation operations are committed directly into the PDF:

- `insert_image`
- `draw_shape`
- `add_highlight`

Validation exists for:

- image MIME type
- image byte size
- positive width and height
- valid shape/highlight bounding boxes
- page bounds
- line width greater than zero

Current limitation: inserted images and shapes are not yet first-class selectable objects in frontend state. Once committed, they become part of the PDF rendering. The next product step is object selection/editing with move, resize, restyle, and delete.

## API Reference

### Upload Response

```json
{
  "session_id": "uuid",
  "filename": "document.pdf",
  "metadata": {
    "title": "",
    "author": "",
    "pages": 1,
    "encrypted": false
  },
  "pages": [],
  "history": {
    "can_undo": false,
    "can_redo": false,
    "version": 0,
    "total_versions": 1
  }
}
```

### Shared Edit Response

```json
{
  "success": true,
  "message": "",
  "pages": [],
  "metadata": {},
  "history": {
    "can_undo": true,
    "can_redo": false,
    "version": 1,
    "total_versions": 2
  },
  "replacements_made": null,
  "warnings": []
}
```

### Routes

| Method | Path | Request |
| --- | --- | --- |
| `GET` | `/api/health` | none |
| `POST` | `/api/upload` | multipart `file` |
| `GET` | `/api/download/{session_id}` | none |
| `DELETE` | `/api/session/{session_id}` | none |
| `POST` | `/api/replace/{session_id}` | `ReplaceRequest` |
| `POST` | `/api/edit-block/{session_id}` | `EditBlockRequest` |
| `POST` | `/api/ocr/{session_id}` | `PersistOCRRequest` |
| `POST` | `/api/command/{session_id}` | `CommandRequest` |
| `POST` | `/api/undo/{session_id}` | none |
| `POST` | `/api/redo/{session_id}` | none |
| `POST` | `/api/pages/rotate/{session_id}` | `RotateRequest` |
| `POST` | `/api/pages/delete/{session_id}` | `DeletePagesRequest` |
| `POST` | `/api/pages/reorder/{session_id}` | `ReorderRequest` |
| `POST` | `/api/pages/duplicate/{session_id}` | `DuplicatePageRequest` |
| `POST` | `/api/pages/insert-blank/{session_id}` | `InsertBlankRequest` |
| `POST` | `/api/add-image/{session_id}` | multipart image + page/x/y/width/height |
| `POST` | `/api/draw-shape/{session_id}` | `DrawShapeRequest` |
| `POST` | `/api/add-highlight/{session_id}` | `HighlightRequest` |

## Command Bar Grammar

Supported commands:

- `replace "a" with "b"`
- `replace "a" with "b" on page 2`
- `delete page 3`
- `delete pages 2-4`
- `delete pages 1,3,5`
- `rotate page 2 left`
- `rotate page 2 right`
- `rotate page 2 180`
- `rotate all right`
- `duplicate page 4`
- `insert page after page 2`

This is a deterministic parser, not an LLM integration.

## Deployment Architecture

The app currently deploys as two independent services.

```text
Vercel static frontend
  -> VITE_API_BASE
  -> Render FastAPI backend
  -> local session storage on backend instance
```

This is suitable for a free-tier prototype and short-lived editing sessions.

For durable accounts, team workspaces, saved documents, or audit trails, the architecture should add:

- Authentication provider.
- Object storage for PDFs and versions.
- Database for users, documents, sessions, and audit events.
- Optional worker queue for OCR/merge/split jobs.

Do not add a database just to support the current anonymous single-session editor. It adds deployment complexity without solving the current editing workflow.

## Free-Tier-Friendly Upgrade Path

Recommended order:

1. Finish object editing in the current architecture.
2. Add merge, split, page extraction, and drag reorder.
3. Add Playwright smoke tests.
4. Add optional auth and document metadata when the product needs saved documents.
5. Add external PDF storage only when sessions must survive host restarts reliably.

Good candidates when that phase arrives:

- Supabase: relational metadata, auth, storage, simple team/workspace model.
- Firebase: quick auth and simple document metadata.
- Cloudinary or object storage equivalent: image/PDF asset storage.
- Sentry: frontend/backend error monitoring.

Keep the current no-deployment-change phase focused on feature depth and reliability.
