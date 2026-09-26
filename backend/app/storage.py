"""Объектное хранилище (MinIO / S3-совместимое) для музыки и обложек.

Гибридный режим через переменную STORAGE_BACKEND:
    * local  — файлы лежат на диске (music_files / cover_files), как раньше;
    * minio  — новые загрузки уходят в объектное хранилище.

Старые треки с file_path вида "/music_files/…" продолжают работать в любом
режиме: роутер стрима сам определяет тип пути. Треки в объектном хранилище
помечаются file_path вида "minio://<bucket>/<key>".

Тонкость деплоя: сервер и браузер видят MinIO по РАЗНЫМ адресам.
    * MINIO_ENDPOINT         — внутренний адрес для put/remove (напр. minio:9000);
    * MINIO_PUBLIC_ENDPOINT  — адрес, по которому браузер тянет аудио/обложки
                               (напр. http://localhost:9000). Presigned-ссылки
                               подписываются именно этим хостом, иначе они
                               недоступны из браузера.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
import time
from datetime import timedelta
from typing import AsyncIterator, Iterator, Optional
from urllib.parse import urlsplit

from fastapi import Request, Response
from fastapi.responses import StreamingResponse

logger = logging.getLogger(__name__)

# ─────────────────────────── конфигурация ───────────────────────────

STORAGE_BACKEND = os.getenv("STORAGE_BACKEND", "local").strip().lower()

MINIO_ENDPOINT = os.getenv("MINIO_ENDPOINT", "minio:9000").strip()
MINIO_PUBLIC_ENDPOINT = os.getenv("MINIO_PUBLIC_ENDPOINT", "http://localhost:9000").strip()
MINIO_ACCESS_KEY = os.getenv("MINIO_ACCESS_KEY", "minioadmin")
MINIO_SECRET_KEY = os.getenv("MINIO_SECRET_KEY", "minioadmin")
MINIO_SECURE = os.getenv("MINIO_SECURE", "false").strip().lower() in ("1", "true", "yes")
# Регион задаётся явно, чтобы клиент НЕ делал сетевой GetBucketLocation
# (/bucket?location=) при генерации presigned-URL. Иначе публичный клиент
# полез бы на MINIO_PUBLIC_ENDPOINT (напр. localhost:9000), недоступный из
# контейнера бэкенда, и подпись падала бы с Connection refused.
MINIO_REGION = os.getenv("MINIO_REGION", "us-east-1").strip()

MUSIC_BUCKET = os.getenv("MINIO_BUCKET_MUSIC", "music")
COVERS_BUCKET = os.getenv("MINIO_BUCKET_COVERS", "covers")

# Аудио и обложки из MinIO отдаются НЕ напрямую, а через бэкенд-прокси
# под тем же origin, что и приложение. Иначе при доступе через https-туннель
# браузер блокирует http://<minio>:9000 как mixed content, а с других
# устройств localhost указывает на сам клиент. Прокси-эндпоинт обложек
# живёт под /api/tracks (см. routers/tracks.py), аудио — на /api/tracks/{id}/stream.
COVER_PROXY_PREFIX = "/api/tracks/cover/"

# Срок жизни presigned-ссылки на аудио. Плеер держит ссылку в <audio src>;
# час с запасом покрывает прослушивание любого трека и перемотку.
PRESIGN_EXPIRE = timedelta(seconds=int(os.getenv("MINIO_PRESIGN_EXPIRE_SEC", "3600")))

_PATH_PREFIX = "minio://"


def is_minio_backend() -> bool:
    return STORAGE_BACKEND == "minio"


def is_minio_path(file_path: Optional[str]) -> bool:
    return bool(file_path) and file_path.startswith(_PATH_PREFIX)


def make_object_path(bucket: str, key: str) -> str:
    """file_path-значение для БД: minio://<bucket>/<key>."""
    return f"{_PATH_PREFIX}{bucket}/{key}"


def parse_object_path(file_path: str) -> tuple[str, str]:
    """minio://<bucket>/<key> → (bucket, key)."""
    rest = file_path[len(_PATH_PREFIX):]
    bucket, _, key = rest.partition("/")
    return bucket, key


