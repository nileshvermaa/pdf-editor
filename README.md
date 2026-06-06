# AeroPDF - Web-Based PDF Editor

AeroPDF is a high-fidelity, web-based PDF editor utilizing a FastAPI backend for core PDF structures/layout updates and a React + TypeScript + Vite frontend client that supports live WYSIWYG text overlay adjustments, client-side WebAssembly OCR, and command-driven actions.

## Core Features

1. **WYSIWYG Text Editing**:
   - PDF pages are rendered into HTML5 `<canvas>` elements using PDF.js.
   - Text boxes are absolutely mapped using backend layout coordinate extraction.
   - Double-clicking text boxes overlays a custom editable area to modify formatting and content directly.
2. **Text Reflow (Scenario A)**:
   - Modifying block paragraphs leverages the backend `insert_textbox` stream wrapping logic to reflow content safely.
3. **Scanned Page OCR (Scenario B)**:
   - Scanned pages are automatically detected.
   - A single-click triggers local **Tesseract.js** OCR via browser Web Workers to convert static images into active editable text spans.
4. **Command AI Console**:
   - Issue text commands like `replace "Draft" with "Final"` or `replace "Original" with "Updated" on page 1` to batch process modifications.

---

## Getting Started

### Prerequisites

Make sure you have the following installed on your machine:
- **Node.js** (v18+)
- **Python** (3.8+)
- **pip** (Python package installer)

### Quick Start

Simply run the orchestration script from the root folder:

```bash
python run.py
```

The script will automatically:
1. Detect and install Python backend dependencies (`fastapi`, `uvicorn`, `pymupdf`, `python-multipart`).
2. Run `npm install` inside the `frontend/` directory if node modules are missing.
3. Boot up the FastAPI backend on `http://127.0.0.1:8000`.
4. Boot up the React Vite frontend on `http://localhost:5173`.
5. Open your browser to `http://localhost:5173` and begin editing!

Press `Ctrl + C` in the console to cleanly shut down both servers.

---

## Deployment

### Vercel Multi-Service
This repository supports deploying the frontend and backend together on Vercel using `vercel.json` experimental multi-services.

1.  Deploy the root directory to Vercel.
2.  Set the following environment variable on Vercel for the frontend service to align endpoints:
    *   `VITE_API_BASE=/_/backend/api`
3.  Vercel will build and route client requests automatically.

