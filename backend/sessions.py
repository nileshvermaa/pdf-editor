"""
Session and version management for PDFs plus editor overlay objects.
"""
from __future__ import annotations

import json
import os
import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Tuple

import fitz

from config import settings
from logging_config import get_logger
from pdf_engine import extract_pdf_data, flatten_objects

log = get_logger("sessions")

MANIFEST = "manifest.json"
VERSIONS_DIR = "versions"
OBJECT_VERSIONS_DIR = "object_versions"
ASSETS_DIR = "assets"
EXPORTS_DIR = "exports"


@dataclass
class Session:
    session_id: str
    filename: str
    directory: str
    versions: List[str] = field(default_factory=list)
    object_versions: List[str] = field(default_factory=list)
    index: int = 0
    created: float = field(default_factory=lambda: 0.0)
    updated: float = field(default_factory=lambda: 0.0)
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    @property
    def current_path(self) -> str:
        return self.versions[self.index]

    @property
    def current_objects_path(self) -> str:
        return self.object_versions[self.index]

    @property
    def can_undo(self) -> bool:
        return self.index > 0

    @property
    def can_redo(self) -> bool:
        return self.index < len(self.versions) - 1

    def history_state(self) -> Dict[str, object]:
        return {
            "can_undo": self.can_undo,
            "can_redo": self.can_redo,
            "version": self.index,
            "total_versions": len(self.versions),
        }

    def _manifest_path(self) -> str:
        return os.path.join(self.directory, MANIFEST)

    def save_manifest(self) -> None:
        data = {
            "session_id": self.session_id,
            "filename": self.filename,
            "versions": [os.path.basename(v) for v in self.versions],
            "object_versions": [os.path.basename(v) for v in self.object_versions],
            "index": self.index,
            "created": self.created,
            "updated": self.updated,
        }
        tmp = self._manifest_path() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        os.replace(tmp, self._manifest_path())


class SessionError(Exception):
    """Raised for missing sessions or invalid history moves."""