# ─────────────────────────── клиенты MinIO ───────────────────────────
#
# Два клиента с одинаковыми ключами, но разными хостами:
#   _internal — реальные сетевые операции (put/remove/bucket) внутри docker-сети;
#   _public   — ТОЛЬКО генерация presigned-URL (сетевого вызова нет, лишь
#               подпись строки), чтобы ссылка вела на браузеро-доступный хост.

_internal_client = None
_public_client = None
_buckets_ready = False


def _split_endpoint(value: str) -> tuple[str, bool]:
    """Принимает 'host:port' или 'http(s)://host:port' → ('host:port', secure)."""
    if "://" in value:
        parts = urlsplit(value)
        secure = parts.scheme == "https"
        return parts.netloc, secure
    return value, MINIO_SECURE


def _get_internal_client():
    global _internal_client
    if _internal_client is None:
        from minio import Minio

        host, secure = _split_endpoint(MINIO_ENDPOINT)
        _internal_client = Minio(
            host,
            access_key=MINIO_ACCESS_KEY,
            secret_key=MINIO_SECRET_KEY,
            secure=secure,
            region=MINIO_REGION,
        )
    return _internal_client


def _get_public_client():
    global _public_client
    if _public_client is None:
        from minio import Minio

        host, secure = _split_endpoint(MINIO_PUBLIC_ENDPOINT)
        _public_client = Minio(
            host,
            access_key=MINIO_ACCESS_KEY,
            secret_key=MINIO_SECRET_KEY,
            region=MINIO_REGION,
            secure=secure,
        )
    return _public_client


# ─────────────────────── async-клиент (hot-path стрима) ───────────────────────
#
# Sync `minio` SDK не умеет asyncio: sync-эндпоинт стрима держит OS-тред на
# всю длительность прослушивания (минуты), что упирается в потолок
# THREADPOOL_TOKENS × GUNICORN_WORKERS задолго до 10k конкурентных слушателей
# (тред — это память + переключение контекста, не только I/O-wait). Для
# hot-path чтения (stat/get_object на стриме) используем aiobotocore — тот же
# S3 API, что и MinIO, но нативный asyncio без треда на соединение.
#
# Cold-path операции (upload/ensure_buckets/list_objects/remove) остаются на
# sync-клиенте выше: они не держатся на время стрима, переписывать их нет
# смысла.

_async_client_cm = None  # неисполненный async context manager от create_client
_async_client = None  # результат __aenter__ — переиспользуется на все запросы


async def init_async_client() -> None:
    """Создаёт async S3-клиент на весь процесс воркера.

    Вызывать ТОЛЬКО из async startup-хука (см. main.py), никогда на импорте
    модуля: aiohttp-сессия внутри клиента привязана к event loop, а gunicorn
    без --preload форкает воркеров ДО импорта app.main — событийный цикл
    появляется только после старта конкретного воркера. Создание на импорте
    привязало бы клиент к чужому/несуществующему loop.
    """
    global _async_client_cm, _async_client
    if _async_client is not None:
        return

    import aiobotocore.session
    from botocore.config import Config

    host, secure = _split_endpoint(MINIO_ENDPOINT)
    endpoint_url = f"{'https' if secure else 'http'}://{host}"

    session = aiobotocore.session.get_session()
    _async_client_cm = session.create_client(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=MINIO_ACCESS_KEY,
        aws_secret_access_key=MINIO_SECRET_KEY,
        region_name=MINIO_REGION,
        config=Config(
            signature_version="s3v4",
            # MinIO не умеет virtual-hosted-style адресацию с произвольными
            # именами бакетов/кастомным эндпоинтом — только path-style.
            s3={"addressing_style": "path"},
            # Дефолт botocore — 10 соединений: молча воссоздаёт тот же потолок
            # конкурентности, который эта переделка убирает, только под другим
            # именем настройки. Держим с запасом под THREADPOOL_TOKENS-заменяющую
            # нагрузку на один воркер.
            max_pool_connections=int(os.getenv("MINIO_ASYNC_MAX_POOL_CONNECTIONS", "1500")),
            connect_timeout=10,
            read_timeout=60,
        ),
    )
    _async_client = await _async_client_cm.__aenter__()


async def close_async_client() -> None:
    """Закрывает async-клиент текущего воркера (вызывать на shutdown)."""
    global _async_client_cm, _async_client
    if _async_client_cm is not None:
        await _async_client_cm.__aexit__(None, None, None)
    _async_client_cm = None
    _async_client = None


