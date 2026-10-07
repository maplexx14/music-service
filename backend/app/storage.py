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
import base64
import hashlib
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

# Внешнее S3 (bucket.ru) задаётся отдельными S3_*, а не перезаписью MINIO_*:
# локальный MinIO живёт рядом (откат), его ключи остаются в MINIO_*. Заданный
# S3_ENDPOINT переключает бэкенд целиком.
S3_ENDPOINT = os.getenv("S3_ENDPOINT", "").strip()
if S3_ENDPOINT:
    MINIO_ENDPOINT = S3_ENDPOINT
    MINIO_ACCESS_KEY = os.getenv("S3_ACCESS_KEY", "")
    MINIO_SECRET_KEY = os.getenv("S3_SECRET_KEY", "")
    MINIO_REGION = os.getenv("S3_REGION", "").strip() or MINIO_REGION

MUSIC_BUCKET = os.getenv("MINIO_BUCKET_MUSIC", "music")
COVERS_BUCKET = os.getenv("MINIO_BUCKET_COVERS", "covers")

# Внешнее S3 (bucket.ru): один физический бакет на всё, логические бакеты
# music/covers становятся префиксами ключей. file_path в БД не меняется —
# minio://music/<key> переводится в <S3_BUCKET>/music/<key> на каждом вызове.
# Пусто — логический бакет и есть физический (локальный MinIO).
S3_BUCKET = os.getenv("S3_BUCKET", "").strip() if S3_ENDPOINT else ""

# SSE-C: провайдер шифрует объекты нашим ключом и сам его не хранит — без
# ключа байты на его дисках не прочитать. Ключ уходит с каждым запросом
# (только по HTTPS — minio-клиент без TLS откажется). Потеря ключа = потеря
# всех объектов: для кэша треков это холодный старт, не авария.
# Формат: base64 от 32 байт (openssl rand -base64 32).
_SSE_C_KEY_B64 = os.getenv("S3_SSE_C_KEY", "").strip() if S3_ENDPOINT else ""

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


def locate(bucket: str, key: str) -> tuple[str, str]:
    """Логические (bucket, key) → физические, см. S3_BUCKET."""
    if S3_BUCKET:
        return S3_BUCKET, f"{bucket}/{key}"
    return bucket, key


class ObjectMissing(Exception):
    """Объекта нет в хранилище (NoSuchKey / 404), а не сетевой сбой."""


def _is_missing_error(exc: BaseException) -> bool:
    code = getattr(exc, "code", None)  # minio.error.S3Error
    if code is None:
        response = getattr(exc, "response", None)  # botocore ClientError
        if isinstance(response, dict):
            code = response.get("Error", {}).get("Code")
    return code in ("NoSuchKey", "NoSuchObject", "404", "NotFound")


def _load_sse_c_key() -> Optional[bytes]:
    if not _SSE_C_KEY_B64:
        return None
    key = base64.b64decode(_SSE_C_KEY_B64)
    if len(key) != 32:
        raise RuntimeError("S3_SSE_C_KEY должен быть base64 от 32 байт")
    return key


_SSE_C_KEY = _load_sse_c_key()


def _read_sse() -> dict:
    """kwargs SSE-C для чтения sync-клиентом (get/stat/fget)."""
    if _SSE_C_KEY is None:
        return {}
    from minio.sse import SseCustomerKey

    return {"ssec": SseCustomerKey(_SSE_C_KEY)}


def _write_sse() -> dict:
    """kwargs SSE-C для записи sync-клиентом (put/fput)."""
    if _SSE_C_KEY is None:
        return {}
    from minio.sse import SseCustomerKey

    return {"sse": SseCustomerKey(_SSE_C_KEY)}


def _async_sse() -> dict:
    """Параметры SSE-C для aiobotocore (head/get); base64 и MD5 botocore считает сам."""
    if _SSE_C_KEY is None:
        return {}
    return {"SSECustomerAlgorithm": "AES256", "SSECustomerKey": _SSE_C_KEY}


def download_object(bucket: str, key: str, local_path: str) -> None:
    """Скачивает объект по логическим (bucket, key) в локальный файл."""
    phys_bucket, phys_key = locate(bucket, key)
    _get_internal_client().fget_object(phys_bucket, phys_key, local_path, **_read_sse())


def upload_object(bucket: str, key: str, local_path: str, content_type: str) -> None:
    """Заливает локальный файл по логическим (bucket, key)."""
    phys_bucket, phys_key = locate(bucket, key)
    _get_internal_client().fput_object(
        phys_bucket, phys_key, local_path, content_type=content_type, **_write_sse()
    )
    _stat_cache_invalidate(bucket, key)
    _disk_cache_drop(bucket, key)


def stat_object_size(bucket: str, key: str) -> int:
    phys_bucket, phys_key = locate(bucket, key)
    return _get_internal_client().stat_object(phys_bucket, phys_key, **_read_sse()).size


def remove_object(bucket: str, key: str) -> None:
    phys_bucket, phys_key = locate(bucket, key)
    _stat_cache_invalidate(bucket, key)
    _disk_cache_drop(bucket, key)
    _get_internal_client().remove_object(phys_bucket, phys_key)


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