class SessionManager:
    def __init__(self, now: Callable[[], float] = time.time) -> None:
        self._sessions: Dict[str, Session] = {}
        self._global_lock = threading.Lock()
        self._now = now
        try:
            os.makedirs(settings.temp_dir, exist_ok=True)
            self._load_existing()
        except OSError as exc:
            log.error("Could not initialise session storage at %s: %s", settings.temp_dir, exc)

    def _load_existing(self) -> None:
        for name in os.listdir(settings.temp_dir):
            directory = os.path.join(settings.temp_dir, name)
            manifest = os.path.join(directory, MANIFEST)
            if not os.path.isfile(manifest):
                continue
            try:
                with open(manifest, encoding="utf-8") as fh:
                    data = json.load(fh)
                vdir = os.path.join(directory, VERSIONS_DIR)
                versions = [os.path.join(vdir, v) for v in data["versions"]]
                if not all(os.path.isfile(v) for v in versions):
                    raise FileNotFoundError("missing version file")
                object_versions = self._load_object_versions(directory, versions, data.get("object_versions"))
                self._sessions[data["session_id"]] = Session(
                    session_id=data["session_id"],
                    filename=data["filename"],
                    directory=directory,
                    versions=versions,
                    object_versions=object_versions,
                    index=data["index"],
                    created=data.get("created", self._now()),
                    updated=data.get("updated", self._now()),
                )
            except Exception as exc:
                log.warning("Skipping unreadable session dir %s: %s", name, exc)
        self.purge_expired()
        log.info("Loaded %d persisted session(s)", len(self._sessions))

    def create(self, file_bytes: bytes, filename: str) -> Session:
        session_id = str(uuid.uuid4())
        directory = os.path.join(settings.temp_dir, session_id)
        vdir = os.path.join(directory, VERSIONS_DIR)
        odir = os.path.join(directory, OBJECT_VERSIONS_DIR)
        os.makedirs(vdir, exist_ok=True)
        os.makedirs(odir, exist_ok=True)
        os.makedirs(os.path.join(directory, ASSETS_DIR), exist_ok=True)
        os.makedirs(os.path.join(directory, EXPORTS_DIR), exist_ok=True)

        v0 = os.path.join(vdir, "0000.pdf")
        o0 = os.path.join(odir, "0000.json")
        with open(v0, "wb") as fh:
            fh.write(file_bytes)
        self._write_objects(o0, [])

        now = self._now()
        sess = Session(
            session_id=session_id,
            filename=filename,
            directory=directory,
            versions=[v0],
            object_versions=[o0],
            index=0,
            created=now,
            updated=now,
        )
        sess.save_manifest()
        with self._global_lock:
            self._sessions[session_id] = sess
        return sess

    def get(self, session_id: str) -> Session:
        sess = self._sessions.get(session_id)
        if sess is None:
            raise SessionError("Session not found")
        return sess

    def delete(self, session_id: str) -> None:
        with self._global_lock:
            sess = self._sessions.pop(session_id, None)
        if sess and os.path.isdir(sess.directory):
            shutil.rmtree(sess.directory, ignore_errors=True)

    def mutate(self, session_id: str, mutator: Callable[[fitz.Document], object]) -> Tuple[Session, object]:
        sess = self.get(session_id)
        with sess.lock:
            doc = fitz.open(sess.current_path)
            try:
                result = mutator(doc)
                new_path = self._next_version_path(sess)
                new_objects_path = self._next_object_version_path(sess)
                doc.save(new_path, garbage=4, deflate=True)
                self._clone_objects(sess.current_objects_path, new_objects_path)
            finally:
                doc.close()
            self._commit_version(sess, new_path, new_objects_path)
            return sess, result

    def mutate_objects(
        self,
        session_id: str,
        mutator: Callable[[List[Dict[str, Any]]], object],
    ) -> Tuple[Session, object]:
        sess = self.get(session_id)
        with sess.lock:
            objects = self._read_objects(sess.current_objects_path)
            result = mutator(objects)
            new_path = self._next_version_path(sess)
            new_objects_path = self._next_object_version_path(sess)
            shutil.copyfile(sess.current_path, new_path)
            self._write_objects(new_objects_path, objects)
            self._commit_version(sess, new_path, new_objects_path)
            return sess, result

    def undo(self, session_id: str) -> Session:
        sess = self.get(session_id)
        with sess.lock:
            if not sess.can_undo:
                raise SessionError("Nothing to undo")
            sess.index -= 1
            sess.updated = self._now()
            sess.save_manifest()
        return sess

    def redo(self, session_id: str) -> Session:
        sess = self.get(session_id)
        with sess.lock:
            if not sess.can_redo:
                raise SessionError("Nothing to redo")
            sess.index += 1
            sess.updated = self._now()
            sess.save_manifest()
        return sess

    def extract(self, session_id: str) -> Dict[str, object]:
        sess = self.get(session_id)
        with sess.lock:
            doc = fitz.open(sess.current_path)
            try:
                data = extract_pdf_data(doc)
            finally:
                doc.close()
            objects = self._read_objects(sess.current_objects_path)
            grouped: Dict[int, List[Dict[str, Any]]] = {}
            for obj in objects:
                grouped.setdefault(int(obj["page_number"]), []).append(obj)
            for page in data["pages"]:
                page["objects"] = sorted(grouped.get(page["number"], []), key=lambda item: item.get("z_index", 0))
            return data

    def load_objects(self, session_id: str) -> List[Dict[str, Any]]:
        sess = self.get(session_id)
        with sess.lock:
            return self._read_objects(sess.current_objects_path)

    def store_asset(self, session_id: str, filename: str, data: bytes) -> str:
        sess = self.get(session_id)
        ext = Path(filename or "").suffix.lower() or ".bin"
        asset_id = f"{uuid.uuid4().hex}{ext}"
        path = os.path.join(sess.directory, ASSETS_DIR, asset_id)
        with open(path, "wb") as fh:
            fh.write(data)
        return asset_id

    def asset_path(self, session_id: str, asset_id: str) -> str:
        sess = self.get(session_id)
        return self._asset_path_for_session(sess, asset_id)

    def flatten(self, session_id: str) -> Session:
        sess = self.get(session_id)
        with sess.lock:
            objects = self._read_objects(sess.current_objects_path)
            if not objects:
                return sess
            doc = fitz.open(sess.current_path)
            try:
                flatten_objects(doc, objects, lambda asset_id: self._asset_path_for_session(sess, asset_id))
                new_path = self._next_version_path(sess)
                new_objects_path = self._next_object_version_path(sess)
                doc.save(new_path, garbage=4, deflate=True)
                self._write_objects(new_objects_path, [])
            finally:
                doc.close()
            self._commit_version(sess, new_path, new_objects_path)
            return sess

    def extract_pages_path(self, session_id: str, page_numbers: List[int]) -> str:
        """Save a NEW PDF containing only ``page_numbers`` and return its path.

        Operates on a throwaway open of the current version — the session's own
        document and history are untouched.
        """
        from pdf_engine import extract_pages as _extract

        sess = self.get(session_id)
        with sess.lock:
            doc = fitz.open(sess.current_path)
            try:
                _extract(doc, page_numbers)
                out = os.path.join(sess.directory, EXPORTS_DIR, f"extract-{sess.index:04d}.pdf")
                doc.save(out, garbage=4, deflate=True)
                return out
            finally:
                doc.close()

    def export_path(self, session_id: str) -> str:
        sess = self.get(session_id)
        with sess.lock:
            objects = self._read_objects(sess.current_objects_path)
            if not objects:
                return sess.current_path
            doc = fitz.open(sess.current_path)
            try:
                flatten_objects(doc, objects, lambda asset_id: self._asset_path_for_session(sess, asset_id))
                export_path = os.path.join(sess.directory, EXPORTS_DIR, f"download-{sess.index:04d}.pdf")
                doc.save(export_path, garbage=4, deflate=True)
                return export_path
            finally:
                doc.close()

    def _next_version_path(self, sess: Session) -> str:
        existing = [int(os.path.splitext(os.path.basename(v))[0]) for v in sess.versions]
        n = (max(existing) + 1) if existing else 0
        return os.path.join(sess.directory, VERSIONS_DIR, f"{n:04d}.pdf")

    def _next_object_version_path(self, sess: Session) -> str:
        existing = [int(os.path.splitext(os.path.basename(v))[0]) for v in sess.object_versions]
        n = (max(existing) + 1) if existing else 0
        return os.path.join(sess.directory, OBJECT_VERSIONS_DIR, f"{n:04d}.json")

    def _commit_version(self, sess: Session, new_path: str, new_objects_path: str) -> None:
        for stale_pdf, stale_objects in zip(sess.versions[sess.index + 1 :], sess.object_versions[sess.index + 1 :]):
            self._remove_path(stale_pdf)
            self._remove_path(stale_objects)
        sess.versions = sess.versions[: sess.index + 1] + [new_path]
        sess.object_versions = sess.object_versions[: sess.index + 1] + [new_objects_path]
        sess.index = len(sess.versions) - 1

        overflow = len(sess.versions) - settings.max_history_versions
        if overflow > 0:
            for stale_pdf, stale_objects in zip(sess.versions[:overflow], sess.object_versions[:overflow]):
                self._remove_path(stale_pdf)
                self._remove_path(stale_objects)
            sess.versions = sess.versions[overflow:]
            sess.object_versions = sess.object_versions[overflow:]
            sess.index -= overflow

        sess.updated = self._now()
        sess.save_manifest()

    def purge_expired(self) -> int:
        ttl = settings.session_ttl_hours * 3600
        cutoff = self._now() - ttl
        expired = [sid for sid, s in self._sessions.items() if s.updated < cutoff]
        for sid in expired:
            log.info("Purging expired session %s", sid)
            self.delete(sid)
        return len(expired)

    def _load_object_versions(
        self,
        directory: str,
        versions: List[str],
        raw_object_versions: List[str] | None,
    ) -> List[str]:
        odir = os.path.join(directory, OBJECT_VERSIONS_DIR)
        os.makedirs(odir, exist_ok=True)
        if raw_object_versions:
            object_versions = [os.path.join(odir, name) for name in raw_object_versions]
            if not all(os.path.isfile(path) for path in object_versions):
                raise FileNotFoundError("missing object version file")
            if len(object_versions) != len(versions):
                raise ValueError("object version history length mismatch")
            return object_versions

        object_versions: List[str] = []
        for version in versions:
            base = os.path.splitext(os.path.basename(version))[0]
            path = os.path.join(odir, f"{base}.json")
            if not os.path.isfile(path):
                self._write_objects(path, [])
            object_versions.append(path)
        return object_versions

    def _clone_objects(self, source: str, target: str) -> None:
        self._write_objects(target, self._read_objects(source))

    def _read_objects(self, path: str) -> List[Dict[str, Any]]:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, list):
            raise ValueError("object version must contain a list")
        return [dict(item) for item in data]

    def _write_objects(self, path: str, objects: List[Dict[str, Any]]) -> None:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(objects, fh)
        os.replace(tmp, path)

    def _asset_path_for_session(self, sess: Session, asset_id: str) -> str:
        target = os.path.join(sess.directory, ASSETS_DIR, asset_id)
        if not os.path.isfile(target):
            raise SessionError("Asset not found")
        return target

    def _remove_path(self, path: str) -> None:
        try:
            os.remove(path)
        except OSError:
            pass