def _get_async_client():
    if _async_client is None:
        raise RuntimeError(
            "Async MinIO-клиент не инициализирован — init_async_client() должен "
            "быть вызван на startup"
        )
    return _async_client


def _public_read_policy(bucket: str) -> str:
    """Политика анонимного чтения объектов бакета (для публичных обложек)."""
    return json.dumps(
        {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Principal": {"AWS": ["*"]},
                    "Action": ["s3:GetObject"],
                    "Resource": [f"arn:aws:s3:::{bucket}/*"],
                }
            ],
        }
    )


def ensure_buckets() -> None:
    """Идемпотентно создаёт бакеты; covers делает публично читаемым."""
    global _buckets_ready
    if _buckets_ready or not is_minio_backend():
        return

    client = _get_internal_client()
    for bucket in (MUSIC_BUCKET, COVERS_BUCKET):
        if not client.bucket_exists(bucket):
            client.make_bucket(bucket)
            logger.info("MinIO: создан бакет %s", bucket)

    # Обложки используются как <img src> — нужен анонимный доступ на чтение.
    try:
        client.set_bucket_policy(COVERS_BUCKET, _public_read_policy(COVERS_BUCKET))
    except Exception:  # noqa: BLE001 — политика не критична для старта
        logger.exception("MinIO: не удалось выставить public-policy на %s", COVERS_BUCKET)

    _buckets_ready = True


# ─────────────────────────── операции ───────────────────────────


def upload_music_file(local_path: str, key: str, content_type: str) -> tuple[str, int]:
    """Заливает аудиофайл в приватный бакет. Возвращает (file_path, size) для БД."""
    ensure_buckets()
    size = os.path.getsize(local_path)
    _get_internal_client().fput_object(
        MUSIC_BUCKET, key, local_path, content_type=content_type
    )
    # Ключ мог существовать (re-archive внешнего трека) — stat-кэш больше
    # не валиден, ETag перезалитого объекта другой.
    _stat_cache_invalidate(MUSIC_BUCKET, key)
    return make_object_path(MUSIC_BUCKET, key), size


def download_music_file(file_path: str, local_path: str) -> None:
    """Download one ``minio://`` audio object to a local analysis path."""
    bucket, key = parse_object_path(file_path)
    _get_internal_client().fget_object(bucket, key, local_path)


def upload_cover_file(local_path: str, key: str, content_type: str) -> str:
    """Заливает обложку в бакет обложек. Возвращает относительный прокси-URL."""
    ensure_buckets()
    _get_internal_client().fput_object(
        COVERS_BUCKET, key, local_path, content_type=content_type
    )
    _stat_cache_invalidate(COVERS_BUCKET, key)
    return public_cover_url(key)


def public_cover_url(key: str) -> str:
    """Относительный URL обложки через бэкенд-прокси (тот же origin, что и app)."""
    return f"{COVER_PROXY_PREFIX}{key.lstrip('/')}"


def cover_key_from_url(cover_url: Optional[str]) -> Optional[str]:
    """Извлекает object-key обложки из прокси-URL или legacy-абсолютного URL.

    Поддерживает:
      * /api/tracks/cover/<key>                  — новый прокси-путь;
      * http(s)://<minio-public-host>/<covers-bucket>/<key> — старый прямой URL.
    Возвращает None, если это не обложка нашего covers-бакета.
    """
    if not cover_url:
        return None
    # Новый прокси-путь.
    idx = cover_url.find(COVER_PROXY_PREFIX)
    if idx >= 0:
        return cover_url[idx + len(COVER_PROXY_PREFIX):].split("?", 1)[0] or None
    # Legacy: абсолютный URL на публичный бакет. Сверяем хост с публичным
    # эндпоинтом, чтобы случайно не «увести» внешний CDN-URL, где встретилось
    # /covers/, в наш прокси.
    if cover_url.startswith(("http://", "https://")):
        parts = urlsplit(cover_url)
        public_netloc, _ = _split_endpoint(MINIO_PUBLIC_ENDPOINT)
        marker = f"/{COVERS_BUCKET}/"
        if parts.netloc == public_netloc and parts.path.startswith(marker):
            return parts.path[len(marker):] or None
    return None