# Простаивающее соединение с внешним S3 живёт ~15 с (keepalive aiohttp), а новое
# стоит TLS-рукопожатия: до bucket.ru это +150-380 мс к каждому первому запросу
# после паузы — то есть почти к каждому старту трека. Лёгкий запрос раз в
# _KEEP_WARM_INTERVAL держит соединение воркера открытым; запросы у провайдера
# бесплатные. Локальному MinIO не нужно — там соединение почти ничего не стоит.
_KEEP_WARM_INTERVAL = float(os.getenv("S3_KEEP_WARM_SEC", "10"))
_keep_warm_task: Optional[asyncio.Task] = None


async def _keep_warm_loop() -> None:
    while True:
        await asyncio.sleep(_KEEP_WARM_INTERVAL)
        if _async_client is None:
            continue
        try:
            await _async_client.head_bucket(Bucket=locate(MUSIC_BUCKET, "")[0])
        except Exception:  # noqa: BLE001 — прогрев best-effort
            logger.debug("S3 keep-warm failed", exc_info=True)


def start_keep_warm() -> None:
    """Запускает прогрев соединения в текущем воркере (из startup-хука)."""
    global _keep_warm_task
    if S3_ENDPOINT and _keep_warm_task is None and _KEEP_WARM_INTERVAL > 0:
        _keep_warm_task = asyncio.create_task(_keep_warm_loop())


async def close_async_client() -> None:
    """Закрывает async-клиент текущего воркера (вызывать на shutdown)."""
    global _async_client_cm, _async_client, _keep_warm_task
    if _keep_warm_task is not None:
        _keep_warm_task.cancel()
        _keep_warm_task = None
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
    if S3_BUCKET:
        # Внешний бакет создан в панели провайдера, ключ без прав на бакеты.
        # Публичная политика тут недопустима: она открыла бы и музыку.
        _buckets_ready = True
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
    # Ключ мог существовать (re-archive внешнего трека) — upload_object
    # сбрасывает stat-кэш, ETag перезалитого объекта другой.
    upload_object(MUSIC_BUCKET, key, local_path, content_type)
    return make_object_path(MUSIC_BUCKET, key), size


def download_music_file(file_path: str, local_path: str) -> None:
    """Download one ``minio://`` audio object to a local analysis path."""
    bucket, key = parse_object_path(file_path)
    download_object(bucket, key, local_path)


def upload_cover_file(local_path: str, key: str, content_type: str) -> str:
    """Заливает обложку в бакет обложек. Возвращает относительный прокси-URL."""
    ensure_buckets()
    upload_object(COVERS_BUCKET, key, local_path, content_type)
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


def is_archive_original(key: str, stem: str) -> bool:
    """``key`` — сам архив ``stem`` (``<stem>.<ext>``), а не низкий вариант
    ``<stem>.low.m4a`` и не чужой id с тем же началом (SoundCloud ``123`` и
    ``1234.m4a``). Варианты сортируются раньше оригинала (``.low`` < ``.m4a``),
    и поиск по голому префиксу принимал их за архив трека."""
    rest = key[len(stem):]
    return key.startswith(stem) and rest.startswith(".") and "." not in rest[1:]


def find_music_object(prefix: str) -> Optional[str]:
    """Архивный аудио-объект ``<prefix>.<ext>`` в music-бакете.

    Возвращает file_path (minio://…) или None. Нужно, чтобы понять, был ли
    внешний трек уже заархивирован, не зная точного расширения
    (external/<source>/<external_id>.<m4a|webm|opus|…>).
    """
    if not is_minio_backend():
        return None
    try:
        client = _get_internal_client()
        phys_bucket, phys_prefix = locate(MUSIC_BUCKET, prefix + ".")
        strip = len(phys_prefix) - len(prefix) - 1
        for obj in client.list_objects(phys_bucket, prefix=phys_prefix, recursive=True):
            key = obj.object_name[strip:]
            if is_archive_original(key, prefix):
                return make_object_path(MUSIC_BUCKET, key)
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


def music_etag(key: str, size: int) -> str:
    """Сильный ETag аудио-объекта, одинаковый для любого пути stat.

    Считаем из (ключ, размер), а не берём ETag MinIO: быстрый путь
    stat_music_object_async знает размер из БД и HEAD не делает, так что
    ETag MinIO ему недоступен. Пустой ETag там ломал кэш на медленных каналах:
    браузер не хранит 206 без валидатора (повтор и перемотка качались заново),
    а If-Range с ним никогда не совпадал — вместо запрошенного диапазона
    уходил полный 200 с нулевого байта. Оба пути делят stat-кэш, поэтому
    формула обязана быть одна: иначе ETag одного URL прыгал бы между воркерами.
    """
    digest = hashlib.sha1(f"{key}:{size}".encode()).hexdigest()[:20]
    return f'"{digest}"'


