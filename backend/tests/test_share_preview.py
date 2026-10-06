"""Превью ссылки на трек в мессенджерах (/api/share/track/{id}).

Регрессии, ради которых написано:
1. Ссылка из «Поделиться» в Telegram/WhatsApp приходила без карточки: SPA
   отдаёт один и тот же index.html, боты JS не исполняют.
2. Название трека попадает в HTML — кавычки и угловые скобки обязаны
   экранироваться, иначе трек с «"><script>» в названии ломал страницу.
3. Нет фронтенда — 502, чтобы nginx отдал страницу без превью, а не ошибку.
"""
import httpx
import pytest

from app.models import Track
from app.routers import share

INDEX = "<!doctype html><html><head><meta charset=\"utf-8\"><title>bolt — музыка</title></head><body><div id=\"root\"></div></body></html>"


@pytest.fixture(autouse=True)
def _index(monkeypatch):
    async def fake_load():
        return INDEX
    monkeypatch.setattr(share, "_load_index", fake_load)


def make_track(db, **fields):
    track = Track(**{"title": "Абвгдеё", "artist": "Chipinkos", "duration": 42, "source": "local", **fields})
    db.add(track)
    db.commit()
    db.refresh(track)
    return track


def test_track_page_has_open_graph_tags(client, db):
    track = make_track(db, album="Азбука", cover_url="https://cdn.example/cover.jpg")

    resp = client.get(f"/api/share/track/{track.id}")

    assert resp.status_code == 200
    page = resp.text
    assert '<meta property="og:title" content="Chipinkos — Абвгдеё">' in page
    assert '<meta property="og:image" content="https://cdn.example/cover.jpg">' in page
    assert f'/track/{track.id}"' in page
    assert "Азбука · 0:42" in page
    assert "<title>Chipinkos — Абвгдеё · bolt</title>" in page
    # Само приложение на месте — браузер получает обычный SPA.
    assert '<div id="root"></div>' in page
    assert resp.headers["cache-control"] == "no-store"


def test_relative_cover_becomes_absolute(client, db):
    track = make_track(db, cover_url="/api/tracks/cover/abc.jpg")

    page = client.get(f"/api/share/track/{track.id}").text

    assert f'content="{share.PUBLIC_URL}/api/tracks/cover/abc.jpg"' in page


def test_title_is_escaped(client, db):
    track = make_track(db, title='"><script>alert(1)</script>')

    page = client.get(f"/api/share/track/{track.id}").text

    assert "<script>alert(1)" not in page
    assert "&quot;&gt;&lt;script&gt;" in page


def test_missing_track_serves_plain_index(client):
    resp = client.get("/api/share/track/999999")

    assert resp.status_code == 200
    assert resp.text == INDEX


def test_frontend_down_returns_502(client, monkeypatch):
    async def broken():
        raise httpx.ConnectError("down")
    monkeypatch.setattr(share, "_load_index", broken)

    assert client.get("/api/share/track/1").status_code == 502