def normalize_cover_url(cover_url: Optional[str]) -> Optional[str]:
    """Приводит cover_url к относительному прокси-пути, если это обложка из MinIO.

    Чинит уже сохранённые записи со старым абсолютным http://localhost:9000/covers/…
    без миграции БД: сериализатор TrackResponse вызывает эту функцию на лету.
    Прочие URL (локальные /cover_files/…, внешние CDN) возвращает без изменений.
    """
    if not cover_url or cover_url.startswith(COVER_PROXY_PREFIX):
        return cover_url
    key = cover_key_from_url(cover_url)
    return public_cover_url(key) if key else cover_url


def find_music_object(prefix: str) -> Optional[str]:
    """Первый аудио-объект с данным префиксом ключа в music-бакете.

    Возвращает file_path (minio://…) или None. Нужно, чтобы понять, был ли
    внешний трек уже заархивирован, не зная точного расширения
    (external/<source>/<external_id>.<m4a|webm|opus|…>).
    """
    if not is_minio_backend():
        return None
    try:
        client = _get_internal_client()
        for obj in client.list_objects(MUSIC_BUCKET, prefix=prefix, recursive=True):
            return make_object_path(MUSIC_BUCKET, obj.object_name)
    except Exception:  # noqa: BLE001 — отсутствие объекта не должно ломать стрим
        logger.exception("MinIO: list_objects по префиксу %s не удался", prefix)
    return None


# ─────────────────────── кэш stat-запросов ───────────────────────
#
# Каждый Range-запрос браузера (а iOS Safari шлёт их десятками на один трек:
# probe bytes=0-1, хвост за метаданными, затем последовательные 206-чанки)
# раньше стоил отдельного HEAD в MinIO. Байты объекта для ключа практически
# неизменяемы, поэтому кэшируем (size, content_type, ETag) в памяти воркера
# с TTL; upload/remove инвалидируют запись явно, TTL страхует от перезаливки
# того же ключа мимо этих функций. Дикт-операции атомарны под GIL — из
# event loop и из тредпула concurrently безопасно.

_STAT_CACHE_TTL = float(os.getenv("MINIO_STAT_CACHE_TTL", "300"))
_STAT_CACHE_MAX = int(os.getenv("MINIO_STAT_CACHE_MAX", "8192"))

_stat_cache: dict[str, tuple[float, tuple[int, str, str]]] = {}


def _stat_cache_get(bucket: str, key: str) -> Optional[tuple[int, str, str]]:
    hit = _stat_cache.get(f"{bucket}/{key}")
    if hit is not None and hit[0] > time.monotonic():
        return hit[1]
    return None


def _stat_cache_put(bucket: str, key: str, value: tuple[int, str, str]) -> None:
    if len(_stat_cache) >= _STAT_CACHE_MAX:
        now = time.monotonic()
        for stale in [k for k, (exp, _) in _stat_cache.items() if exp <= now]:
            del _stat_cache[stale]
        if len(_stat_cache) >= _STAT_CACHE_MAX:
            _stat_cache.clear()  # дороже один лишний HEAD, чем неограниченный рост
    _stat_cache[f"{bucket}/{key}"] = (time.monotonic() + _STAT_CACHE_TTL, value)


def _stat_cache_invalidate(bucket: str, key: str) -> None:
    _stat_cache.pop(f"{bucket}/{key}", None)


def stat_music_object(file_path: str) -> tuple[int, str, str]:
    """(size, content_type, etag) аудио-объекта по minio://bucket/key."""
    bucket, key = parse_object_path(file_path)
    cached = _stat_cache_get(bucket, key)
    if cached is not None:
        return cached
    st = _get_internal_client().stat_object(bucket, key)
    value = (st.size, (st.content_type or "audio/mpeg"), (st.etag or ""))
    _stat_cache_put(bucket, key, value)
    return value


