# AeroPDF — Web-Based PDF Editor

A browser-based PDF editor with WYSIWYG text editing, client-side OCR for scanned pages, and one-command local setup.

**Stack**: FastAPI + PyMuPDF (backend) · React + TypeScript + Vite + PDF.js (frontend)

---

## Features

- **WYSIWYG text editing** — PDF pages render to `<canvas>` via PDF.js; transparent `<div>` overlays let you double-click any text span to edit it in the properties panel.
- **Find & Replace** — replace a word or phrase across the whole document or a single page. Powered by PyMuPDF redaction + text insertion.
- **Scanned page OCR** — pages with no text layer show an orange prompt; one click runs Tesseract.js in a Web Worker and makes the extracted text fully editable.
- **AI command bar** — issue plain-English commands like `replace "Draft" with "Final"` or `replace "Old" with "New" on page 2`.
- **Export** — download the modified PDF at any time.

---

## Quick start

### Requirements

- Python 3.8+
- Node.js 18+

### Run

```bash
git clone https://github.com/nileshcf/pdf-editor.git
cd pdf-editor
python run.py
```

`run.py` will:
1. Install Python backend deps (`fastapi`, `uvicorn`, `pymupdf`, `python-multipart`).
2. Run `npm install` inside `frontend/` if `node_modules` is missing.
3. Start the FastAPI backend on `http://127.0.0.1:8000`.
4. Start the Vite frontend on `http://localhost:5173` and open it in your browser.

Press `Ctrl+C` to cleanly shut down both servers.

---

## Deployment

### Backend on Render + frontend on Vercel (recommended)

Render is a long-lived host, so sessions and full undo/redo history survive
between requests (unlike serverless). Deploy the two services in this order.

**1. Backend → Render**

1. Push this repo to GitHub.
2. On [render.com](https://render.com): **New → Blueprint**, select this repo. Render
   reads [`render.yaml`](./render.yaml) and provisions a native Python web service
   (rooted at `backend/`, health check at `/api/health`).
   - Or do it manually: **New → Web Service**, Root Directory `backend`, runtime
     **Python**, build command `pip install -r requirements.txt`, start command
     `uvicorn main:app --host 0.0.0.0 --port $PORT`.
3. Note the service's public URL, e.g. `https://aeropdf-backend.onrender.com`.
4. Set the CORS env var on the backend service (you'll fill the real value after
   step 2 once you know the Vercel URL):

   | Key | Value |
   |-----|-------|
   | `AEROPDF_ALLOWED_ORIGINS` | `https://your-frontend.vercel.app` |

   Comma-separate multiple origins (e.g. add your `*.vercel.app` preview URL). No trailing slash.

**2. Frontend → Vercel**

1. Import the same repo on [vercel.com](https://vercel.com). `vercel.json` builds the
   Vite app from `frontend/` and serves it as a static SPA — no extra settings needed.
2. In **Project Settings → Environment Variables**, add:

   | Key | Value |
   |-----|-------|
   | `VITE_API_BASE` | `https://aeropdf-backend.onrender.com/api` |

   (your Render URL from step 1 + `/api`).
3. Deploy, then go back and set `AEROPDF_ALLOWED_ORIGINS` on Render to the Vercel URL.

> **Free-tier note**: Render free instances sleep when idle, so the first request
> after a pause takes a few seconds to wake. Free instances also have no persistent
> disk — session history resets on each deploy/restart. For durable history, use a
> paid instance and keep the `disk:` block in `render.yaml`.

### Docker (self-hosted)

```bash
docker-compose up --build
# frontend → http://localhost:80
# backend  → http://localhost:8000
```

---

## Project structure

```
pdf-editor/
├── run.py                  # Dev orchestrator
├── vercel.json             # Vercel frontend (Vite SPA) build config
├── render.yaml             # Render backend (Python) blueprint
├── docker-compose.yml
├── CLAUDE.md               # AI codebase guide (architecture, gotchas, patterns)
├── ARCHITECTURE.md         # Deep-dive: coordinate math, API schemas, OCR pipeline
│
├── backend/
│   ├── main.py             # FastAPI routes
│   ├── utils.py            # PDF manipulation (PyMuPDF)
│   ├── requirements.txt
│   └── Dockerfile
│
└── frontend/
    ├── index.html
    ├── vite.config.ts
    ├── .env.example        # Copy to .env.local for production overrides
    └── src/
        ├── App.tsx
        ├── index.css       # Global theme (Dumb Ways to Die flat style)
        └── components/
            ├── PDFCanvas.tsx
            ├── Sidebar.tsx
            ├── PropertiesPanel.tsx
            └── CommandConsole.tsx
```

For a full architectural deep-dive — coordinate mapping math, API schemas, OCR pipeline — see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

For an AI-readable codebase guide (patterns, gotchas, state flow) see [`CLAUDE.md`](./CLAUDE.md).

---

## Contributing

PRs welcome. Run `tsc 