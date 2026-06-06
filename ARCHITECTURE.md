# AeroPDF Architecture & Production Refactoring Guide

This document contains full specifications of the AeroPDF editor system design, data schemas, API routes, coordinate-mapping math, and a blueprint for a downstream developer/AI to scale this code to a highly resilient production-grade enterprise platform.

---

## 1. System Topology & Flow

AeroPDF utilizes a decoupled system design:
*   **Vite + React (Frontend Client)**: Manages rendering logic, UI element coordinate layouts, and runs client-side OCR using WebAssembly to minimize host requirements.
*   **FastAPI + PyMuPDF (Backend Core)**: Handles intensive PDF byte-stream manipulations, text redactions, and fonts mapping.

```
+---------------------------------------------------------------------------------+
|                                 CLIENT VIEWPORT                                 |
|                                                                                 |
|  [ File Dropzone ] ---> [ PDF.js Renderer ] ---> [ absolute coordinates overlays ]|
|                                |                              ^                 |
|                             Upload                         Inspect              |
|                                v                              |                 |
+---------------------------------------------------------------+-----------------+
                                 |                              |
                             HTTP POST                       HTTP GET
                                 v                              |
+---------------------------------------------------------------+-----------------+
|                             FASTAPI CORE BACKEND                                |
|                                                                                 |
|        [ /api/upload ] ---> [ PyMuPDF Layout Parsing ] ---> JSON coordinate map |
|        [ /api/edit-block ] -> [ Redaction Annotation ] ---> [ TextBox Reflow ]   |
+---------------------------------------------------------------------------------+
```

---

## 2. Coordinate Mapping & Visual Overlay Alignment

### The Mapping Problem
PDF coordinate points are written using absolute positions. PyMuPDF extracts text coordinates with the origin `(0,0)` at the **top-left corner**, matching standard browser canvas models.
However, because the PDF.js viewport rendering is scalable, overlay boxes must scale dynamically in CSS.

### Coordinate Mapping Formula
Let:
*   $W_{pdf}$ = Original width of the PDF page.
*   $H_{pdf}$ = Original height of the PDF page.
*   $W_{canvas}$ = Rendered canvas width in the browser.
*   $S$ = Scale factor calculated as:
    $$S = \frac{W_{canvas}}{W_{pdf}}$$
*   $x_0, y_0, x_1, y_1$ = Raw bounding box coordinates extracted from PyMuPDF.

The CSS styling properties for absolute overlay `div` boxes are computed as:
*   `left` = $x_0 \times S$ px
*   `top` = $y_0 \times S$ px
*   `width` = $(x_1 - x_0) \times S$ px
*   `height` = $(y_1 - y_0) \times S$ px
*   `fontSize` = $size_{original} \times S$ px

---

## 3. Text Reflow Mechanics (Scenario A)

PDF streams do not wrap text dynamically. If text length changes, downstream text does not shift naturally. 

To solve this:
1.  **Block Extraction**: The backend uses PyMuPDF's block-detection structures to group lines into cohesive paragraphs.
2.  **HTML Overlays**: The overlay layers render these blocks. When edited, the UI uses standard HTML content wrapping.
3.  **Reflow Redraw**: Upon saving:
    *   The backend overlays a **redaction block** (fill with page background color, usually white) over the coordinates to erase the original text layout completely.
    *   The backend calls PyMuPDF's `insert_textbox` using the new text. `insert_textbox` automatically performs line-wrapping calculations matching the boundaries of the original bounding box.

---

## 4. Client-Side OCR Pipeline (Scenario B)

To run heavy OCR tasks without triggering server timeouts or freezing browser UI threads:
1.  **Web Workers Isolation**: Tesseract.js is initialized inside Web Workers.
2.  **Image Source Extraction**: The frontend grabs the high-resolution canvas bitmap using `canvas.toDataURL()`.
3.  **Coordinate Mapping Conversion**:
    *   Tesseract returns bounding boxes in canvas pixel coordinates.
    *   The client maps canvas coordinates back to PDF point dimensions by multiplying coordinates by $\frac{1}{S}$, making them fully editable on the overlay.