async def stat_music_object_async(file_path: str, db_size: int = None, db_content_type: str = None) -> tuple[int, str, str]:
    """Async-двойник stat_music_object (hot-path, см. init_async_client).

    db_size/db_content_type из БД (Track.file_size) минуют HEAD в MinIO —
    байты объекта практически неизменны для ключа, и размер известен при upload.
    """
    bucket, key = parse_object_path(file_path)
    cached = _stat_cache_get(bucket, key)
    if cached is not None:
        return cached

    # Быстрый путь: размер уже в БД, HEAD не нужен
    if db_size is not None and db_size > 0:
        # content_type угадываем по расширению, ETag оставляем пустым (не критичен)
        if not db_content_type:
            ext = key.rsplit(".", 1)[-1].lower() if "." in key else ""
            db_content_type = {"m4a": "audio/mp4", "opus": "audio/opus", "webm": "audio/webm"}.get(ext, "audio/mpeg")
        value = (db_size, db_content_type, "")
        _stat_cache_put(bucket, key, value)
        return value

    resp = await _get_async_client().head_object(Bucket=bucket, Key=key)
    value = (
        resp["ContentLength"],
        (resp.get("ContentType") or "audio/mpeg"),
        (resp.get("ETag") or ""),
    )
    _stat_cache_put(bucket, key, value)
    return value


def iter_music_object(
    file_path: str, offset: int = 0, length: int = 0, chunk_size: int = 64 * 1024
) -> Iterator[bytes]:
    """Стримит байты аудио из MinIO. length=0 → до конца объекта.

    Внутренний клиент (minio:9000) доступен из контейнера всегда, поэтому
    проксирование работает и за https-туннелем, и с любых устройств.
    """
    bucket, key = parse_object_path(file_path)
    resp = _get_internal_client().get_object(bucket, key, offset=offset, length=length)
    try:
        for chunk in resp.stream(chunk_size):
            yield chunk
    finally:
        resp.close()
        resp.release_conn()


async def iter_music_object_async(
    file_path: str,
    offset: Optional[int] = None,
    length: Optional[int] = None,
    chunk_size: int = 64 * 1024,
) -> AsyncIterator[bytes]:
    """Async-двойник iter_music_object.

    offset=None — сентинел «без диапазона»: offset=0 сам по себе валидное
    начало Range (bytes=0-499), в отличие от sync-версии его нельзя путать
    с «диапазон не задан», иначе при перемотке на самое начало трека
    молча уйдёт полный GET вместо Range-запроса.
    """
    bucket, key = parse_object_path(file_path)
    client = _get_async_client()
    kwargs = {"Bucket": bucket, "Key": key}
    if offset is not None:
        end = offset + length - 1
        kwargs["Range"] = f"bytes={offset}-{end}"
    resp = await client.get_object(**kwargs)
    stream = resp["Body"]
    try:
        async for chunk in stream.iter_chunks(chunk_size):
            yield chunk
    finally:
        stream.close()


# ─────────────── условные запросы и Range-парсинг ───────────────
#
# Общий слой для аудио- и cover-прокси: ETag + If-None-Match (304 без тела)
# + If-Range (защита от отдачи байтов от перезалитого объекта под старый
# Range) + разбор Range в одном месте для sync/async-версий.


def audio_common_headers(etag: str) -> dict[str, str]:
    """Общие заголовки ответа на аудио-объект из MinIO."""
    headers = {
        "Accept-Ranges": "bytes",
        # Байты объекта неизменны для данного ключа — разрешаем браузеру
        # кэшировать: повторный старт и перемотка не тянут их заново через
        # туннель (раньше здесь стоял no-store и каждый seek качал заново).
        # Неделю, а не час: вместе с ETag/If-Range ревалидация дешёвая.
        "Cache-Control": "private, max-age=604800",
        "Vary": "Accept-Encoding",
    }
    if etag:
        headers["ETag"] = etag
    return headers


def if_none_match_matches(request: Request, etag: str) -> bool:
    """True, если If-None-Match совпал с текущим ETag — отдавать 304.

    Понимает список тегов ("a", "b") и '*', как требует RFC 7232 §3.2.
    """
    header = request.headers.get("if-none-match")
    if not header:
        return False
    if header.strip() == "*":
        return True
    return any(tag.strip() == etag for tag in header.split(","))


def if_range_allows_206(request: Request, etag: str) -> bool:
    """Range применим, только если If-Range (когда он есть) совпал с ETag.

    If-Range с HTTP-датой не проверяем (Last-Modified не отдаём) — считаем
    несовпадением и отдаём 200 целиком: безопаснее, чем срезать чужие байты
    под старый Range.
    """
    header = request.headers.get("if-range")
    if header is None:
        return True
    return bool(etag) and header.strip() == etag


