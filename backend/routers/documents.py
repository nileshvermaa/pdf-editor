"""Document lifecycle routes: upload, download, status, delete."""
from __future__ import annotations

import fitz
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse

from config import settings
from deps import get_session_or_404, session_manager
from logging_config import get_logger
from schemas import HistoryState, UploadResponse

router = APIRouter(prefix="/api", tags=["documents"])
log = get_logger("routers.documents")


def _validate_pdf(file_bytes: bytes) -> int:
    """Open the bytes to confirm a real, usable PDF. Returns page count."""
    try:
        doc = fitz.open(stream=file_bytes, filetype="pdf")
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Not a valid PDF: {exc}") from exc
    try:
        if doc.is_encrypted and not doc.authenticate(""):
            raise HTTPException(status_code=422, detail="Password-protected PDFs are not supported.")
        if doc.page_count == 0:
            raise HTTPException(status_code=422, detail="PDF has no pages.")
        if doc.page_count > settings.max_pages:
            raise HTTPException(
                status_code=422,
                detail=f"PDF has {doc.page_count} pages; limit is {settings.max_pages}.",
            )
        return doc.page_count
    finally:
        doc.close()


@router.post("/upload", response_model=UploadResponse)
async def upload_pdf(file: UploadFile = File(...)):
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    if len(file_bytes) > settings.max_file_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"File exceeds the {settings.max_file_mb} MB limit.",
        )

    await run_in_threadpool(_validate_pdf, file_bytes)
    session = await run_in_threadpool(session_manager.create, file_bytes, file.filename)
    data = await run_in_threadpool(session_manager.extract, session.session_id)

    log.info("Uploaded '%s' as session %s (%d pages)", file.filename, session.session_id, data["metadata"]["pages"])
    return UploadResponse(
        session_id=session.session_id,
        filename=session.filename,
        metadata=data["metadata"],
        pages=data["pages"],
        history=HistoryState(**session.history_state()),
    )


@router.get("/file/{session_id}")
async def raw_file(session_id: str):
    """Serve the raw current version for canvas rendering.

    Unlike /download this never flattens: overlay objects are drawn live by
    the frontend object layer, so baking them into the served bytes would
    double-render every object on the canvas.
    """
    session = get_session_or_404(session_id)
    return FileResponse(
        session.current_path,
        media_type="application/pdf",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/download/{session_id}")
async def download_file(session_id: str):
    session = get_session_or_404(session_id)
    name = session.filename if session.filename.lower().endswith(".pdf") else "edited_document.pdf"
    path = await run_in_threadpool(session_manager.export_path, session_id)
    return FileResponse(
        path,
        media_type="application/pdf",
        filename=name,
        headers={"Cache-Control": "no-store"},  # always serve the latest version
    )


@router.delete("/session/{session_id}")
async def delete_session(session_id: str):
    get_session_or_404(session_id)
    await run_in_threadpool(session_manager.delete, session_id)
    return {"success": True, "message": "Session deleted."}
