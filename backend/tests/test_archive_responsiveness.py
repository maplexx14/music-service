"""A delayed archive database operation must leave unrelated API requests running."""

import asyncio
import threading
from unittest.mock import AsyncMock

import httpx
import pytest

from app import external_archive
from app.main import app
from app.models import Track
from app.routers import ytdlp
from tests.conftest import TestingSessionLocal


class _DatabaseGate:
    def __init__(self):
        self.started = threading.Event()
        self.resume = threading.Event()
        self.released = []

    def wrap(self, operation):
        def delayed(*args, **kwargs):
            self.started.set()
            self.released.append(self.resume.wait(3))
            return operation(*args, **kwargs)
        return delayed


async def _health_while_waiting(operation, gate):
    job = asyncio.create_task(operation)
    try:
        assert await asyncio.to_thread(gate.started.wait, 3), "archive never reached the database"
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            response = await client.get("/api/health")
        assert response.status_code == 200
        assert not job.done(), "health could only run after the archive finished"
    finally:
        gate.resume.set()
        result = await job
    assert gate.released and all(gate.released), "database wait blocked the API event loop"
    return result


def _track(db):
    track = Track(title="Archive", artist="Artist", duration=180, source="ytmusic", external_id="archive-test")
    db.add(track)
    db.commit()
    return track


def _patch_upload(monkeypatch, tmp_path):
    path = tmp_path / "audio.m4a"
    path.write_bytes(b"audio")
    monkeypatch.setattr(external_archive.storage, "is_minio_backend", lambda: True)
    monkeypatch.setattr(external_archive.storage, "ensure_buckets", lambda: None)
    monkeypatch.setattr(external_archive.storage, "upload_music_file", lambda *args: ("minio://music/new.m4a", 5))
    monkeypatch.setattr(external_archive, "analyze_file", lambda path: {"energy": 0.5})
    monkeypatch.setattr(external_archive, "transcode_to_aac", lambda path: path)
    monkeypatch.setattr(external_archive, "_note_archived", AsyncMock())
    monkeypatch.setattr(external_archive, "_note_acoustic_features", AsyncMock())
    monkeypatch.setattr(external_archive, "_archive_cover", AsyncMock(return_value="/api/tracks/cover/new.jpg"))
    monkeypatch.setattr(external_archive, "_download_to_temp", AsyncMock(return_value=(str(path), 5)))
    monkeypatch.setattr(external_archive, "_resolve_for_track", AsyncMock(return_value=("https://cdn.example/audio", ".m4a", 5)))
    monkeypatch.setattr(ytdlp, "_resolve_cached", AsyncMock(return_value=("https://cdn.example/audio", ".m4a", 5, True)))
    return path


@pytest.mark.parametrize("method", ["execute", "commit", "rollback", "close"])
def test_adopting_file_keeps_api_running_during_database_wait(monkeypatch, db, tmp_path, method):
    track = _track(db)
    track_id = track.id
    path = _patch_upload(monkeypatch, tmp_path)
    gate = _DatabaseGate()

    def session():
        database = TestingSessionLocal()
        monkeypatch.setattr(database, method, gate.wrap(getattr(database, method)))
        if method == "rollback":
            def failed_commit():
                raise RuntimeError("database rejected commit")
            monkeypatch.setattr(database, "commit", failed_commit)
        return database

    monkeypatch.setattr(external_archive, "SessionLocal", session)
    result = asyncio.run(_health_while_waiting(
        external_archive.adopt_local_file("ytmusic", "archive-test", str(path)), gate
    ))
    assert result == "minio://music/new.m4a"
    db.expire_all()
    stored = db.get(Track, track_id)
    if method == "rollback":
        assert stored.file_path is None
    else:
        assert stored.file_path == result
        assert stored.file_size == 5
        assert stored.acoustic_features == {"energy": 0.5}


