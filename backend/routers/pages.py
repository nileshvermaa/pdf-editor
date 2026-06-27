"""Page-level structural operations: rotate, delete, reorder, duplicate, insert, merge."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool

import pdf_engine as engine
from config import settings
from deps import build_edit_response, get_session_or_404, session_manager
from schemas import (
    DeletePagesRequest,
    DuplicatePageRequest,
    EditResponse,
    InsertBlankRequest,
    ReorderRequest,
    RotateRequest,
)

router = APIRouter(prefix="/api/pages", tags=["pages"])


async def _run(session_id: str, mutate, message: str) -> EditResponse:
    get_session_or_404(session_id)
    try:
        session, _ = await run_in_threadpool(session_manager.mutate, session_id, mutate)
    except (IndexError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await run_in_threadpool(build_edit_response, session, message)


@router.post("/rotate/{session_id}", response_model=EditResponse)
async def rotate(session_id: str, req: RotateRequest):
    return await _run(
        session_id,
        lambda doc: engine.rotate_pages(doc, req.page_numbers, req.degrees),
        f"Rotated by {req.degrees}°.",
    )


@router.post("/delete/{session_id}", response_model=EditResponse)
async def delete(session_id: str, req: DeletePagesRequest):
    return await _run(
        session_id,
        lambda doc: engine.delete_pages(doc, req.page_numbers),
        f"Deleted {len(req.page_numbers)} page(s).",
    )


@router.post("/reorder/{session_id}", response_model=EditResponse)
async def reorder(session_id: str, req: ReorderRequest):
    return await _run(session_id, lambda doc: engine.reorder_pages(doc, req.order), "Pages reordered.")


@router.post("/duplicate/{session_id}", response_model=EditResponse)
async def duplicate(session_id: str, req: DuplicatePageRequest):
    return await _run(
        session_id,
        lambda doc: engine.duplicate_page(doc, req.page_number),
        f"Duplicated page {req.page_number}.",
    )


@router.post("/insert-blank/{session_id}", response_model=EditResponse)
async def insert_blank(session_id: str, req: InsertBlankRequest):
    return await _run(
        session_id,
        lambda doc: engine.insert_blank_page(doc, req.after_page, req.width, req.height),
        "Inserted blank page.",
    )


@router.post("/merge/{session_id}", response_model=EditResponse)
async def merge(
    session_id: str,
    file: UploadFile = File(...),
    after_page: Optional[int] = Form(default=None),
):
    """Insert every page of an uploaded PDF after ``after_page`` (1-based; omit to append)."""
    get_session_or_404(session_id)
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files can be merged.")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="The PDF to insert is empty.")
    if len(data) > settings.max_file_bytes:
        raise HTTPException(status_code=413, detail=f"File exceeds the {settings.max_file_mb} MB limit.")

    inserted: list = []

    def _mutate(doc):
        inserted.append(engine.merge_pdf(doc, data, after_page, settings.max_pages))

    try:
        session, _ = await run_in_threadpool(session_manager.mutate, session_id, _mutate)
    except (IndexError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    n = inserted[0] if inserted else 0
    return await run_in_threadpool(build_edit_response, session, f"Inserted {n} page(s) from '{file.filename}'.")
