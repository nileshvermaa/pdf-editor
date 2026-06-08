# CLAUDE.md — AeroPDF Codebase Guide

> Quick orientation for any AI (or human) coming into this repo cold.

---

## What this project is

**AeroPDF** — a browser-based PDF editor.

- **Backend**: FastAPI + PyMuPDF (Python), split into modules — a pure PDF engine, a versioned session manager (undo/redo), an NL command interpreter, and three routers. Handles PDF parsing, background-aware text redaction, text insertion, page operations, and file download.
- **Frontend**: React + TypeScript + Vite. Renders PDF pages via PDF.js, overlays editable `<div>`s for WYSIWYG editing, runs OCR via Tesseract.js Web Workers.

---

## Run it locally

```bash
python run.py   # installs deps, starts both servers
# backend  → http://127.0.0.1:8000
# frontend → http://localhost:5173
```

Requirements: Python 3.8+, Node 18+.

---

## Repository layout

```
pdf-editor/
├── run.py                  # Orchestrator — starts both servers
├── vercel.json             # Vercel frontend (Vite SPA) build config
├── render.yaml             # Render backend (Docker) blueprint
├── docker-compose.yml      # Docker self-host config
├── CLAUDE.md               # ← you are here
├── ARCHITECTURE.md         # Deep-dive: coordinate math, API schemas, OCR pipeline
├── README.md               # User-facing setup + deployment docs
│
├── backend/
│   ├── main.py             # FastAPI app assembly — middleware, lifespan, error handler
│   ├── config.py           # Settings (env-overridable, prefix AEROPDF_)
│   ├── logging_config.py   # Structured / JSON logging
│   ├── schemas.py          # Pydantic request/response models (the API contract)
│   ├── pdf_engine.py       # Pure PDF logic — extract, redact, insert, page ops
│   ├── sessions.py         # SessionManager — version stack (undo/redo), locks, persistence
│   ├── commands.py         # Natural-language command interpreter
│   ├── deps.py             # Shared singletons + EditResponse builder
│   ├── routers/            # documents.py · editing.py · pages.py
│   ├── tests/              # pytest suite (test_engine.py, test_sessions.py)
│   ├── requirements.txt    # Python deps
│   └── Dockerfile
│
└── frontend/
    ├── index.html          # Loads Nunito font from Google Fonts
    ├── vite.config.ts      # Dev proxy: /api → http://localhost:8000
    ├── .env.example        # Env vars needed for production
    └── src/
        ├── main.tsx
        ├── index.css       # Global styles — DWTD flat theme (see below)
        ├── api.ts          # Typed API client — one call per endpoint
        ├── App.tsx         # Root component — state, upload, history, toasts
        └── components/
            ├── PDFCanvas.tsx       # PDF.js render + WYSIWYG overlay + OCR
            ├── Sidebar.tsx         # Page list / thumbnails
            ├── PropertiesPanel.tsx # Block editor + find-and-replace panel
            ├── PageToolbar.tsx     # Rotate / duplicate / delete / insert page
            └── CommandConsole.tsx  # Header command bar ("replace X with Y")
```

---

## Key concepts

### Coordinate mapping

PDF points → CSS pixels via a single scale factor:

```
SCALE = 1.25   (module-level constant in PDFCanvas.tsx)
left   = bbox[0] * SCALE
top    = bbox[1] * SCALE
width  = (bbox[2] - bbox[0]) * SCALE
height = (bbox[3] - bbox[1]) * SCALE
```

PyMuPDF uses top-left origin, same as the browser. No flip needed.

### Text replacement (backend)

All PDF mutation lives in `backend/pdf_engine.py` and operates on an **already-open** `fitz.Document` — opening/saving/locking is the SessionManager's job, so a mutation across N pages opens and saves the file exactly **once** (the old code opened+saved per page).

| Mode | Trigger | Engine function | PyMuPDF calls |
|------|---------|-----------------|---------------|
| Find & Replace | `POST /api/replace` | `replace_text` → `replace_on_page` | `add_redact_annot` × N → `apply_redactions` once → `insert_text` × N |
| Block edit | `POST /api/edit-block` | `edit_block` | `add_redact_annot` → `apply_redactions` → `insert_textbox` (auto-shrink to fit) |
| Page ops | `POST /api/pages/*` | `rotate_pages` / `delete_pages` / `reorder_pages` / `duplicate_page` / `insert_blank_page` | `set_rotation` / `delete_pages` / `select` / `fullcopy_page` / `new_page` |

Engine guarantees:
- **Background-aware redaction** — `detect_fill_color()` samples the page so removed text is filled with the real background colour, not hard-coded white.
- **Accurate baselines** — insertion uses the captured span `origin`, not a `y1 - height*0.15` fudge.
- **Glyph-safe fonts** — bold/italic/serif/mono are read from span *flags* and mapped to a base-14 font. Re-embedding the original subsetted font is intentionally avoided (subsets lack glyphs for newly-typed chars → blank `.notdef` boxes).
- **Overflow-safe blocks** — text is measured on a scratch page and the font auto-shrinks; if it still won't fit, a `warnings[]` entry is returned rather than silently clipping.

