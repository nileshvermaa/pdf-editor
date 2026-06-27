# AeroPDF Functionality Roadmap

> A phased plan to evolve AeroPDF from a capable single-user editor into a
> full-featured, collaborative PDF platform. Grounded in the 2026 web-PDF-editor
> feature bar (Sejda / Smallpdf / Acrobat) and the real capabilities of the
> current stack (PDF.js + PyMuPDF + FastAPI).

**Effort legend:** S (≤2 days) · M (≈1 week) · L (2 weeks+) · XL (multi-week / research).
**Area:** FE = frontend, BE = backend.

---

## Where we are today

Already shipped:

- Upload, render (PDF.js), thumbnails, zoom (50–250%, keyboard + Ctrl-scroll).
- Direct text editing (redaction + reinsertion), find & replace.
- Overlay objects: text, comment, signature (text), image, shapes (rect/circle/line/arrow).
- OCR for scanned pages (Tesseract.js → persisted server-side).
- Page ops: rotate, delete, reorder (API), duplicate, insert blank.
- Undo/redo with aligned PDF + object version history.
- Natural-language command bar, flatten + export.
- A24-inspired theme.

Known limitations (the roadmap below targets these):

- Resize/rotate are inspector-driven, not drag-handle interactions.
- No inline (on-canvas) text editing, multi-select, snapping, or object copy/paste.
- Sessions live on local disk → ephemeral on serverless; no accounts/library/collab.
- "Signature" is italic text only — no draw pad and no cryptographic signing.
- Fonts collapse to base-14 (brand fonts lost); no true reflow; existing vector
  graphics aren't editable.
- No merge/split/extract, forms, conversion, or AI features.

---

## Phase 0 — Storage & identity backbone *(foundational)*

**Why first:** sessions today live on local disk and die on serverless cold
starts. The library, sharing, and collaboration phases are impossible without
durable, shared storage. Decoupling now avoids reworking everything later.

- Move version snapshots + assets to object storage (S3 / Cloudflare R2).
- Move the session/manifest index to Postgres; move locks to Redis (replaces the
  in-process `threading.Lock` in `sessions.py`).
- Keep the anonymous flow working; add *optional* accounts (full auth → Phase 7).

**Approach:** introduce a `StorageBackend` abstraction behind `SessionManager`;
keep the local-disk implementation as the dev default.
**Effort:** L · **Risk:** medium (touches the core seam, but well-isolated).

---

## Phase 1 — Editing UX polish *(highest immediate value, FE-heavy)*

The engine is solid; the *interaction* model is the weak point users feel.

- **Drag-resize handles** (the 8 handles already render — wire them) + **rotate handle**.
- **Inline canvas text editing** — double-click to edit in place, not via the side panel.
- **Multi-select + group move/align**, **snapping & alignment guides**.
- **Copy / paste / duplicate objects**, **arrow-key nudge**, richer context toolbar.

**Approach:** mostly `PDFCanvas.tsx` + the object model. As interactions grow,
introduce a small state store (e.g. Zustand) to tame `App.tsx`.
**Effort:** M–L · **Risk:** low.

---

## Phase 2 — Document & page operations *(strong value, BE-mostly)*

Table-stakes features competitors all have and we lack.

- **Merge / split / extract pages**, **import pages from another PDF**.
- **Drag-reorder in the sidebar** (reorder is currently API-only).
- **Compress**, **watermark**, **Bates / page numbering**, **headers / footers**.

**Approach:** new `pdf_engine` functions + `routers/pages.py` additions; all fit
the existing `mutate()` + version-history model.
**Effort:** M · **Risk:** low.

---

## Phase 3 — Annotation & review layer

- Full markup: **highlight / underline / strikethrough / squiggly / freehand-ink /
  sticky notes / text callouts**, persisted as real PDF annotations.
- **Comments sidebar** with reply / resolve; annotations survive export.

**Approach:** extend `annotations.py` + the object model; PyMuPDF has native
annotation types.
**Effort:** M · **Risk:** low–medium.

---

## Phase 4 — Forms & real signatures *(differentiator)*

