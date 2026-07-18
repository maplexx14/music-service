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

import json
import logging
import os
from datetime import timedelta
from typing import Iterator, Optional
from urllib.parse import urlsplit

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


def upload_music_file(local_path: str, key: str, content_type: str) -> str:
    """Заливает аудиофайл в приватный бакет. Возвращает file_path для БД."""
    ensure_buckets()
    _get_internal_client().fput_object(
        MUSIC_BUCKET, key, local_path, content_type=content_type
    )
    return make_object_path(MUSIC_BUCKET, key)


def upload_cover_file(local_path: str, key: str, content_type: str) -> str:
    """Заливает обложку в бакет обложек. Возвращает относительный прокси-URL."""
    ensure_buckets()
    _get_internal_client().fput_object(
        COVERS_BUCKET, key, local_path, content_type=content_type
    )
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


def stat_music_object(file_path: str) -> tuple[int, str]:
    """(size, content_type) аудио-объекта по minio://bucket/key."""
    bucket, key = parse_object_path(file_path)
    st = _get_internal_client().stat_object(bucket, key)
    return st.size, (st.content_type or "audio/mpeg")


def iter_music_object(
    file_path: str, offset: int = 0, length: int = 0, chunk_size: int = 256 * 1024
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


def open_cover_object(key: str) -> tuple[Iterator[bytes], str, int]:
    """(генератор байтов, content_type, size) обложки из covers-бакета."""
    client = _get_internal_client()
    st = client.stat_object(COVERS_BUCKET, key)

    def _gen() -> Iterator[bytes]:
        resp = client.get_object(COVERS_BUCKET, key)
        try:
            for chunk in resp.stream(128 * 1024):
                yield chunk
        finally:
            resp.close()
            resp.release_conn()

    return _gen(), (st.content_type or "image/jpeg"), st.size


def remove_object_path(file_path: str) -> None:
    """Удаляет объект по file_path вида minio://bucket/key (тихо на ошибках)."""
    if not is_minio_path(file_path):
        return
    bucket, key = parse_object_path(file_path)
    try:
        _get_internal_client().remove_object(bucket, key)
    except Exception:  # noqa: BLE001 — best-effort, как и удаление с диска
        logger.exception("MinIO: не удалось удалить %s/%s", bucket, key)


def remove_cover_url(cover_url: Optional[str]) -> None:
    """Удаляет обложку, если это объект нашего covers-бакета (прокси или legacy URL)."""
    key = cover_key_from_url(cover_url)
    if not key:
        return
    try:
        _get_internal_client().remove_object(COVERS_BUCKET, key)
    except Exception:  # noqa: BLE001
        logger.exception("MinIO: не удалось удалить обложку %s", key)