**Critical**: `apply_redactions()` must be called **once** after all `add_redact_annot` calls, not inside a per-span loop — calling it inside the loop corrupts the page content stream. Redaction passes `images=fitz.PDF_REDACT_IMAGE_NONE` so overlapping images survive.

### Session model & version history

Each upload creates a UUID session under `backend/temp_docs/<session_id>/` with a `versions/` stack (`0000.pdf`, `0001.pdf`, …) and a `manifest.json`. Every mutating edit applies to the current version and writes a **new** snapshot, so:
- **Undo/redo** is an index move (`POST /api/undo`, `/api/redo`); a fresh edit after an undo forks history (the redo tail is discarded). Depth is capped by `AEROPDF_MAX_HISTORY_VERSIONS` (default 50).
- **Concurrency** is safe — each session has a `threading.Lock`; PyMuPDF runs in a thread-pool via `run_in_threadpool`.
- **Durability** — sessions + full history survive a restart (manifest is reloaded on startup). Idle sessions older than `AEROPDF_SESSION_TTL_HOURS` (default 24) are purged hourly.

⚠️ **Serverless caveat (Vercel/Lambda):** storage defaults to the system temp dir (`/tmp`, the only writable path), but `/tmp` is **per-instance and ephemeral** — a follow-up edit/download request can land on a different cold instance with an empty `/tmp` and `_sessions` dict, returning 404. Stateful editing therefore needs either (a) a long-lived host (Railway/Render/Fly/Docker), or (b) external session storage (S3 for blobs + Redis/DB for the manifest). Single upload-only flows are fine on serverless.

### OCR pipeline

1. `PDFCanvas.tsx` detects a scanned page (`blocks.length === 0 && images.length > 0`).
2. User clicks → `runLocalOCR()` → Tesseract.js worker reads `canvas.toDataURL()`.
3. Tesseract returns pixel-space bboxes → divide by canvas dimensions × PDF dimensions to get PDF-space bboxes.
4. Synthetic block objects pushed into session state via `onOCRComplete` callback — no server round-trip.

---

## Frontend state flow

```
App.tsx
  session       → full PDF metadata + page/block tree from the backend
  activePage    → 1-based index of the currently visible page
  selectedBlock → the span the user double-clicked (drives PropertiesPanel)

  history       → { can_undo, can_redo, version } from the last EditResponse

  upload   → POST /api/upload        → setSession + setHistory
  replace  → POST /api/replace       → applyEdit (pages + history)
  edit     → POST /api/edit-block    → applyEdit
  command  → POST /api/command       → applyEdit
  pageops  → POST /api/pages/*        → applyEdit
  undo/redo→ POST /api/undo|redo      → applyEdit
  export   → GET  /api/download?v=N  → opens new tab
```

Every mutating endpoint returns the same `EditResponse` (`pages`, `metadata`,
`history`, `warnings`), so `App.applyEdit()` folds them back uniformly. All
calls go through the typed client in `src/api.ts`. The canvas re-fetches on a
`docVersion` bump (the download URL is otherwise static, so without it the
rendered image would never refresh after an edit).

---

## API reference

All mutating endpoints return an `EditResponse`: `{success, message, pages[], metadata, history, replacements_made?, warnings[]}`.

| Method | Path | Body |
|--------|------|------|
| GET | `/api/health` | — |
| POST | `/api/upload` | `multipart/form-data` file → UploadResponse (adds `session_id`, `filename`) |
| POST | `/api/replace/{session_id}` | `{search_term, replacement, page_number?, case_sensitive?, whole_word?}` |
| POST | `/api/edit-block/{session_id}` | `{page_number, original_bbox, new_text, font_size, font_name, hex_color, align?, auto_shrink?}` |
| POST | `/api/command/{session_id}` | `{command}` (NL string) |
| POST | `/api/undo/{session_id}` · `/api/redo/{session_id}` | — |
| POST | `/api/pages/rotate/{session_id}` | `{page_numbers?, degrees}` |
| POST | `/api/pages/delete/{session_id}` | `{page_numbers[]}` |
| POST | `/api/pages/reorder/{session_id}` | `{order[]}` (permutation) |
| POST | `/api/pages/duplicate/{session_id}` | `{page_number}` |
| POST | `/api/pages/insert-blank/{session_id}` | `{after_page, width?, height?}` |
| DELETE | `/api/session/{session_id}` | — |
| GET | `/api/download/{session_id}` | — → PDF file |

**Commands** (`/api/command`): `replace "a" with "b" [on page N]` · `delete page N` (or `2-4`, `1,3`) · `rotate page N left|right|180` · `duplicate page N` · `insert page after page N`.

---

## UI theme — "Dumb Ways to Die"

