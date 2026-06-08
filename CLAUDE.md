# CLAUDE.md - AeroPDF Contributor Guide

This file is the fast orientation guide for AI coding agents and human maintainers working in this repository.

## Project Summary

AeroPDF is an anonymous browser-based PDF editor.

- Backend: FastAPI + PyMuPDF.
- Frontend: React + TypeScript + Vite + PDF.js + Tesseract.js.
- Storage model: local session directories with versioned PDF snapshots.
- Editing model: all mutations create a new PDF version and return fresh page metadata.
- Deployment model: frontend on Vercel, backend on Render, Docker for self-hosting.

There is no database yet. Do not add one unless the feature requires accounts, saved documents, team workspaces, audit logs, or durable storage across backend restarts.

## First Commands

Run the app:

```bash
python run.py
```

Backend tests:

```bash
cd backend
python -m pytest
```

Frontend build:

```bash
cd frontend
npm run build
```

Frontend type check only:

```bash
cd frontend
npx tsc --noEmit
```

## Repository Map

```text
backend/
  main.py                FastAPI app assembly
  config.py              AEROPDF_* settings
  deps.py                shared SessionManager and response helper
  logging_config.py      logging setup
  schemas.py             Pydantic API contracts
  sessions.py            session directories, manifests, version stack, locks
  pdf_engine.py          pure PDF extraction and mutation logic
  commands.py            deterministic command parser
  routers/
    documents.py         upload, download, delete session
    editing.py           replace, edit block, OCR persistence, commands, undo/redo
    pages.py             rotate, delete, reorder, duplicate, insert blank
    annotations.py       image, shape, highlight operations
  tests/
    test_engine.py
    test_sessions.py
    test_schemas.py

frontend/
  src/api.ts             API client and shared response types
  src/App.tsx            top-level state and mutation handlers
  src/index.css          global theme and layout
  src/components/
    PDFCanvas.tsx        PDF render, overlays, OCR, drawing gestures
    Sidebar.tsx          page thumbnails
    PropertiesPanel.tsx  text editing and tool entry points
    PageToolbar.tsx      page operations
    ShapeToolbar.tsx     drawing controls
    ImageInsertModal.tsx image placement form
    CommandConsole.tsx   command bar
```

## Non-Negotiable Architecture Rules

- Keep PDF mutation in `backend/pdf_engine.py`.
- Keep PDF file opening, saving, locking, manifest persistence, undo, and redo in `SessionManager`.
- Engine functions must accept an already-open `fitz.Document`; do not make them open/save files directly.
- Every mutating API route should use `session_manager.mutate`.
- Every mutating API route should return `EditResponse`.
- Validate inputs before committing a new version: page numbers, bboxes, dimensions, file type, file size, colors, and line widths.
- Keep frontend API calls centralized in `frontend/src/api.ts`.
- After a successful mutation, frontend state should flow through `App.applyEdit`.

## Backend Flow

Upload:

```text
POST /api/upload
  -> validate PDF bytes
  -> SessionManager.create
  -> SessionManager.extract
  -> UploadResponse
```

Mutation:

```text
route handler
  -> Pydantic request validation
  -> get_session_or_404
  -> session_manager.mutate(session_id, mutator)
  -> pdf_engine mutates open fitz.Document
  -> SessionManager saves next version
  -> build_edit_response
```

Undo/redo:

```text
POST /api/undo/{session_id}
POST /api/redo/{session_id}
  -> move version index
  -> save manifest
  -> return fresh extracted pages
```

## Frontend Flow

Top-level state lives in `App.tsx`:

- `session`: active document metadata and page tree.
- `history`: undo/redo state and version number.
- `activePage`: one-based page index.
- `selectedBlock`: currently selected text span.
- `activeShape`: current drawing tool.
- `isLoading`: blocks concurrent mutation calls.

Rendering:

- `PDFCanvas.tsx` renders the current PDF page with PDF.js.
- Text spans are transparent absolutely-positioned overlay divs.
- Canvas refresh uses `docVersion` as a cache buster.
- PDF.js worker is bundled from `pdfjs-dist`; do not switch back to a CDN worker.

Editing:

