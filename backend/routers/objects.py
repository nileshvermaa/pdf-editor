"""Editable overlay object routes."""
from __future__ import annotations

import uuid
from typing import Any, Dict, List

import fitz
from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse

from deps import build_edit_response, get_session_or_404, session_manager
from schemas import (
    BatchDeleteRequest,
    BatchMoveRequest,
    EditResponse,
    EditorObjectCreateRequest,
    EditorObjectUpdateRequest,
    ObjectReorderRequest,
)

router = APIRouter(prefix="/api", tags=["objects"])


def _validate_object_bounds(session_id: str, page_number: int, bbox: List[float], allow_line: bool = False) -> None:
    session = session_manager.get(session_id)
    doc = fitz.open(session.current_path)
    try:
        if not 1 <= page_number <= doc.page_count:
            raise IndexError("Page number out of bounds")
        page = doc[page_number - 1]
        # Lines/arrows keep their direction in the bbox (start -> end), so
        # normalise before comparing against the page rectangle.
        x0, y0, x1, y1 = (float(v) for v in bbox)
        norm = fitz.Rect(min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))
        if allow_line:
            if x0 == x1 and y0 == y1:
                raise ValueError("Object bbox must span a visible area or line")
        elif norm.width <= 0 or norm.height <= 0:
            raise ValueError("Object bbox must have positive width and height")
        if norm.x0 < page.rect.x0 or norm.y0 < page.rect.y0 or norm.x1 > page.rect.x1 or norm.y1 > page.rect.y1:
            raise ValueError("Object bbox is outside page bounds")
    finally:
        doc.close()


def _find_object(objects: List[Dict[str, Any]], object_id: str) -> int:
    for idx, obj in enumerate(objects):
        if obj.get("id") == object_id:
            return idx
    raise ValueError("Object not found")


@router.post("/objects/{session_id}", response_model=EditResponse)
async def create_object(session_id: str, req: EditorObjectCreateRequest):
    get_session_or_404(session_id)

    def _mutate(objects: List[Dict[str, Any]]):
        _validate_object_bounds(
            session_id,
            req.page_number,
            req.bbox,
            allow_line=req.type == "shape" and req.shape_type in {"line", "arrow"},
        )
        obj = req.model_dump(exclude_none=True)
        obj["id"] = uuid.uuid4().hex
        obj["z_index"] = max((int(item.get("z_index", 0)) for item in objects), default=-1) + 1
        objects.append(obj)
        return obj

    try:
        session, created = await run_in_threadpool(session_manager.mutate_objects, session_id, _mutate)
    except (IndexError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await run_in_threadpool(build_edit_response, session, f"Added {created['type']}.")


@router.patch("/objects/{session_id}/{object_id}", response_model=EditResponse)
async def update_object(session_id: str, object_id: str, req: EditorObjectUpdateRequest):
    get_session_or_404(session_id)

    def _mutate(objects: List[Dict[str, Any]]):
        idx = _find_object(objects, object_id)
        current = dict(objects[idx])
        merged = {**current, **req.model_dump(exclude_none=True)}
        candidate = EditorObjectCreateRequest(**merged).model_dump(exclude_none=True)
        candidate["id"] = object_id
        _validate_object_bounds(
            session_id,
            candidate["page_number"],
            candidate["bbox"],
            allow_line=candidate["type"] == "shape" and candidate.get("shape_type") in {"line", "arrow"},
        )
        objects[idx] = candidate
        return candidate

    try:
        session, updated = await run_in_threadpool(session_manager.mutate_objects, session_id, _mutate)
    except (IndexError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await run_in_threadpool(build_edit_response, session, f"Updated {updated['type']}.")


@router.delete("/objects/{session_id}/{object_id}", response_model=EditResponse)
async def delete_object(session_id: str, object_id: str):
    get_session_or_404(session_id)

    def _mutate(objects: List[Dict[str, Any]]):
        idx = _find_object(objects, object_id)
        deleted = objects[idx]
        del objects[idx]
        return deleted

    try:
        session, deleted = await run_in_threadpool(session_manager.mutate_objects, session_id, _mutate)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return await run_in_threadpool(build_edit_response, session, f"Deleted {deleted['type']}.")


@router.post("/objects/{session_id}/batch-move", response_model=EditResponse)
async def batch_move(session_id: str, req: BatchMoveRequest):
    get_session_or_404(session_id)

    def _mutate(objects: List[Dict[str, Any]]):
        index = {obj["id"]: i for i, obj in enumerate(objects)}
        for mv in req.moves:
            if mv.id not in index:
                raise ValueError(f"Object not found: {mv.id}")
            obj = objects[index[mv.id]]
            allow_line = obj.get("type") == "shape" and obj.get("shape_type") in {"line", "arrow"}
            _validate_object_bounds(session_id, int(obj["page_number"]), mv.bbox, allow_line=allow_line)
            obj["bbox"] = [float(v) for v in mv.bbox]
        return len(req.moves)

    try:
        session, count = await run_in_threadpool(session_manager.mutate_objects, session_id, _mutate)
    except (IndexError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await run_in_threadpool(build_edit_response, session, f"Moved {count} object(s).")


@router.post("/objects/{session_id}/batch-delete", response_model=EditResponse)
async def batch_delete(session_id: str, req: BatchDeleteRequest):
    get_session_or_404(session_id)

    def _mutate(objects: List[Dict[str, Any]]):
        wanted = set(req.ids)
        kept = [obj for obj in objects if obj["id"] not in wanted]
        removed = len(objects) - len(kept)
        if removed == 0:
            raise ValueError("No matching objects to delete")
        objects[:] = kept
        return removed

    try:
        session, count = await run_in_threadpool(session_manager.mutate_objects, session_id, _mutate)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return await run_in_threadpool(build_edit_response, session, f"Deleted {count} object(s).")


@router.post("/objects/{session_id}/reorder", response_model=EditResponse)
async def reorder_objects(session_id: str, req: ObjectReorderRequest):
    get_session_or_404(session_id)

    def _mutate(objects: List[Dict[str, Any]]):
        known = {obj["id"] for obj in objects}
        missing = [oid for oid in req.object_ids if oid not in known]
        if missing:
            raise ValueError("One or more objects do not exist")
        order = {oid: idx for idx, oid in enumerate(req.object_ids)}
        objects.sort(key=lambda item: (order.get(item["id"], len(order) + int(item.get("z_index", 0))), int(item.get("z_index", 0))))
        for idx, obj in enumerate(objects):
            obj["z_index"] = idx
        return None

    try:
        session, _ = await run_in_threadpool(session_manager.mutate_objects, session_id, _mutate)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await run_in_threadpool(build_edit_response, session, "Reordered objects.")


@router.post("/flatten/{session_id}", response_model=EditResponse)
async def flatten(session_id: str):
    get_session_or_404(session_id)
    had_objects = bool(await run_in_threadpool(session_manager.load_objects, session_id))
    try:
        session = await run_in_threadpool(session_manager.flatten, session_id)
    except (IndexError, ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    message = "Flattened editor objects into the PDF." if had_objects else "No editor objects to flatten."
    return await run_in_threadpool(build_edit_response, session, message)


@router.get("/assets/{session_id}/{asset_id}")
async def get_asset(session_id: str, asset_id: str):
    get_session_or_404(session_id)
    try:
        path = await run_in_threadpool(session_manager.asset_path, session_id, asset_id)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return FileResponse(path, headers={"Cache-Control": "no-store"})