Flat, vivid, NO gradients. All in `frontend/src/index.css`.

| Token | Value | Used for |
|-------|-------|---------|
| `--red` | `#FF3B2F` | Header bar, danger |
| `--teal` | `#00BCD4` | Primary buttons, active states |
| `--yellow` | `#FFD600` | Find & replace card accent |
| `--orange` | `#FF8B00` | Scanned page badges |
| `--green` | `#4CAF50` | Success toasts |
| `--bg` | `#F8F4EE` | Page background (warm off-white) |
| `--r-pill` | `999px` | Pill-shaped buttons |

Font: **Nunito** (Google Fonts, 400–900 weights) — rounded, friendly, playful.

---

## Common gotchas

- **Null bytes in files**: Writing to the Windows-mounted path via some tools injects `\x00` bytes. Fix: `raw.replace(b'\x00', b'')` before write. Check with `grep -c $'\x00' <file>`.
- **Linter truncation**: A formatter on the dev machine may truncate files on save. Write files via bash heredoc (`python3 << 'PYEOF' ... PYEOF`) to bypass.
- **PDF.js worker version**: Must match the `pdfjs-dist` npm package version (`3.4.120`). Worker CDN URL is hardcoded in `PDFCanvas.tsx` line 7.
- **`apply_redactions` loop bug**: Fixed — do NOT call inside a per-span loop. One call after all annotations.
- **`run.py` shell=True bug**: Fixed — backend now launched with `[sys.executable, "-m", "uvicorn", ...]` without `shell=True`.
- **Render race condition**: Fixed — `PDFCanvas.tsx` uses per-invocation `cancelled` flag, not stale `rendering` state.
- **Stale canvas after edits**: Fixed — the download URL is static, so the canvas now re-fetches via a `?v=docVersion` cache-buster keyed on the history version.
- **PyMuPDF ≥1.27 API drift**: `fitz.TEXT_CASE_INSENSITIVE` was removed (search is case-insensitive by default); case-sensitive replace post-filters with `get_textbox`. `fullcopy_page(pno, to=page_count)` raises — duplicating the last page uses `to=-1`.
- **Backend tests**: `cd backend && python -m pytest` (17 tests; engine + sessions). No server needed.
- **Open-doc contract**: engine functions never open/save/close — pass them an open `fitz.Document` from `SessionManager.mutate`, which handles versioning. Don't reintroduce per-call `fitz.open(...).save(...)`.

---

## Deployment

### Local (development)
```bash
python run.py
```

### Docker (self-hosted)
```bash
docker-compose up --build
# frontend → :80, backend → :8000
```

### Production — backend on Render, frontend on Vercel (canonical)

Two independent services. Render is long-lived, so the session/version model
(undo/redo, durable history) works as designed — no serverless caveat applies.

**Backend → Render** (`render.yaml` blueprint, or manual):
- Uses Render's **native Python runtime** (not Docker) — avoids Dockerfile path
  ambiguity in monorepos. `rootDir: backend`, start command:
  `uvicorn main:app --host 0.0.0.0 --port $PORT`.
- Python version pinned via `backend/runtime.txt` (`python-3.11.0`).
- Health check: `/api/health`.
- Set `AEROPDF_ALLOWED_ORIGINS` to the Vercel frontend URL(s), comma-separated,
  no trailing slash. This is the CORS allowlist read in `config.py` /
  consumed by the `CORSMiddleware` in `main.py`.
- Free plan: no persistent disk — history is ephemeral. To persist, upgrade to a
  paid instance and add the `disk:` block commented out in `render.yaml`.

**Frontend → Vercel** (`vercel.json` — plain Vite SPA, no multi-service):
- `vercel.json` builds `frontend/` (`cd frontend && npm install && npm run build`,
  output `frontend/dist`) and rewrites all routes to `/index.html`.
- Set `VITE_API_BASE` to the Render URL + `/api`
  (e.g. `https://aeropdf-backend.onrender.com/api`). `src/api.ts` reads this and
  falls back to `/api` (Vite dev proxy) only when unset — there is no longer any
  `.vercel.app` → `/_/backend/api` auto-detect.

### Backend configuration (env vars, prefix `AEROPDF_`)

| Var | Default | Purpose |
|-----|---------|---------|
| `AEROPDF_TEMP_DIR` | `<system temp>/aeropdf_sessions` | Session storage root (system temp is writable on serverless too) |
| `AEROPDF_MAX_FILE_MB` | `50` | Upload size limit |
| `AEROPDF_MAX_PAGES` | `2000` | Page-count limit |
| `AEROPDF_ALLOWED_ORIGINS` | `localhost:5173` | CORS allowlist (`*` for dev) |
| `AEROPDF_SESSION_TTL_HOURS` | `24` | Idle-session purge age |
| `AEROPDF_MAX_HISTORY_VERSIONS` | `50` | Undo/redo depth |
| `AEROPDF_JSON_LOGS` | `false` | Emit JSON logs |
                                              