def parse_range_header(range_header: str, file_size: int) -> Optional[tuple[int, int]]:
    """'bytes=start-end' → (start, end) включительно.

    Некорректный диапазон → None (вызовет 416). Один диапазон; список
    ('0-1,5-9') не поддерживается — сознательно, браузеры так не шлют.
    """
    try:
        unit, raw_range = range_header.strip().split("=", 1)
        if unit.lower() != "bytes" or "," in raw_range:
            raise ValueError
        raw_start, raw_end = raw_range.split("-", 1)
        if raw_start:
            start = int(raw_start)
            end = int(raw_end) if raw_end else file_size - 1
        else:
            suffix_length = int(raw_end)
            if suffix_length <= 0:
                raise ValueError
            start = max(file_size - suffix_length, 0)
            end = file_size - 1
        if start < 0 or start >= file_size or end < start:
            raise ValueError
        return start, min(end, file_size - 1)
    except (ValueError, TypeError):
        return None


def minio_range_response(file_path: str, request: Request) -> Response:
    """Отдаёт аудио-объект из MinIO с поддержкой Range (перемотка/докачка).

    Проксируем через бэкенд (тот же origin/https, что и приложение), А НЕ
    редиректом на MINIO_PUBLIC_ENDPOINT: за https-туннелем прямой
    http://<minio>:9000 блокируется как mixed content, а localhost с другого
    устройства указывает на сам клиент. Внутренний клиент (minio:9000) доступен
    из контейнера всегда.

    Общий путь для /tracks/{id}/stream и для провайдерских стрим-эндпоинтов
    (ytdlp/soundcloud), которые проверяют архивную копию до резолва.
    """
    file_size, mime_type, etag = stat_music_object(file_path)
    common_headers = audio_common_headers(etag)

    # Кэш браузера протух, но валидатор совпал — 304 без тела: Safari на iOS
    # ревалидирует медиа-кэш агрессивно, без 304 он тянул бы байты заново.
    if if_none_match_matches(request, etag):
        return Response(status_code=304, headers=common_headers)

    range_header = request.headers.get("range")
    if range_header and not if_range_allows_206(request, etag):
        # Объект перезаливался после того, как браузер закэшировал кусок —
        # старый Range под новые байты не режем, отдаём целиком.
        range_header = None

    if not range_header:
        return StreamingResponse(
            iter_music_object(file_path),
            media_type=mime_type,
            headers={**common_headers, "Content-Length": str(file_size)},
        )

    parsed = parse_range_header(range_header, file_size)
    if parsed is None:
        return Response(
            status_code=416,
            headers={**common_headers, "Content-Range": f"bytes */{file_size}"},
        )

    start, end = parsed
    content_length = end - start + 1
    return StreamingResponse(
        iter_music_object(file_path, offset=start, length=content_length),
        status_code=206,
        media_type=mime_type,
        headers={
            **common_headers,
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Content-Length": str(content_length),
        },
    )


# ─────────────── низкобитрейтный вариант (медленные каналы) ───────────────
#
# Клиент на медленном канале просит ?quality=low и получает HE-AAC 64 kbps
# вместо 128 kbps — вдвое меньше байтов на тот же трек. Вариант живёт отдельным
# объектом рядом с оригиналом и готовится по первому запросу: дальше это
# обычный объект MinIO, и весь путь стрима (Range/206/ETag/304) работает без
# изменений.
#
# Дедуп здесь не косметика: iOS Safari шлёт на один трек десятки Range-запросов,
# и без общего лока на ключ каждый запустил бы свой ffmpeg.

_LOW_TRANSCODE_CONCURRENCY = int(os.getenv("LOW_TRANSCODE_CONCURRENCY", "2"))
# Сколько помним неудачу по ключу, чтобы не пытаться кодировать заново на каждый
# Range-запрос (битый исходник иначе стоил бы полного прогона ffmpeg десятки раз).
_LOW_FAIL_TTL = float(os.getenv("LOW_TRANSCODE_FAIL_TTL", "600"))
_LOW_FAIL_MAX = 4096

_low_sem: Optional[asyncio.Semaphore] = None
_low_locks: dict[str, asyncio.Lock] = {}
_low_failed: dict[str, float] = {}


def _low_semaphore() -> asyncio.Semaphore:
    """Ленивая инициализация: семафор привязывается к event loop, а модуль
    импортируется и раньше старта сервера (скрипты, тесты)."""
    global _low_sem
    if _low_sem is None:
        _low_sem = asyncio.Semaphore(_LOW_TRANSCODE_CONCURRENCY)
    return _low_sem


