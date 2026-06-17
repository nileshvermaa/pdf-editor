# CLAUDE.md - AeroPDF Contributor Guide

This is the fast orientation guide for maintainers and coding agents working in this repository.

## Product Summary

AeroPDF is a browser-based PDF editor with two editing models:

- direct editing of existing PDF text
- editable overlay objects for newly added content

Current overlay objects:

- text
- comment
- signature
- image
- shape (`rect`, `circle`, `line`, `arrow`)

Undo/redo spans both models because session history versions the PDF snapshot and object snapshot together.

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

Frontend type check:

```bash
cd frontend
npx tsc --noEmit
```

Frontend build:

```bash
cd frontend
npm run build
```

## Repository Map

```text
backend/
  main.py                FastAPI app assembly
  config.py              AEROPDF_* settings
  deps.py                shared SessionManager and response builder
  logging_config.py      logging setup
  schemas.py             request/response and object models
  sessions.py            PDF/object version history, manifests, assets, exports
  pdf_engine.py          pure PDF extraction/mutation/flatten logic
  commands.py            deterministic command parser
  routers/
    documents.py         upload, download, delete session
    editing.py           replace, edit block, OCR, commands, undo/redo
    pages.py             rotate, delete, reorder, duplicate, insert blank
    annotations.py       compatibility routes for shape/image object creation, highlight
    objects.py           object CRUD, reorder, flatten, asset serving
  tests/
    test_engine.py
    test_sessions.py
    test_schemas.py

frontend/
  src/api.ts             API client and shared types
  src/App.tsx            top-level editor state and mutation handlers
  src/index.css          layout and visual system
  src/components/
    AeroLogo.tsx         product mark
    PDFCanvas.tsx        PDF canvas, text hitboxes, object layer, OCR, drag interactions
    Sidebar.tsx          page previews
    PropertiesPanel.tsx  contextual inspector
    ImageInsertModal.tsx image placement form
```

## Core Architecture Rules

- Keep PDF mutation logic in `backend/pdf_engine.py`.
- Keep file opening, saving, versioning, object snapshotting, and locking in `SessionManager`.
- Engine functions must operate on an already-open `fitz.Document`.
- PDF mutations must go through `session_manager.mutate(...)`.
- Object metadata mutations must go through `session_manager.mutate_objects(...)`.
- Mutating routes should return `EditResponse`.
- Validate page numbers, bboxes, dimensions, colors, and file inputs before committing history.
- Keep frontend API calls centralized in `frontend/src/api.ts`.
- After successful API edits, frontend state should refresh from the returned `pages` tree, not manual local patching.

## Session Model

Every session stores:

- versioned PDFs in `versions/`
- versioned object JSON snapshots in `object_versions/`
- image assets in `assets/`
- temporary flattened downloads in `exports/`

The PDF version index and object version index are intentionally aligned.

Implication:

- undo/redo restores both PDF content and overlay objects together
- object-only edits still create a new history entry
- PDF-only edits clone the current object snapshot forward

Do not split history into separate PDF and object undo stacks.

## Editing Model

### Existing PDF Content

These flows mutate the actual PDF immediately:

- replace text
- block edit
- OCR persistence
- page operations
- highlight annotation

### Overlay Objects

These flows mutate object metadata first:

- add image
- draw shape
- create text/comment/signature object
- move object
- edit object properties
- reorder or delete object

Overlay objects are flattened into the PDF:

- on explicit `POST /api/flatten/{session_id}`
- on `GET /api/download/{session_id}` if pending objects exist

## Frontend State

`App.tsx` currently owns:

- `session`
- `history`
- `activePage`
- `selectedBlock`
- `selectedObjectId`
- `activeTool`
- `activeShape`
- inspector state entry points

`PDFCanvas.tsx` is responsible for:

- PDF.js rendering
- extracted span hitboxes
- overlay object rendering
- object dragging
- text/comment/signature click-to-create
- shape drag-to-create
- OCR worker flow

`PropertiesPanel.tsx` is the contextual inspector for:

- page actions
- extracted PDF text block editing
- overlay object transform/content/appearance editing
- export and flatten actions

## Current API Areas

Main routes:

- `/api/upload`
- `/api/file/{session_id}` (raw current version — canvas/thumbnail rendering)
- `/api/download/{session_id}` (export — flattens pending overlay objects)
- `/api/session/{session_id}`
- `/api/replace/{session_id}`
- `/api/edit-block/{session_id}`
- `/api/ocr/{session_id}`
- `/api/command/{session_id}`
- `/api/undo/{session_id}`
- `/api/redo/{session_id}`
- `/api/pages/*`
- `/api/add-image/{session_id}`
- `/api/draw-shape/{session_id}`
- `/api/add-highlight/{session_id}`
- `/api/objects/{session_id}`
- `/api/objects/{session_id}/{object_id}`
- `/api/objects/{session_id}/reorder`
- `/api/flatten/{session_id}`
- `/api/assets/{session_id}/{asset_id}`

## Current Known Limitations

- Resize is currently inspector-driven, not drag-handle resize.
- Rotation is not yet wired through the frontend interaction model.
- Existing embedded PDF graphics are not reverse-mapped into editable overlay objects.
- Zoom is still fixed at `SCALE = 1.25`.
- There is no auth, durable document library, team model, or audit trail.

## Good Next Changes

- Add drag-handle resize and rotation.
- Add zoom controls and fit modes.
- Add page drag reorder in the sidebar UI.
- Add merge, split, and extract operations.
- Add Playwright smoke coverage for object create/edit/move/flatten/export.
- Reduce `any` usage in frontend page/span typing.

## Pitfalls

- Do not bypass `SessionManager` for any history-changing operation.
- Do not write object state directly into the frontend only; persist it through the API.
- Do not make `download` serve stale unflattened PDFs when overlay objects exist.
- Never point the canvas/thumbnails at `/api/download` — it flattens pending objects into the bytes, so every overlay object renders twice (bitmap + DOM layer). Rendering must use `/api/file` (raw current version).
- Do not reintroduce a CDN PDF.js worker.
- Do not add a database for the current anonymous session flow unless the product requirement actually changes.
- `.object-overlay-layer` must keep `pointer-events: none` (objects re-enable themselves). It is a full-size child of `.editing-overlay-layer`, and the canvas click handler guards on `event.target === event.currentTarget` — if this div becomes clickable again, click-to-create, shape drawing, and click-to-deselect all silently die.
- Line/arrow bboxes are **directional** (`[start_x, start_y, end_x, end_y]`, any orientation) — never normalize them in storage or flatten, only for bounds checks and CSS envelopes. Rect/circle/text bboxes must stay ordered.
- Object bbox validation lives in `EditorObjectCreateRequest`'s `model_validator`, not a `bbox` field validator — `shape_type` is declared after `bbox`, so a field validator cannot see it.
- Always load PDF.js documents through `frontend/src/pdfCache.ts` (`getPdfDocument(url, version)`), never `getDocument` directly — the canvas and sidebar share one parsed copy per version.

## Deployment Notes

Current deployment is still:

- frontend on Vercel
- backend on Render

That is fine for the current feature phase.

Important constraint:

- sessions and object assets live on backend disk
- on free-tier hosts without persistent storage, sessions can disappear on restart or redeploy

Do not design features that assume durable storage unless deployment changes with them.