---

## 5. API Reference Manual

### 1. File Upload
*   **Route**: `POST /api/upload`
*   **Payload**: Multipart Form (`file: File`)
*   **Response**:
    ```json
    {
      "session_id": "uuid-string",
      "filename": "document.pdf",
      "metadata": { "title": "string", "author": "string", "pages": 12 },
      "pages": [
        {
          "number": 1,
          "width": 612,
          "height": 792,
          "blocks": [
            {
              "bbox": [x0, y0, x1, y1],
              "lines": [
                {
                  "bbox": [x0, y0, x1, y1],
                  "spans": [
                    { "text": "Hello", "bbox": [x0, y0, x1, y1], "font": "Arial", "size": 12, "color": "#000000" }
                  ]
                }
              ]
            }
          ],
          "images": []
        }
      ]
    }
    ```

### 2. Block Editing (Reflow Text)
*   **Route**: `POST /api/edit-block/{session_id}`
*   **Payload**:
    ```json
    {
      "page_number": 1,
      "original_bbox": [x0, y0, x1, y1],
      "new_text": "Updated paragraph content...",
      "font_size": 12.0,
      "font_name": "Helvetica",
      "hex_color": "#000000"
    }
    ```
*   **Response**: Fresh layout schema containing recalculated pages coordinates: `{ "success": true, "pages": [...] }`.

### 3. Command AI Execution
*   **Route**: `POST /api/command/{session_id}`
*   **Payload**: `{ "command": "replace \"draft\" with \"final\" on page 1" }`
*   **Response**: `{ "success": true, "message": "Result log...", "pages": [...] }`

---

## 6. Blueprint to Scale for Production Grade

To upgrade this prototype to a highly scalable, multi-tenant enterprise system:

### 1. Decoupled Worker Queue (Celery + Redis)
For heavy OCR and multi-page flattening:
*   Refactor FastAPI routes to offload tasks to **Celery workers** backed by a **Redis broker**.
*   FastAPI should immediately return a `job_id` with HTTP 202 status.
*   Frontend client polls job status or listens to updates via WebSockets.

### 2. Distributed Object Storage (S3)
*   Do not save PDFs on local server storage.
*   Upon upload, generate an **S3 Pre-signed URL** for direct client-to-bucket upload.
*   Workers download PDF pages from S3 and upload final results with signed download URLs.

### 3. PostgreSQL Database
*   Replace the in-memory `sessions` dictionary with a relational database (e.g., PostgreSQL).
*   Create tables for `users`, `sessions`, `jobs`, and `document_history` (for Undo/Redo features).

### 4. Advanced OCR (AWS Textract / DocAI)
*   Integrate cloud OCR solutions like **AWS Textract** or **Google Cloud Document AI** inside Celery workers for layout analysis, column grouping, and tables parsing.

### 5. Font Extraction
*   For custom embedded fonts, write a backend utility to extract embedded font streams (using PyMuPDF `doc.extract_font()`) and serve them dynamically as base64 CSS font resources to the browser client.

---

## 7. Vercel Multi-Service Deployment

To deploy both frontend (Vite React) and backend (FastAPI) together as separate services on Vercel:

1.  **Vercel Configuration**:
    Create a `vercel.json` file in the root workspace folder:
    ```json
    {
        "experimentalServices": {
            "frontend": {
                "root": "frontend",
                "routePrefix": "/",
                "framework": "vite"
            },
            "backend": {
                "root": "backend",
                "routePrefix": "/_/backend"
            }
        }
    }
    ```
2.  **API Routing Alignment**:
    *   The frontend environment variable `VITE_API_BASE` is utilized to direct HTTP requests dynamically.
    *   For local dev server proxying, `VITE_API_BASE` defaults to `/api`.
    *   During Vercel production builds, specify the environment parameter:
        `VITE_API_BASE=/_/backend/api`
    *   This forces client calls (e.g. upload, edit, download) to point to `/_/backend/api/...` which Vercel routes automatically to the FastAPI backend service `/api/...` context.

