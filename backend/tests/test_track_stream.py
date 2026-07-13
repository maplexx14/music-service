"""GET /tracks/{id}/stream: воспроизведение сохранённых внешних треков не должно
зависеть от хоста, зашитого в stream_url на момент сохранения (перенос деплоя /
смена туннеля). Редиректим на относительный путь провайдерского прокси."""

from app.models import Track

from tests.conftest import create_user, auth_headers


def _add(db, **kw):
    t = Track(duration=100, **kw)
    db.add(t)
    db.commit()
    db.refresh(t)
    return t


def test_soundcloud_stream_strips_stale_host(client, db):
    create_user(db)
    headers = auth_headers(client)
    t = _add(
        db, title="sc", artist="A", source="soundcloud", external_id="123",
        stream_url="https://old-tunnel.example.com/api/soundcloud/stream/TOKEN123",
    )
    resp = client.get(f"/api/tracks/{t.id}/stream", headers=headers, follow_redirects=False)
    assert resp.status_code == 307
    # хост срезан — путь относительный, разрешится против текущего хоста
    assert resp.headers["location"] == "/api/soundcloud/stream/TOKEN123"


def test_ytmusic_stream_reconstructed_from_external_id(client, db):
    create_user(db)
    headers = auth_headers(client)
    t = _add(
        db, title="yt", artist="A", source="ytmusic", external_id="vid42",
        stream_url="https://old-tunnel.example.com/api/ytdlp/stream/vid42",
    )
    resp = client.get(f"/api/tracks/{t.id}/stream", headers=headers, follow_redirects=False)
    assert resp.status_code == 307
    assert resp.headers["location"] == "/api/ytdlp/stream/vid42"


def test_direct_cdn_stream_passthrough(client, db):
    """Прямой CDN-URL провайдера (jamendo) — не наш прокси, отдаём как есть."""
    create_user(db)
    headers = auth_headers(client)
    cdn = "https://cdn.jamendo.com/track/999/mp3"
    t = _add(db, title="j", artist="A", source="jamendo", external_id="999", stream_url=cdn)
    resp = client.get(f"/api/tracks/{t.id}/stream", headers=headers, follow_redirects=False)
    assert resp.status_code == 307
    assert resp.headers["location"] == cdn