def _low_failed_recently(low_path: str) -> bool:
    failed_until = _low_failed.get(low_path)
    if not failed_until:
        return False
    if failed_until > time.monotonic():
        return True
    _low_failed.pop(low_path, None)
    return False


def _note_low_failure(low_path: str) -> None:
    if len(_low_failed) >= _LOW_FAIL_MAX:
        now = time.monotonic()
        for stale in [k for k, until in _low_failed.items() if until <= now]:
            del _low_failed[stale]
        if len(_low_failed) >= _LOW_FAIL_MAX:
            _low_failed.clear()
    _low_failed[low_path] = time.monotonic() + _LOW_FAIL_TTL


async def ensure_low_variant_async(file_path: str) -> Optional[str]:
    """Гарантирует низкобитрейтный объект рядом с оригиналом. Путь или None.

    None значит «нет и не будет» — вызывающий отдаёт оригинал. Провал
    кодирования не должен ломать воспроизведение: на медленном канале лучше
    получить тяжёлые байты, чем ошибку.

    Первый запрос ЖДЁТ кодирование (единицы секунд на пятиминутный трек): на
    канале 30 КБ/с эти секунды окупаются сразу же — 2.3 МБ вместо 4.7 МБ.
    """
    if not is_minio_backend() or not is_minio_path(file_path):
        return None

    from app.transcode import low_variant_key

    bucket, key = parse_object_path(file_path)
    if not key:
        return None
    low_key = low_variant_key(key)
    low_path = make_object_path(bucket, low_key)

    try:
        await stat_music_object_async(low_path)
        return low_path
    except Exception:  # noqa: BLE001 — объекта ещё нет, это нормальный путь
        pass

    if _low_failed_recently(low_path):
        return None

    lock = _low_locks.get(low_path)
    if lock is None:
        lock = asyncio.Lock()
        _low_locks[low_path] = lock

    async with lock:
        # Пока ждали лок, вариант мог собрать параллельный запрос по тому же
        # ключу (Range-запросы одного трека идут пачкой).
        try:
            await stat_music_object_async(low_path)
            return low_path
        except Exception:  # noqa: BLE001
            pass

        try:
            async with _low_semaphore():
                created = await asyncio.to_thread(
                    _build_low_variant, file_path, low_key
                )
        except Exception:  # noqa: BLE001 — низкий вариант не роняет стрим
            logger.exception("MinIO: низкий вариант для %s не собрался", file_path)
            created = False
        finally:
            _low_locks.pop(low_path, None)

        if not created:
            _note_low_failure(low_path)
            return None
        return low_path


def _build_low_variant(file_path: str, low_key: str) -> bool:
    """Блокирующая часть: скачать, перекодировать, залить — из тредпула."""
    from app.transcode import AAC_CONTENT_TYPE, transcode_to_low_aac

    bucket_src, key_src = parse_object_path(file_path)
    ext = os.path.splitext(key_src)[1] or ".m4a"

    fd_in, src_path = tempfile.mkstemp(suffix=ext)
    os.close(fd_in)
    fd_out, out_path = tempfile.mkstemp(suffix=".m4a")
    os.close(fd_out)
    try:
        _get_internal_client().fget_object(bucket_src, key_src, src_path)
        if transcode_to_low_aac(src_path, out_path) is None:
            return False
        # upload_music_file сам инвалидирует stat-кэш ключа.
        upload_music_file(out_path, low_key, AAC_CONTENT_TYPE)
        return True
    except Exception:  # noqa: BLE001
        logger.exception("MinIO: сборка низкого варианта %s упала", low_key)
        return False
    finally:
        for path in (src_path, out_path):
            try:
                os.unlink(path)
            except OSError:
                pass