@pytest.mark.parametrize("entry, method", [
    ("track", "get"), ("track", "close"),
    ("external", "commit"), ("external", "close"),
])
def test_archive_scheduler_keeps_api_running_during_database_wait(monkeypatch, db, entry, method):
    track = _track(db)
    track_id = track.id
    gate = _DatabaseGate()

    def session():
        database = TestingSessionLocal()
        monkeypatch.setattr(database, method, gate.wrap(getattr(database, method)))
        return database

    monkeypatch.setattr(external_archive, "SessionLocal", session)
    monkeypatch.setattr(external_archive.storage, "is_minio_backend", lambda: True)
    monkeypatch.setattr(external_archive, "get_cache_async", AsyncMock(return_value=None))
    monkeypatch.setattr(external_archive, "_deezer_serves", AsyncMock(return_value=False))
    monkeypatch.setattr(external_archive, "_lazy_sem", None)
    monkeypatch.setattr(external_archive, "archive_track", AsyncMock(return_value=(external_archive.ArchiveResult.ALREADY, None)))
    monkeypatch.setattr(ytdlp, "archived_music_path", AsyncMock(return_value="minio://music/existing.m4a"))
    operation = (external_archive.schedule_archive(track_id) if entry == "track" else
                 external_archive.schedule_archive_external("ytmusic", "archive-test"))
    asyncio.run(_health_while_waiting(operation, gate))
    if entry == "external":
        db.expire_all()
        assert db.get(Track, track_id).file_path == "minio://music/existing.m4a"


@pytest.mark.parametrize("entry", ["track", "external"])
@pytest.mark.parametrize("method", ["execute", "commit", "rollback"])
def test_archive_writes_and_expired_orm_reads_leave_api_running(monkeypatch, db, tmp_path, entry, method):
    track = _track(db)
    track_id = track.id
    _patch_upload(monkeypatch, tmp_path)
    gate = _DatabaseGate()
    monkeypatch.setattr(db, method, gate.wrap(getattr(db, method)))
    if method == "rollback":
        monkeypatch.setattr(external_archive, "_archive_cover", AsyncMock(side_effect=RuntimeError("cover failed")))
    db.expire(track)
    operation = (external_archive.archive_track(db, track) if entry == "track" else
                 external_archive._archive_external_core(db, "ytmusic", "archive-test", None, track))
    status, _ = asyncio.run(_health_while_waiting(operation, gate))
    db.expire_all()
    stored = db.get(Track, track_id)
    if method == "rollback":
        assert status == external_archive.ArchiveResult.FAILED
        assert stored.file_path is None
    else:
        assert status == external_archive.ArchiveResult.ARCHIVED
        assert stored.file_path == "minio://music/new.m4a"
        assert stored.cover_url == "/api/tracks/cover/new.jpg"
        assert stored.file_size == 5
        assert stored.acoustic_features == {"energy": 0.5}


def test_cancelled_archive_finishes_commit_before_closing_session(monkeypatch, db):
    _track(db)
    gate = _DatabaseGate()
    committed = threading.Event()
    closed = threading.Event()

    def session():
        database = TestingSessionLocal()
        commit, close = database.commit, database.close

        def delayed_commit():
            gate.wrap(commit)()
            committed.set()

        def checked_close():
            assert committed.is_set(), "session closed while its worker was committing"
            close()
            closed.set()

        monkeypatch.setattr(database, "commit", delayed_commit)
        monkeypatch.setattr(database, "close", checked_close)
        return database

    monkeypatch.setattr(external_archive, "SessionLocal", session)
    monkeypatch.setattr(external_archive.storage, "is_minio_backend", lambda: True)
    monkeypatch.setattr(external_archive, "get_cache_async", AsyncMock(return_value=None))
    monkeypatch.setattr(external_archive, "_lazy_sem", None)
    monkeypatch.setattr(ytdlp, "archived_music_path", AsyncMock(return_value="minio://music/existing.m4a"))

    async def run():
        job = asyncio.create_task(external_archive.schedule_archive_external("ytmusic", "archive-test"))
        try:
            assert await asyncio.to_thread(gate.started.wait, 3)
            job.cancel()
            assert not await asyncio.to_thread(closed.wait, .2)
        finally:
            gate.resume.set()
        with pytest.raises(asyncio.CancelledError):
            await job

    asyncio.run(run())
    assert committed.is_set() and closed.is_set()
    assert gate.released == [True]
