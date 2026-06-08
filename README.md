# AeroPDF

AeroPDF is a browser-based PDF editor built with FastAPI, PyMuPDF, React, TypeScript, Vite, PDF.js, and Tesseract.js.

It is designed around a simple local-first editing model: upload a PDF, edit it through the browser, keep every mutation in a versioned session, undo/redo safely, and export the current PDF when finished.

## Features

- Text block editing with PyMuPDF redaction and textbox reflow.
- Find and replace across the whole document or the active page.
- Client-side OCR for scanned pages, persisted back into the backend PDF session.
- Page operations: rotate, duplicate, delete, insert blank pages, and reorder through the API.
- Drawing and annotations: image insertion, rectangle, circle, line, arrow, and highlight support.
- Undo/redo through versioned PDF snapshots.
- Command bar for simple natural-language actions such as `replace "Draft" with "Final" on page 2`.
- Export the current PDF at any point.

## Tech Stack

| Area | Stack |
| --- | --- |
| Backend | FastAPI, PyMuPDF, Pydantic, pytest |
| Frontend | React 18, TypeScript, Vite, PDF.js, Tesseract.js, lucide-react |
| Local orchestration | `run.py` |
| Deployment configs | Render backend, Vercel frontend, Docker Compose |
| CI | GitHub Actions for backend tests and frontend build |

## Quick Start

Requirements:

- Python 3.11 recommended. Python 3.8+ should work with the current dependency range.
- Node.js 18+.
- npm.

Run both services:

```bash
python run.py
```

The script installs backend dependencies, installs frontend dependencies when needed, starts the FastAPI backend, starts the Vite dev server, and opens the local app.

Local URLs:

| Service | URL |
| --- | --- |
| Frontend | `http://localhost:5173` |
| Backend | `http://127.0.0.1:8000` |
| Health check | `http://127.0.0.1:8000/api/health` |

## Manual Setup

Backend:

```bash
cd backend
python -m pip install -r requirements.txt
python -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

The Vite dev server proxies `/api` to `http://localhost:8000`.

## Verification

Run backend tests:

```bash
cd backend
python -m pytest
```

Run frontend type check and production build:

```bash
cd frontend
npx tsc --noEmit
npm run build
```

The GitHub Actions workflow runs backend `pytest` and frontend `npm run build` on pushes and pull requests to `main`.

## Project Structure

```text
pdf-editor/
  run.py                    # Local dev orchestrator
  README.md                 # User-facing setup and operations guide
  ARCHITECTURE.md           # System architecture and API reference
  CLAUDE.md                 # AI/human contributor guide
  render.yaml               # Render backend blueprint
  vercel.json               # Vercel frontend build config
  docker-compose.yml        # Self-hosted Docker setup
  .github/workflows/ci.yml  # Backend and frontend CI

  backend/
    main.py                 # FastAPI app assembly
    config.py               # AEROPDF_* settings
    deps.py                 # Shared session manager and response builder
    logging_config.py       # Logging setup
    schemas.py              # Pydantic API contracts
    sessions.py             # Versioned session storage and undo/redo
    pdf_engine.py           # Pure PDF mutation/extraction logic
    commands.py             # Command bar interpreter
    routers/
      documents.py          # Upload, download, delete session
      editing.py            # Replace, edit block, OCR persistence, commands, undo/redo
      pages.py              # Page operations
      annotations.py        # Image, shape, highlight operations
    tests/
      test_engine.py
      test_sessions.py
      test_schemas.py

  frontend/
    package.json
    vite.config.ts
    src/
      api.ts
      App.tsx
      index.css
      components/
        CommandConsole.tsx
        ImageInsertModal.tsx
        PageToolbar.tsx
        PDFCanvas.tsx
        PropertiesPanel.tsx
        ShapeToolbar.tsx
        Sidebar.tsx
```

## API Overview

All mutating editor endpoints return a shared `EditResponse`:

```json
{
  "success": true,
  "message": "Text block updated.",
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

Core endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Service health |
| `POST` | `/api/upload` | Upload and parse a PDF |
| `GET` | `/api/download/{session_id}` | Download current PDF version |
| `DELETE` | `/api/session/{session_id}` | Delete a session |
| `POST` | `/api/replace/{session_id}` | Find and replace text |
| `POST` | `/api/edit-block/{session_id}` | Replace/reflow one text block |
| `POST` | `/api/ocr/{session_id}` | Persist client OCR text into the PDF session |
| `POST` | `/api/command/{session_id}` | Execute supported text command |
| `POST` | `/api/undo/{session_id}` | Move session history backward |
| `POST` | `/api/redo/{session_id}` | Move session history forward |
| `POST` | `/api/pages/rotate/{session_id}` | Rotate pages |
| `POST` | `/api/pages/delete/{session_id}` | Delete pages |
| `POST` | `/api/pages/reorder/{session_id}` | Reorder pages |
| `POST` | `/api/pages/duplicate/{session_id}` | Duplicate a page |
| `POST` | `/api/pages/insert-blank/{session_id}` | Insert a blank page |
| `POST` | `/api/add-image/{session_id}` | Insert an image |
| `POST` | `/api/draw-shape/{session_id}` | Draw rectangle, circle, line, or arrow |
| `POST` | `/api/add-highlight/{session_id}` | Add a highlight annotation |

## Configuration

Backend settings use the `AEROPDF_` environment prefix.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AEROPDF_TEMP_DIR` | system temp directory + `aeropdf_sessions` | Session and version storage |
| `AEROPDF_MAX_FILE_MB` | `50` | Upload size limit |
| `AEROPDF_MAX_PAGES` | `2000` | Page count limit |
| `AEROPDF_SESSION_TTL_HOURS` | `24` | Idle session purge age |
| `AEROPDF_MAX_HISTORY_VERSIONS` | `50` | Undo/redo version cap |
| `AEROPDF_ALLOWED_ORIGINS` | localhost Vite origins | CORS allowlist |
| `AEROPDF_LOG_LEVEL` | `INFO` | Log level |
| `AEROPDF_JSON_LOGS` | `false` | JSON log output |
| `AEROPDF_CLEANUP_ON_SHUTDOWN` | `false` | Remove temp session directory on shutdown |

Frontend production builds should set:

| Variable | Example |
| --- | --- |
| `VITE_API_BASE` | `https://your-render-backend.onrender.com/api` |

## Deployment

### Render Backend and Vercel Frontend

The current deployment files keep backend and frontend separate.

Backend on Render:

1. Use `render.yaml` as a blueprint or create a Python web service manually.
2. Root directory: `backend`.
3. Build command: `pip install -r requirements.txt`.
4. Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`.
5. Health check: `/api/health`.
6. Set `AEROPDF_ALLOWED_ORIGINS` to the Vercel frontend URL.

Frontend on Vercel:

1. Import the repo.
2. `vercel.json` builds from `frontend/` and serves `frontend/dist`.
3. Set `VITE_API_BASE` to the Render backend URL plus `/api`.

Free-tier note: session storage is local to the backend instance. On free hosts without persistent disk, sessions can disappear on restart or redeploy. That is acceptable for the current no-account editor flow, but durable saved documents require external storage and a database in a later phase.

### Docker

```bash
docker-compose up --build
```

Docker URLs:

| Service | URL |
| --- | --- |
| Frontend | `http://localhost:80` |
| Backend | `http://localhost:8000` |

## Development Rules

- Keep all PDF mutation in `backend/pdf_engine.py`.
- Keep file opening, saving, locking, and versioning in `SessionManager`.
- Every mutating route should return `EditResponse`.
- Validate page numbers, bounding boxes, file sizes, and file types before committing a new PDF version.
- Run backend tests and frontend build before merging.

## Near-Term Roadmap

- Select, move, resize, restyle, and delete inserted images and shapes.
- Drag-and-drop page reorder in the sidebar.
- Merge PDFs and extract selected pages.
- More complete OCR review flow with confidence indicators.
- Playwright smoke tests for upload, edit, undo/redo, OCR, shape insertion, and export.