async def minio_range_response_async(
    file_path: str, request: Request, quality: Optional[str] = None, db_size: int = None, db_content_type: str = None
) -> Response:
    """Async-двойник minio_range_response — hot-path, не держит OS-тред на стрим.

    Range-парсинг/валидация/416/304 идентичны sync-версии (чистый Python,
    S3-объект не трогаем до проверки границ — InvalidRange от get_object
    невозможен).

    ``quality="low"`` отдаёт низкобитрейтный вариант того же трека (см.
    ``ensure_low_variant_async``): подменяется ТОЛЬКО имя объекта, поэтому
    Range/206/ETag/304/If-Range работают один в один, а у варианта свои
    размер и ETag — браузер кладёт его в отдельную ячейку кэша по своему URL.

    ``db_size`` из Track.file_size минует HEAD-запрос в MinIO (размер известен при upload).
    """
    if quality == "low":
        low_path = await ensure_low_variant_async(file_path)
        if low_path:
            file_path = low_path
            db_size = None  # у low-варианта размер другой

    file_size, mime_type, etag = await stat_music_object_async(file_path, db_size, db_content_type)
    common_headers = audio_common_headers(etag)

    if if_none_match_matches(request, etag):
        return Response(status_code=304, headers=common_headers)

    range_header = request.headers.get("range")
    if range_header and not if_range_allows_206(request, etag):
        range_header = None

    if not range_header:
        return StreamingResponse(
            iter_music_object_async(file_path),
            media_type=mime_type,
            headers={**common_headers, "Content-Length": str(file_size)},
        )

    parsed = parse_range_header(range_header, file_size)
    if parsed is None:
        return Response(
            status_code=416,
            headers={**common_headers, "Content-Range": f"bytes */{file_size}"},
        )

    start, end = parsed
    content_length = end - start + 1
    return StreamingResponse(
        iter_music_object_async(file_path, offset=start, length=content_length),
        status_code=206,
        media_type=mime_type,
        headers={
            **common_headers,
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Content-Length": str(content_length),
        },
    )


def open_cover_object(key: str) -> tuple[Iterator[bytes], str, int, str]:
    """(генератор байтов, content_type, size, etag) обложки из covers-бакета."""
    client = _get_internal_client()
    cached = _stat_cache_get(COVERS_BUCKET, key)
    if cached is not None:
        size, content_type, etag = cached
    else:
        st = client.stat_object(COVERS_BUCKET, key)
        size, content_type, etag = st.size, (st.content_type or "image/jpeg"), (st.etag or "")
        _stat_cache_put(COVERS_BUCKET, key, (size, content_type, etag))

    def _gen() -> Iterator[bytes]:
        resp = client.get_object(COVERS_BUCKET, key)
        try:
            for chunk in resp.stream(128 * 1024):
                yield chunk
        finally:
            resp.close()
            resp.release_conn()

    return _gen(), content_type, size, etag


async def open_cover_object_async(key: str) -> tuple[AsyncIterator[bytes], str, int, str]:
    """Async-двойник open_cover_object (hot-path)."""
    client = _get_async_client()
    cached = _stat_cache_get(COVERS_BUCKET, key)
    if cached is not None:
        size, content_type, etag = cached
    else:
        st = await client.head_object(Bucket=COVERS_BUCKET, Key=key)
        size = st["ContentLength"]
        content_type = st.get("ContentType") or "image/jpeg"
        etag = st.get("ETag") or ""
        _stat_cache_put(COVERS_BUCKET, key, (size, content_type, etag))

    async def _gen() -> AsyncIterator[bytes]:
        resp = await client.get_object(Bucket=COVERS_BUCKET, Key=key)
        stream = resp["Body"]
        try:
            async for chunk in stream.iter_chunks(128 * 1024):
                yield chunk
        finally:
            stream.close()

    return _gen(), content_type, size, etag


def remove_object_path(file_path: str) -> None:
    """Удаляет объект по file_path вида minio://bucket/key (тихо на ошибках)."""
    if not is_minio_path(file_path):
        return
    bucket, key = parse_object_path(file_path)
    _stat_cache_invalidate(bucket, key)
    try:
        _get_internal_client().remove_object(bucket, key)
    except Exception:  # noqa: BLE001 — best-effort, как и удаление с диска
        logger.exception("MinIO: не удалось удалить %s/%s", bucket, key)


def remove_cover_url(cover_url: Optional[str]) -> None:
    """Удаляет обложку, если это объект нашего covers-бакета (прокси или legacy URL)."""
    key = cover_key_from_url(cover_url)
    if not key:
        return
    _stat_cache_invalidate(COVERS_BUCKET, key)
    try:
        _get_internal_client().remove_object(COVERS_BUCKET, key)
    except Exception:  # noqa: BLE001
        logger.exception("MinIO: не удалось удалить обложку %s", key)
