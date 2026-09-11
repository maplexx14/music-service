"""/api/tracks/cover-proxy: внешние обложки CDN отдаются через бэкенд, а не
напрямую с CDN провайдера (прямой выход к ним с браузера/контейнера мигает).
Проверяем allowlist хостов, кэш (позитивный/негативный) и проходной fetch."""

from unittest.mock import patch

import httpx

from app.routers import tracks


def _ok_response(jpeg: bytes = b"\xff\xd8fakejpeg"):
    # request обязателен: raise_for_status() у Response без request кидает
    # RuntimeError (синтетика мока, не поведение реального клиента).
    req = httpx.Request("GET", "https://i.ytimg.com/vi/abc/hqdefault.jpg")
    return httpx.Response(
        200, content=jpeg, headers={"content-type": "image/jpeg"}, request=req
    )


def test_rejects_non_cdn_url(client):
    """Прокси с произвольным url — open relay; чужие хосты запрещены."""
    resp = client.get("/api/tracks/cover-proxy", params={"url": "http://evil.example.com/x.jpg"})
    assert resp.status_code == 400


def test_rejects_non_http_scheme(client):
    resp = client.get("/api/tracks/cover-proxy", params={"url": "file:///etc/passwd"})
    assert resp.status_code == 400


def test_proxies_allowed_cdn_url(client):
    url = "https://i.ytimg.com/vi/abc/hqdefault.jpg"
    with patch.object(
        httpx.AsyncClient, "get", return_value=_ok_response()
    ):
        resp = client.get("/api/tracks/cover-proxy", params={"url": url})
    assert resp.status_code == 200
    assert resp.content == b"\xff\xd8fakejpeg"
    assert resp.headers["content-type"] == "image/jpeg"
    assert "max-age" in resp.headers["cache-control"]


def test_cached_cover_skips_fetch(client):
    """Второй запрос уходит из кэша, без сетевого вызова."""
    from app.cache import set_cache

    url = "https://i1.sndcdn.com/artworks-xyz-0-t500x500.jpg"
    set_cache(tracks._cover_cache_key(url), {"data_b64": "aGVsbG8=", "content_type": "image/png"})
    with patch.object(httpx.AsyncClient, "get") as mocked:
        resp = client.get("/api/tracks/cover-proxy", params={"url": url})
    assert resp.status_code == 200
    assert resp.content == b"hello"
    assert resp.headers["content-type"] == "image/png"
    mocked.assert_not_called()


def test_failed_fetch_502_and_negative_cache(client):
    url = "https://i.ytimg.com/vi/xyz/hqdefault.jpg"
    with patch.object(
        httpx.AsyncClient, "get", side_effect=httpx.ConnectTimeout("boom")
    ):
        resp = client.get("/api/tracks/cover-proxy", params={"url": url})
    assert resp.status_code == 502
    # негативный кэш: повторный запрос не должен звать сеть
    with patch.object(httpx.AsyncClient, "get") as mocked:
        resp = client.get("/api/tracks/cover-proxy", params={"url": url})
    assert resp.status_code == 502
    mocked.assert_not_called()


def test_oversized_cover_rejected(client):
    url = "https://i.ytimg.com/vi/big/hqdefault.jpg"
    req = httpx.Request("GET", url)
    with patch.object(
        httpx.AsyncClient,
        "get",
        return_value=httpx.Response(
            200,
            content=b"x" * (tracks._COVER_PROXY_MAX_BYTES + 1),
            request=req,
        ),
    ):
        resp = client.get("/api/tracks/cover-proxy", params={"url": url})
    assert resp.status_code == 502