def stat_music_object(file_path: str) -> tuple[int, str, str]:
    """(size, content_type, etag) аудио-объекта по minio://bucket/key."""
    bucket, key = parse_object_path(file_path)
    cached = _stat_cache_get(bucket, key)
    if cached is not None:
        return cached
    phys_bucket, phys_key = locate(bucket, key)
    try:
        st = _get_internal_client().stat_object(phys_bucket, phys_key, **_read_sse())
    except Exception as exc:
        if _is_missing_error(exc):
            raise ObjectMissing(file_path) from exc
        raise
    value = (st.size, (st.content_type or "audio/mpeg"), music_etag(key, st.size))
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
        # content_type угадываем по расширению
        if not db_content_type:
            ext = key.rsplit(".", 1)[-1].lower() if "." in key else ""
            db_content_type = {"m4a": "audio/mp4", "opus": "audio/opus", "webm": "audio/webm"}.get(ext, "audio/mpeg")
        value = (db_size, db_content_type, music_etag(key, db_size))
        _stat_cache_put(bucket, key, value)
        return value

    phys_bucket, phys_key = locate(bucket, key)
    try:
        resp = await _get_async_client().head_object(
            Bucket=phys_bucket, Key=phys_key, **_async_sse()
        )
    except Exception as exc:
        if _is_missing_error(exc):
            raise ObjectMissing(file_path) from exc
        raise
    value = (
        resp["ContentLength"],
        (resp.get("ContentType") or "audio/mpeg"),
        music_etag(key, resp["ContentLength"]),
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
    phys_bucket, phys_key = locate(bucket, key)
    resp = _get_internal_client().get_object(
        phys_bucket, phys_key, offset=offset, length=length, **_read_sse()
    )
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
    phys_bucket, phys_key = locate(bucket, key)
    client = _get_async_client()
    kwargs = {"Bucket": phys_bucket, "Key": phys_key, **_async_sse()}
    if offset is not None:
        end = offset + length - 1
        kwargs["Range"] = f"bytes={offset}-{end}"
    try:
        resp = await client.get_object(**kwargs)
    except Exception as exc:
        if _is_missing_error(exc):
            raise ObjectMissing(file_path) from exc
        raise
    stream = resp["Body"]
    try:
        async for chunk in stream.iter_chunks(chunk_size):
            yield chunk
    finally:
        stream.close()


async def _opened(gen: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    """Запускает GET до отправки заголовков ответа.

    Генератор iter_music_object_async идёт в хранилище лишь на первом чанке, а
    StreamingResponse берёт его уже после 200/206 — пропавший объект (быстрый
    путь stat по размеру из БД HEAD не делает) обрывал бы ответ на середине.
    Первый чанк читаем здесь: ObjectMissing долетает до вызывающего, и тот
    успевает уйти на провайдера.
    """
    try:
        first = await gen.__anext__()
    except StopAsyncIteration:
        first = None

    async def _rest() -> AsyncIterator[bytes]:
        if first is not None:
            yield first
        async for chunk in gen:
            yield chunk

    return _rest()


async def _ranged_get_with_stat(
    file_path: str, request: Request
) -> Optional[tuple[tuple[int, str, str], int, int, AsyncIterator[bytes], object]]:
    """Range-запрос без предварительного HEAD: размер берём из Content-Range.

    До внешнего S3 каждый запрос — круг ~80 мс, и HEAD перед GET удваивал
    задержку старта трека, которого ещё нет в stat-кэше. Работает только для
    диапазона с явным началом (так шлют плееры); суффиксный и пустой Range,
    If-Range и ADTS идут обычным путём через HEAD.

    Возвращает (stat, start, end, поток, тело S3 для закрытия без чтения) или
    None — тогда обычный путь.
    """
    range_header = request.headers.get("range")
    if not range_header or request.headers.get("if-range") is not None:
        return None
    try:
        unit, raw_range = range_header.strip().split("=", 1)
        raw_start, raw_end = raw_range.split("-", 1)
        if unit.lower() != "bytes" or "," in raw_range or not raw_start:
            return None
        start = int(raw_start)
        end = int(raw_end) if raw_end else None
        if start < 0 or (end is not None and end < start):
            return None
    except ValueError:
        return None

    bucket, key = parse_object_path(file_path)
    phys_bucket, phys_key = locate(bucket, key)
    try:
        resp = await _get_async_client().get_object(
            Bucket=phys_bucket, Key=phys_key,
            Range=f"bytes={start}-{'' if end is None else end}", **_async_sse(),
        )
    except Exception as exc:
        if _is_missing_error(exc):
            raise ObjectMissing(file_path) from exc
        return None  # InvalidRange (старт за концом) и прочее — обычный путь даст 416/ошибку

    stream = resp["Body"]
    try:
        size = int(resp["ContentRange"].rsplit("/", 1)[1])
    except (KeyError, ValueError, IndexError):
        stream.close()
        return None
    stat = (size, resp.get("ContentType") or "audio/mpeg", music_etag(key, size))
    _stat_cache_put(bucket, key, stat)

    async def _body() -> AsyncIterator[bytes]:
        try:
            async for chunk in stream.iter_chunks(64 * 1024):
                yield chunk
        finally:
            stream.close()

    return stat, start, min(end if end is not None else size - 1, size - 1), _body(), stream


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
# объектом рядом с оригиналом и готовится ФОНОМ по первому запросу: дальше это
# обычный объект MinIO, и весь путь стрима (Range/206/ETag/304) работает без
# изменений.
#
# Первый запрос сборку НЕ ждёт — получает оригинал сразу. Раньше он ждал
# скачивание + ffmpeg + fdkaac + заливку, и каждый новый трек на медленном
# канале (а на мобильных low — умолчание) молчал 3-5 с до первого байта:
# ровно та задержка, от которой вариант должен был спасать.
#
# Готовый вариант начинают отдавать не сразу, а через _LOW_SETTLE_SECONDS после
# сборки. URL у обоих вариантов один (?quality=low), а размер и байты разные:
# переключись он посреди прослушивания, следующий Range-запрос того же <audio>
# получил бы чужие байты. Выдержка отделяет прослушивания, начатые на
# оригинале, от прослушиваний на варианте; кэш браузера для оригинала под этим
# URL живёт не дольше выдержки (см. low_variant_for_stream). Момент отсчёта —
# LastModified объекта, он общий для всех воркеров.
#
# Дедуп здесь не косметика: iOS Safari шлёт на один трек десятки Range-запросов,
# и без общего лока на ключ каждый запустил бы свой ffmpeg.

_LOW_TRANSCODE_CONCURRENCY = int(os.getenv("LOW_TRANSCODE_CONCURRENCY", "2"))
# Сколько помним неудачу по ключу, чтобы не пытаться кодировать заново на каждый
# Range-запрос (битый исходник иначе стоил бы полного прогона ffmpeg десятки раз).
_LOW_FAIL_TTL = float(os.getenv("LOW_TRANSCODE_FAIL_TTL", "600"))
_LOW_FAIL_MAX = 4096
# Выдержка свежего варианта перед первой отдачей (см. выше). С запасом длиннее
# трека вместе с паузами посреди него.
_LOW_SETTLE_SECONDS = float(os.getenv("LOW_VARIANT_SETTLE_SECONDS", "3600"))
_LOW_READY_MAX = 8192

_low_sem: Optional[asyncio.Semaphore] = None
_low_locks: dict[str, asyncio.Lock] = {}
# low_path → unix-время, с которого вариант можно отдавать. Только
# положительные записи: объект варианта после сборки не меняется.
_low_ready_at: dict[str, float] = {}
# Ключи, чья фоновая сборка уже запущена в этом воркере, и сами задачи
# (ссылка нужна, иначе GC может собрать задачу посреди работы).
_low_build_pending: set[str] = set()
_low_build_tasks: set[asyncio.Task] = set()
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

    Ждёт кодирование (единицы секунд), поэтому стрим зовёт её только фоном —
    через low_variant_for_stream.
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


def _remember_low_ready(low_path: str, ready_at: float) -> None:
    if len(_low_ready_at) >= _LOW_READY_MAX:
        _low_ready_at.clear()  # дороже один лишний HEAD, чем неограниченный рост
    _low_ready_at[low_path] = ready_at


async def _low_variant_built_at(low_path: str) -> Optional[float]:
    """Unix-время сборки варианта (LastModified) или None, если его нет."""
    bucket, key = parse_object_path(low_path)
    phys_bucket, phys_key = locate(bucket, key)
    try:
        resp = await _get_async_client().head_object(
            Bucket=phys_bucket, Key=phys_key, **_async_sse()
        )
    except Exception:  # noqa: BLE001 — объекта ещё нет, это нормальный путь
        return None
    modified = resp.get("LastModified")
    # Без даты считаем вариант давним: объект есть, а момент сборки неизвестен.
    return modified.timestamp() if modified is not None else 0.0


async def _build_low_variant_bg(file_path: str, low_path: str) -> None:
    try:
        if await ensure_low_variant_async(file_path):
            # Свой воркер знает момент сборки и без HEAD; остальные прочитают
            # LastModified — расхождение в секунды заливки, не больше.
            _remember_low_ready(low_path, time.time() + _LOW_SETTLE_SECONDS)
    except Exception:  # noqa: BLE001 — фоновая сборка не должна шуметь в loop
        logger.exception("MinIO: фоновая сборка низкого варианта %s упала", low_path)
    finally:
        _low_build_pending.discard(low_path)


async def low_variant_for_stream(file_path: str) -> tuple[Optional[str], Optional[int]]:
    """Что отдать на ?quality=low: ``(low_path, None)`` — готовый вариант;
    ``(None, max_age)`` — оригинал, и кэшировать его браузеру не дольше
    ``max_age`` секунд (дальше этот URL начнёт отдавать вариант);
    ``(None, None)`` — варианта не бывает, оригинал как обычно.

    Никогда не ждёт кодирования: недостающий вариант собирается фоном.
    """
    if not is_minio_backend() or not is_minio_path(file_path):
        return None, None

    from app.transcode import low_variant_key

    bucket, key = parse_object_path(file_path)
    if not key:
        return None, None
    low_path = make_object_path(bucket, low_variant_key(key))
    settle = int(_LOW_SETTLE_SECONDS)

    # Сборка уже идёт в этом воркере — объекта заведомо нет, HEAD не нужен.
    if low_path in _low_build_pending:
        return None, settle

    ready_at = _low_ready_at.get(low_path)
    if ready_at is None:
        built_at = await _low_variant_built_at(low_path)
        if built_at is not None:
            ready_at = built_at + _LOW_SETTLE_SECONDS
            _remember_low_ready(low_path, ready_at)

    if ready_at is not None:
        wait = ready_at - time.time()
        if wait <= 0:
            return low_path, None
        return None, max(1, int(wait))

    if not _low_failed_recently(low_path) and low_path not in _low_build_pending:
        _low_build_pending.add(low_path)
        task = asyncio.create_task(_build_low_variant_bg(file_path, low_path))
        _low_build_tasks.add(task)
        task.add_done_callback(_low_build_tasks.discard)
    return None, settle


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
        download_object(bucket_src, key_src, src_path)
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


# ─────────────── дисковый кэш объектов внешнего S3 ───────────────
#
# Плеер читает трек со скоростью проигрывания (nginx режет отдачу до 160 КБ/с
# после первых 2 МБ), и прямой прокси держал соединение с хранилищем всё
# прослушивание. bucket.ru на сотнях одновременных соединений проседает:
# 16 параллельных скачиваний — 37 МБ/с, 64 — всего 13.5 МБ/с, и под ~600
# слушателями старт нового трека уходил в секунды, а слушатели заикались.
#
# Поэтому объект скачивается целиком одним GET на полной скорости (трек 4 МБ —
# ~0.5 с) в файл на диске VPS, а ответ плееру читается из этого файла по мере
# докачки: первый байт не ждёт конца скачивания. Соединение с хранилищем
# занято полсекунды вместо минут, повторное прослушивание идёт с диска.
# Вытеснение — LRU по mtime с потолком S3_DISK_CACHE_MAX_MB. Только для
# внешнего S3: локальный MinIO и так на том же диске.

_DISK_CACHE_DIR = os.getenv("S3_DISK_CACHE_DIR") or os.path.join(
    os.getenv("YTDLP_CACHE_DIR", tempfile.gettempdir()), "s3"
)
_DISK_CACHE_MAX = int(os.getenv("S3_DISK_CACHE_MAX_MB", "3072")) * 1024 * 1024
# Свободного места на диске меньше этого — не кэшируем, отдаём прямо из S3.
_DISK_CACHE_MIN_FREE = int(os.getenv("S3_DISK_CACHE_MIN_FREE_MB", "1024")) * 1024 * 1024
# Одновременных скачиваний на воркер: bucket.ru держит ~16 параллельных
# на полной скорости, у нас 4 воркера.
_DOWNLOAD_CONCURRENCY = int(os.getenv("S3_DOWNLOAD_CONCURRENCY", "4"))
_DISK_CHUNK = 256 * 1024
# Голова трека качается сразу, мимо очереди: старт не должен ждать, пока
# докачаются чужие файлы (FLAC до 40 МБ держит слот очереди десятки секунд).
# 2 МБ — это и потолок без лимита скорости у nginx, и ~1.5 мин звука: за это
# время хвост успеет пройти очередь.
_HEAD_BYTES = int(os.getenv("S3_HEAD_BYTES", str(2 * 1024 * 1024)))
_RESUME_ATTEMPTS = 3
_EVICT_EVERY = 30.0
# Обновлять mtime (LRU) не чаще: каждый Range-запрос плеера трогал бы диск.
_TOUCH_EVERY = 3600.0

_download_sem: Optional[asyncio.Semaphore] = None
_downloads: dict[str, "_Download"] = {}
_last_evict = 0.0

_AUDIO_TYPES = {
    "m4a": "audio/mp4", "mp4": "audio/mp4", "aac": "audio/aac", "opus": "audio/opus",
    "webm": "audio/webm", "flac": "audio/flac", "wav": "audio/wav", "mp3": "audio/mpeg",
}


def _guess_audio_type(key: str) -> str:
    return _AUDIO_TYPES.get(key.rsplit(".", 1)[-1].lower() if "." in key else "", "audio/mpeg")


def _disk_cache_enabled() -> bool:
    return bool(S3_ENDPOINT) and _DISK_CACHE_MAX > 0


def _disk_cache_path(bucket: str, key: str) -> str:
    digest = hashlib.sha1(f"{bucket}/{key}".encode()).hexdigest()
    ext = os.path.splitext(key)[1].lower()[:8]
    return os.path.join(_DISK_CACHE_DIR, digest[:2], digest + ext)


def disk_cached_path(bucket: str, key: str) -> Optional[str]:
    """Готовая локальная копия объекта или None."""
    if not _disk_cache_enabled():
        return None
    path = _disk_cache_path(bucket, key)
    return path if os.path.isfile(path) else None


def _disk_cache_drop(bucket: str, key: str) -> None:
    if not _disk_cache_enabled():
        return
    try:
        os.remove(_disk_cache_path(bucket, key))
    except OSError:
        pass


def _evict_disk_cache() -> None:
    """LRU по mtime; брошенные .part (упавший воркер) старше часа — тоже."""
    files = []
    total = 0
    now = time.time()
    for root, _dirs, names in os.walk(_DISK_CACHE_DIR):
        for name in names:
            path = os.path.join(root, name)
            try:
                st = os.stat(path)
            except OSError:
                continue
            if name.endswith(".part"):
                if now - st.st_mtime > 3600:
                    try:
                        os.remove(path)
                    except OSError:
                        pass
                continue
            files.append((st.st_mtime, st.st_size, path))
            total += st.st_size
    if total <= _DISK_CACHE_MAX:
        return
    target = _DISK_CACHE_MAX * 0.9
    for _mtime, size, path in sorted(files):
        try:
            os.remove(path)
        except OSError:
            continue
        total -= size
        if total <= target:
            break


def _maybe_evict() -> None:
    global _last_evict
    if time.monotonic() - _last_evict < _EVICT_EVERY:
        return
    _last_evict = time.monotonic()
    def _evict_logged() -> None:
        try:
            _evict_disk_cache()
        except Exception:  # noqa: BLE001 — вытеснение best-effort
            logger.warning("S3 disk cache eviction failed", exc_info=True)

    asyncio.get_running_loop().run_in_executor(None, _evict_logged)


class _Download:
    """Скачивание объекта в .part, за которым могут идти читатели."""

    def __init__(self, final: str) -> None:
        self.final = final
        self.part = f"{final}.{os.getpid()}.{id(self):x}.part"
        self.size: Optional[int] = None
        self.content_type: Optional[str] = None
        self.written = 0
        self.done = False
        self.error: Optional[BaseException] = None
        self.ready = asyncio.Event()  # размер известен или скачивание упало
        self._progress = asyncio.Event()

    def notify(self) -> None:
        # Ждущие держат ссылку на старое событие — set() будит их, новое
        # событие ловит следующий прогресс.
        self._progress.set()
        self._progress = asyncio.Event()

    def progress(self) -> asyncio.Event:
        return self._progress


async def _run_download(d: _Download, bucket: str, key: str, file_path: str) -> None:
    global _download_sem
    if _download_sem is None:
        _download_sem = asyncio.Semaphore(_DOWNLOAD_CONCURRENCY)
    phys_bucket, phys_key = locate(bucket, key)
    import aiofiles

    async def _get(range_header: str):
        try:
            return await _get_async_client().get_object(
                Bucket=phys_bucket, Key=phys_key, Range=range_header, **_async_sse()
            )
        except Exception as exc:
            if _is_missing_error(exc):
                raise ObjectMissing(file_path) from exc
            raise

    async def _append(fh, resp) -> None:
        body = resp["Body"]
        try:
            async for chunk in body.iter_chunks(_DISK_CHUNK):
                await fh.write(chunk)
                await fh.flush()  # читатели видят байты сразу
                d.written += len(chunk)
                d.notify()
        finally:
            body.close()

    async def _fill(fh, resp, upto: int) -> None:
        """Дописывает байты до ``upto``. bucket.ru под нагрузкой рвёт длинные
        ответы посреди тела (aiohttp ContentLengthError) — докачиваем с места
        обрыва, а не роняем весь файл и слушателей, идущих за ним."""
        failures = 0
        while d.written < upto:
            try:
                if resp is None:
                    resp = await _get(f"bytes={d.written}-{upto - 1}")
                await _append(fh, resp)
            except ObjectMissing:
                raise
            except Exception:
                failures += 1
                if failures > _RESUME_ATTEMPTS:
                    raise
                logger.info("S3 disk cache: обрыв %s на %d байте, докачиваю", file_path, d.written)
                await asyncio.sleep(0.2 * failures)
            resp = None

    try:
        head = await _get(f"bytes=0-{_HEAD_BYTES - 1}")
        try:
            d.size = int(head["ContentRange"].rsplit("/", 1)[1])
        except (KeyError, ValueError, IndexError):
            head["Body"].close()
            raise IOError(f"S3 не отдал Content-Range для {file_path}")
        d.content_type = head.get("ContentType") or _guess_audio_type(key)
        os.makedirs(os.path.dirname(d.final), exist_ok=True)
        async with aiofiles.open(d.part, "wb") as fh:
            d.ready.set()
            await _fill(fh, head, min(d.size, _HEAD_BYTES))
            if d.written < d.size:
                async with _download_sem:
                    await _fill(fh, None, d.size)
        if d.written != d.size:
            raise IOError(f"S3 отдал {d.written} из {d.size} байт {file_path}")
        os.replace(d.part, d.final)
        d.done = True
    except BaseException as exc:  # noqa: BLE001 — читатели узнают через d.error
        d.error = exc
        try:
            os.remove(d.part)
        except OSError:
            pass
        if not isinstance(exc, (ObjectMissing, asyncio.CancelledError)):
            logger.warning("S3 disk cache: %s не скачался", file_path, exc_info=True)
        if isinstance(exc, asyncio.CancelledError):
            raise
    finally:
        d.ready.set()
        d.notify()
        _downloads.pop(d.final, None)
        if d.done:
            _maybe_evict()


def _start_download(bucket: str, key: str, file_path: str) -> Optional[_Download]:
    """Идущее или новое скачивание объекта; None — места на диске мало."""
    final = _disk_cache_path(bucket, key)
    d = _downloads.get(final)
    if d is not None:
        return d
    try:
        os.makedirs(_DISK_CACHE_DIR, exist_ok=True)
        import shutil

        if shutil.disk_usage(_DISK_CACHE_DIR).free < _DISK_CACHE_MIN_FREE:
            return None
    except OSError:
        return None
    d = _Download(final)
    _downloads[final] = d
    d.task = asyncio.create_task(_run_download(d, bucket, key, file_path))
    return d


async def _iter_cached_file(path: str, start: int, end: int) -> AsyncIterator[bytes]:
    import aiofiles

    async with aiofiles.open(path, "rb") as fh:
        await fh.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            chunk = await fh.read(min(_DISK_CHUNK, remaining))
            if not chunk:
                raise IOError(f"кэш-файл {path} короче ожидаемого")
            remaining -= len(chunk)
            yield chunk


async def _iter_downloading(d: _Download, start: int, end: int) -> AsyncIterator[bytes]:
    """Байты [start, end] из скачивающегося файла: ждёт, пока докачаются."""
    import aiofiles

    pos = start
    fh = None
    try:
        while pos <= end:
            available = d.written
            if available <= pos:
                if d.error is not None:
                    raise IOError("скачивание из S3 оборвалось") from d.error
                if d.done:
                    raise IOError("объект короче заявленного размера")
                event = d.progress()
                await event.wait()
                continue
            if fh is None:
                # .part переименовывается в итоговый файл по завершении: если
                # открыть не успели — открываем уже итоговый.
                try:
                    fh = await aiofiles.open(d.part, "rb")
                except FileNotFoundError:
                    fh = await aiofiles.open(d.final, "rb")
                await fh.seek(pos)
            chunk = await fh.read(min(_DISK_CHUNK, available - pos, end - pos + 1))
            if not chunk:
                await asyncio.sleep(0.01)  # flush ещё не дошёл до читателя
                continue
            pos += len(chunk)
            yield chunk
    finally:
        if fh is not None:
            await fh.close()


async def _disk_cached_response(
    file_path: str, request: Request, max_age: Optional[int], db_content_type: Optional[str]
) -> Optional[Response]:
    """Ответ из дискового кэша (готового или докачивающегося) или None —
    тогда обычный путь прямо из S3."""
    if not _disk_cache_enabled():
        return None
    bucket, key = parse_object_path(file_path)
    final = _disk_cache_path(bucket, key)
    d: Optional[_Download] = None
    try:
        st = os.stat(final)
        size = st.st_size
        if time.time() - st.st_mtime > _TOUCH_EVERY:
            try:
                os.utime(final)
            except OSError:
                pass
        cached = _stat_cache_get(bucket, key)
        content_type = (cached[1] if cached else None) or db_content_type or _guess_audio_type(key)
    except FileNotFoundError:
        d = _start_download(bucket, key, file_path)
        if d is None:
            return None
        await d.ready.wait()
        if d.error is not None or d.size is None:
            if isinstance(d.error, ObjectMissing):
                raise d.error
            return None  # S3 недоступен для скачивания — пусть попробует прямой путь
        size = d.size
        content_type = db_content_type or d.content_type
        if d.done:
            d = None  # успело докачаться — читаем готовый файл

    etag = music_etag(key, size)
    _stat_cache_put(bucket, key, (size, content_type, etag))
    common_headers = audio_common_headers(etag)
    if max_age is not None:
        common_headers["Cache-Control"] = f"private, max-age={max_age}"
    if if_none_match_matches(request, etag):
        return Response(status_code=304, headers=common_headers)

    range_header = request.headers.get("range")
    if range_header and not if_range_allows_206(request, etag):
        range_header = None
    if range_header:
        parsed = parse_range_header(range_header, size)
        if parsed is None:
            return Response(
                status_code=416,
                headers={**common_headers, "Content-Range": f"bytes */{size}"},
            )
        start, end = parsed
    else:
        start, end = 0, size - 1

    body = _iter_downloading(d, start, end) if d is not None else _iter_cached_file(final, start, end)
    headers = {**common_headers, "Content-Length": str(end - start + 1)}
    if range_header:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return StreamingResponse(
        body, status_code=206 if range_header else 200, media_type=content_type, headers=headers
    )


async def minio_range_response_async(
    file_path: str, request: Request, quality: Optional[str] = None, db_size: int = None, db_content_type: str = None
) -> Response:
    """Async-двойник minio_range_response — hot-path, не держит OS-тред на стрим.

    Range-парсинг/валидация/416/304 идентичны sync-версии (чистый Python,
    S3-объект не трогаем до проверки границ — InvalidRange от get_object
    невозможен).

    ``quality="low"`` отдаёт низкобитрейтный вариант того же трека (см.
    ``low_variant_for_stream``): подменяется ТОЛЬКО имя объекта, поэтому
    Range/206/ETag/304/If-Range работают один в один, а у варианта свои
    размер и ETag — браузер кладёт его в отдельную ячейку кэша по своему URL.
    Пока варианта нет, отдаётся оригинал — сразу, без ожидания сборки.

    ``db_size`` из Track.file_size минует HEAD-запрос в MinIO (размер известен при upload).
    """
    stat = None
    max_age = None
    if quality == "low":
        low_path, max_age = await low_variant_for_stream(file_path)
        if low_path:
            try:
                # Без db_size: у варианта свой размер.
                stat = await stat_music_object_async(low_path)
                file_path = low_path
            except Exception:  # noqa: BLE001 — вариант пропал; играем оригинал
                logger.warning("MinIO: низкий вариант %s недоступен", low_path, exc_info=True)
                _low_ready_at.pop(low_path, None)

    from app import adts

    if not adts.wants_adts(request):
        cached_response = await _disk_cached_response(file_path, request, max_age, db_content_type)
        if cached_response is not None:
            return cached_response

    if (
        stat is None
        and S3_ENDPOINT
        and not db_size
        and _stat_cache_get(*parse_object_path(file_path)) is None
        and not adts.wants_adts(request)
    ):
        ranged = await _ranged_get_with_stat(file_path, request)
        if ranged is not None:
            (file_size, mime_type, etag), start, end, body, s3_body = ranged
            common_headers = audio_common_headers(etag)
            if max_age is not None:
                common_headers["Cache-Control"] = f"private, max-age={max_age}"
            if if_none_match_matches(request, etag):
                s3_body.close()  # генератор не стартовал — его finally не сработает
                return Response(status_code=304, headers=common_headers)
            return StreamingResponse(
                await _opened(body),
                status_code=206,
                media_type=mime_type,
                headers={
                    **common_headers,
                    "Content-Range": f"bytes {start}-{end}/{file_size}",
                    "Content-Length": str(end - start + 1),
                },
            )

    if stat is None:
        stat = await stat_music_object_async(file_path, db_size, db_content_type)
    file_size, mime_type, etag = stat
    common_headers = audio_common_headers(etag)
    if max_age is not None:
        # Оригинал под URL варианта: кэш браузера не должен пережить момент,
        # когда этот URL переключится на вариант (см. low_variant_for_stream).
        common_headers["Cache-Control"] = f"private, max-age={max_age}"

    # ?fmt=adts — PWA на iOS: тот же AAC без MP4-контейнера, с которым Safari
    # стартует в разы быстрее (см. app/adts.py). Не вышло — отдаём оригинал.
    if adts.wants_adts(request) and adts.is_mp4_audio(file_path, mime_type):
        converted = await adts.adts_for_object(file_path, etag)
        if converted:
            from app.routers.ytdlp import _serve_file

            return await _serve_file(
                converted, adts.ADTS_MEDIA_TYPE, request,
                cache_control=common_headers["Cache-Control"] if max_age is not None else None,
            )

    if if_none_match_matches(request, etag):
        return Response(status_code=304, headers=common_headers)

    range_header = request.headers.get("range")
    if range_header and not if_range_allows_206(request, etag):
        range_header = None

    if not range_header:
        return StreamingResponse(
            await _opened(iter_music_object_async(file_path)),
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
        await _opened(iter_music_object_async(file_path, offset=start, length=content_length)),
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
    phys_bucket, phys_key = locate(COVERS_BUCKET, key)
    cached = _stat_cache_get(COVERS_BUCKET, key)
    if cached is not None:
        size, content_type, etag = cached
    else:
        st = client.stat_object(phys_bucket, phys_key, **_read_sse())
        size, content_type, etag = st.size, (st.content_type or "image/jpeg"), (st.etag or "")
        _stat_cache_put(COVERS_BUCKET, key, (size, content_type, etag))

    def _gen() -> Iterator[bytes]:
        resp = client.get_object(phys_bucket, phys_key, **_read_sse())
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
    phys_bucket, phys_key = locate(COVERS_BUCKET, key)
    cached = _stat_cache_get(COVERS_BUCKET, key)
    if cached is not None:
        size, content_type, etag = cached
    else:
        st = await client.head_object(Bucket=phys_bucket, Key=phys_key, **_async_sse())
        size = st["ContentLength"]
        content_type = st.get("ContentType") or "image/jpeg"
        etag = st.get("ETag") or ""
        _stat_cache_put(COVERS_BUCKET, key, (size, content_type, etag))

    async def _gen() -> AsyncIterator[bytes]:
        resp = await client.get_object(Bucket=phys_bucket, Key=phys_key, **_async_sse())
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
    try:
        remove_object(bucket, key)
    except Exception:  # noqa: BLE001 — best-effort, как и удаление с диска
        logger.exception("MinIO: не удалось удалить %s/%s", bucket, key)


def remove_cover_url(cover_url: Optional[str]) -> None:
    """Удаляет обложку, если это объект нашего covers-бакета (прокси или legacy URL)."""
    key = cover_key_from_url(cover_url)
    if not key:
        return
    try:
        remove_object(COVERS_BUCKET, key)
    except Exception:  # noqa: BLE001
        logger.exception("MinIO: не удалось удалить обложку %s", key)