- Double-click a span to select it.
- `PropertiesPanel` edits text and calls `api.editBlock`.
- Find/replace calls `api.replace`.
- Page toolbar calls `api.rotate`, `api.duplicate`, `api.insertBlank`, and `api.deletePages`.
- OCR runs locally with Tesseract, then persists through `api.persistOcr`.
- Image and shape tools call annotation endpoints.

## API Contract

All mutating endpoints return:

```ts
interface EditResponse {
  success: boolean;
  message?: string;
  pages: PDFPage[];
  metadata: { title: string; author: string; pages: number };
  history: {
    can_undo: boolean;
    can_redo: boolean;
    version: number;
    total_versions: number;
  };
  replacements_made?: number;
  warnings?: string[];
}
```

Important endpoints:

- `POST /api/upload`
- `GET /api/download/{session_id}`
- `POST /api/replace/{session_id}`
- `POST /api/edit-block/{session_id}`
- `POST /api/ocr/{session_id}`
- `POST /api/command/{session_id}`
- `POST /api/undo/{session_id}`
- `POST /api/redo/{session_id}`
- `POST /api/pages/*`
- `POST /api/add-image/{session_id}`
- `POST /api/draw-shape/{session_id}`
- `POST /api/add-highlight/{session_id}`

## PDF Editing Details

Text replace:

- `replace_text` delegates to `replace_on_page`.
- Redaction annotations are added for all matches first.
- `page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)` is called once.
- Replacement text is inserted with captured style/baseline where possible.

Block edit:

- `edit_block` redacts the original rectangle.
- Background fill is sampled from the page.
- Font is resolved to a base-14 PDF font.
- Text is inserted with `insert_textbox`.
- Font size auto-shrinks to avoid silent clipping.

OCR:

- Tesseract returns canvas-pixel bboxes.
- Frontend maps them to PDF points.
- `POST /api/ocr/{session_id}` inserts text boxes into the PDF.
- OCR is now part of version history and export.

Annotations:

- `insert_image` validates positive dimensions and page bounds.
- `draw_shape` supports `rect`, `circle`, `line`, and `arrow`.
- `add_highlight` validates the bbox and page bounds.
- Images larger than 10 MB are rejected by the route.

## Current Limitations

- Inserted shapes/images are not yet selectable/editable after commit.
- OCR does not store confidence or expose a review queue.
- Zoom is fixed at `SCALE = 1.25` in `PDFCanvas.tsx`.
- No authentication, database, team workspace, audit log, or durable cloud storage.
- Free-tier backend restarts can remove local sessions unless persistent disk is configured.

## Good Next Changes

- Add object selection for images/shapes with move, resize, restyle, and delete.
- Add drag-and-drop page reorder in the sidebar.
- Add merge PDF, split PDF, and extract selected pages.
- Add zoom controls with a single shared scale state.
- Add Playwright smoke tests for upload, edit, OCR, undo/redo, shape, image, and export.
- Add structured frontend types for spans, blocks, images, and shapes to remove `any`.

## Common Pitfalls

- Do not call `apply_redactions` inside a per-span loop.
- Do not bypass `SessionManager.mutate` for a PDF edit.
- Do not mutate frontend session pages manually after an API edit; use `applyEdit`.
- Do not assume a static download URL means the canvas will refresh; keep the `docVersion` cache buster.
- Do not use `cwd` in GitHub Actions. Use `working-directory`.
- Do not add a DB for the current anonymous editing flow unless the product requirement has changed.

## CI Expectations

The workflow at `.github/workflows/ci.yml` should remain simple and reliable:

- Backend job installs `backend/requirements.txt` and runs `python -m pytest`.
- Frontend job runs `npm ci` and `npm run build` from `frontend/`.
- CI runs on push and pull request to `main`.

Avoid adding a linter unless the repo has a real config and the current code passes it locally.

## Deployment Notes

Render backend:

- `render.yaml`
- root directory `backend`
- health check `/api/health`
- required CORS env var: `AEROPDF_ALLOWED_ORIGINS`

Vercel frontend:

- `vercel.json`
- build output `frontend/dist`
- required production env var: `VITE_API_BASE`

Docker:

```bash
docker-compose up --build
```