- **AcroForm fill** + **form-field creation/editing** (text, checkbox, radio,
  dropdown) + flatten. PyMuPDF supports this fully today — it's just unused.
- **Signatures:** today's "signature" is italic text. Add a **draw-pad +
  image-upload + typed** signature, then **cryptographic digital signatures (PAdES)**.

**Approach:** forms via PyMuPDF `Widget`. Crypto signing needs **pyHanko /
endesive** (PyMuPDF signatures are read-only) plus certificate handling.
**Effort:** L · **Risk:** medium (signing / cert UX is fiddly).

---

## Phase 5 — AI features *(2026 differentiator, can be pulled earlier)*

AI is now expected in PDF tools, and our text extraction already exists to power it.

- **Chat-with-PDF** (RAG over extracted text), **summarize**, **AI rewrite /
  find-and-fix**, **auto-redact PII** (regex + NER → existing redaction/`scrub`),
  **smarter OCR layout**.

**Approach:** Claude via the Anthropic API (latest model); reuse
`extract_pdf_data` output as context. Add streaming + cost controls.
**Effort:** M · **Risk:** low–medium.

---

## Phase 6 — Fidelity & content intelligence *(hard; do after basics)*

- **Embedded-font preservation / subsetting** (today we map to base-14 — a
  deliberate correctness tradeoff that loses brand fonts).
- **True paragraph reflow** on text edit, **table detection/editing**.
- **Reverse-map existing vector graphics into editable objects** — the hardest
  problem in the project.

**Effort:** XL · **Risk:** high (genuine research).

---

## Phase 7 — Accounts, library & collaboration *(depends on Phase 0)*

- **Auth** (consider Clerk / Auth0), **document library**, **share links +
  permissions**.
- **Real-time multi-user editing** (Yjs / CRDT over WebSocket) with presence.
- **Audit trail / named versions**.

**Effort:** XL · **Risk:** high (concurrent editing + version history is the deep end).

---

## Phase 8 — Conversion, scale & hardening *(ongoing)*

- **PDF ↔ Word / Excel / PPT / image** (LibreOffice-headless or Gotenberg).
- **PDF/A & PDF/UA** (archival / accessibility).
- **Async job queue** for heavy OCR / convert; **lazy page rendering + worker
  pool** for large docs.
- **Rate limiting / quotas, AV scanning, encryption at rest, monitoring**,
  **Playwright e2e** coverage (currently none).

**Effort:** L–XL · **Risk:** medium.

---

## Recommended sequencing

1. **Quick wins now → Phase 1 + Phase 2** (frontend/engine, no infra dependency,
   immediately visible). Start with **drag-resize handles + inline text editing** —
   biggest felt improvement for the least risk.
2. **Phase 0** to unblock the heavy stuff.
3. **Phase 3–4** for feature parity.
4. **Phase 5 (AI)** as the standout differentiator.
5. Treat **6–8** as longer research / scale tracks.

## Tech-stack notes

Keep PDF.js + PyMuPDF + FastAPI — the right core. Add only where needed:

- **pyHanko** — cryptographic signing (Phase 4).
- **Yjs + Redis** — collaboration / distributed locks (Phase 0/7).
- **R2 / S3 + Postgres** — durable storage (Phase 0).
- **Gotenberg / LibreOffice headless** — conversion (Phase 8).
- **Anthropic API** — AI features (Phase 5).
- **Zustand** (frontend) — once the object model outgrows `App.tsx` state (Phase 1).

## Sources

- [Nitro — Best PDF Editors 2026](https://www.gonitro.com/best-pdf-editors)
- [Guideflow — 15 best PDF editors](https://www.guideflow.com/blog/pdf-editors)
- [PC Tech Magazine — Best AI PDF Editors 2026](https://pctechmag.com/2026/06/best-ai-pdf-editors-for-students-professionals-and-businesses-in-2026/)
- [PyMuPDF — Widget / form fields](https://pymupdf.readthedocs.io/en/latest/widget.html)
- [PyMuPDF — signature fields discussion](https://github.com/pymupdf/PyMuPDF/discussions/3277)
