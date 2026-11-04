"""Copy current objects between S3 accounts without changing application config.

Run from backend: python -m app.scripts.migrate_s3 --help
See deploy/S3_MIGRATION.md for the copy, verification and cutover procedure.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import logging
import re
import tempfile
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass, field, replace
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

import certifi
import urllib3
from dotenv import dotenv_values
from minio import Minio
from minio.error import S3Error
from minio.sse import SseCustomerKey
from urllib3.util import Retry, Timeout

logger = logging.getLogger("migrate_s3")
CHUNK_SIZE = 1024 * 1024
CONTENT_HEADERS = {
    "cache-control", "content-encoding", "content-disposition", "content-language",
}


class FreshConnectionsPool(urllib3.PoolManager):
    def urlopen(self, method, url, redirect=True, **kwargs):
        headers = dict(kwargs.get("headers") or {})
        headers["Connection"] = "close"
        kwargs["headers"] = headers
        return super().urlopen(method, url, redirect=redirect, **kwargs)


@dataclass(frozen=True)
class S3Config:
    endpoint: str
    bucket: str
    region: str
    access_key: str = field(repr=False)
    secret_key: str = field(repr=False)
    secure: bool = True
    sse_key: bytes | None = field(default=None, repr=False)
    single_put_max: int = 128 * 1024 * 1024
    fresh_connections: bool = False

    @classmethod
    def from_env(cls, path: Path) -> S3Config:
        if not path.is_file():
            raise ValueError(f"Env file does not exist: {path}")
        # Never source shell code or interpolate the active application's env.
        values = dotenv_values(path, interpolate=False, encoding="utf-8-sig")
        required = ("S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY")
        missing = [name for name in required if not (values.get(name) or "").strip()]
        if missing:
            raise ValueError(f"{path}: missing {', '.join(missing)}")
        endpoint = values["S3_ENDPOINT"].strip()
        parts = urlsplit(endpoint)
        if (parts.scheme not in ("http", "https") or not parts.netloc
                or parts.path not in ("", "/") or parts.query or parts.fragment
                or parts.username or parts.password):
            raise ValueError(f"{path}: S3_ENDPOINT must be an http(s) origin")
        sse_key = None
        encoded = (values.get("S3_SSE_C_KEY") or "").strip()
        if encoded:
            try:
                sse_key = base64.b64decode(encoded, validate=True)
            except ValueError:
                raise ValueError(f"{path}: invalid S3_SSE_C_KEY base64") from None
            if len(sse_key) != 32:
                raise ValueError(f"{path}: S3_SSE_C_KEY must encode 32 bytes")
            if parts.scheme != "https":
                raise ValueError(f"{path}: SSE-C requires HTTPS")
        max_mb = int(values.get("S3_SINGLE_PUT_MAX_MB") or "128")
        if max_mb < 1:
            raise ValueError(f"{path}: S3_SINGLE_PUT_MAX_MB must be positive")
        return cls(
            endpoint=parts.netloc.lower(), bucket=values["S3_BUCKET"].strip(),
            region=(values.get("S3_REGION") or values.get("MINIO_REGION") or "us-east-1").strip(),
            access_key=values["S3_ACCESS_KEY"], secret_key=values["S3_SECRET_KEY"],
            secure=parts.scheme == "https", sse_key=sse_key,
            single_put_max=max_mb * 1024 * 1024,
        )

    def client(self) -> Minio:
        pool = FreshConnectionsPool if self.fresh_connections else urllib3.PoolManager
        return Minio(
            self.endpoint, access_key=self.access_key, secret_key=self.secret_key,
            region=self.region, secure=self.secure,
            http_client=pool(
                cert_reqs="CERT_REQUIRED", ca_certs=certifi.where(), maxsize=64,
                timeout=Timeout(connect=5, read=30),
                retries=Retry(total=5, backoff_factor=0.2,
                              status_forcelist=[500, 502, 503, 504]),
            ),
        )

    def read_args(self) -> dict:
        return {"ssec": SseCustomerKey(self.sse_key)} if self.sse_key else {}

    def write_args(self) -> dict:
        return {"sse": SseCustomerKey(self.sse_key)} if self.sse_key else {}


def validate_pair(source: S3Config, target: S3Config) -> None:
    if (source.endpoint, source.bucket, source.access_key) == (
            target.endpoint, target.bucket, target.access_key):
        raise ValueError("Source and target point to the same account and bucket")
    if source.sse_key and not target.sse_key:
        raise ValueError(
            "Source uses SSE-C: set S3_SSE_C_KEY in the target env before copying"
        )


def object_metadata(info) -> dict:
    return {
        key.lower(): value for key, value in (info.metadata or {}).items()
        if key.lower().startswith("x-amz-meta-") or key.lower() in CONTENT_HEADERS
    }


def object_signature(info) -> tuple:
    return (info.etag, info.version_id, info.size, getattr(info, "last_modified", None),
            info.content_type, object_metadata(info))


def assert_unchanged(client, config: S3Config, key: str, info) -> None:
    current = client.stat_object(config.bucket, key, **config.read_args())
    if object_signature(current) != object_signature(info):
        raise RuntimeError(f"Object changed while being read: {key!r}")


def read_object(client, config: S3Config, key: str, info, output=None,
                *, use_if_match: bool = True) -> tuple[str, int]:
    # Some SSE-C providers return different ETags from HEAD and GET. In that
    # case guard the read with matching HEAD snapshots instead of If-Match.
    guarded = not use_if_match
    try:
        response = client.get_object(
            config.bucket, key,
            request_headers={"If-Match": f'"{info.etag}"'} if use_if_match else None,
            version_id=info.version_id, **config.read_args(),
        )
    except S3Error as exc:
        if exc.code != "PreconditionFailed" or not use_if_match:
            raise
        assert_unchanged(client, config, key, info)
        guarded = True
        response = client.get_object(
            config.bucket, key, version_id=info.version_id,
            request_headers=None, **config.read_args(),
        )
    digest = hashlib.sha256()
    size = 0
    try:
        while chunk := response.read(CHUNK_SIZE):
            digest.update(chunk)
            size += len(chunk)
            if output is not None:
                output.write(chunk)
    finally:
        response.close()
        response.release_conn()
    if size != info.size:
        raise RuntimeError(f"Incomplete read: {key!r}")
    if guarded:
        assert_unchanged(client, config, key, info)
    return digest.hexdigest(), size


def target_stat(client, config: S3Config, key: str):
    try:
        return client.stat_object(config.bucket, key, **config.read_args())
    except S3Error as exc:
        if exc.code in ("NoSuchKey", "NoSuchObject", "NotFound", "404"):
            return None
        raise


def download_response(client, config: S3Config, key: str, output=None):
    """Read one atomic GET response, including its own metadata and raw bytes."""
    response = client.get_object(config.bucket, key, **config.read_args())
    digest, md5, size = hashlib.sha256(), hashlib.md5(), 0
    try:
        headers = {name.lower(): value for name, value in response.headers.items()}
        if headers.get("content-length") is None:
            raise RuntimeError(f"GET response has no Content-Length: {key!r}")
        info = SimpleNamespace(
            size=int(headers["content-length"]), metadata=headers,
            content_type=headers.get("content-type") or "application/octet-stream",
        )
        while chunk := response.read(CHUNK_SIZE, decode_content=False):
            digest.update(chunk)
            md5.update(chunk)
            size += len(chunk)
            if output is not None:
                output.write(chunk)
    finally:
        response.close()
        response.release_conn()
    if size != info.size:
        raise RuntimeError(f"Incomplete GET response: {key!r}")
    info.md5 = md5.hexdigest()
    return info, digest.hexdigest(), size


def checksum_response(client, config, key):
    """Read plaintext ETag and metadata with a one-byte authenticated GET."""
    response = client.get_object(config.bucket, key, length=1, **config.read_args())
    try:
        headers = {name.lower(): value for name, value in response.headers.items()}
        response.read(CHUNK_SIZE, decode_content=False)
        etag = headers.get("etag", "").strip('"').lower()
        if not re.fullmatch(r"[0-9a-f]{32}", etag):
            return None
        size = int(headers.get("content-range", "").rsplit("/", 1)[1]) if "/" in headers.get("content-range", "") else int(headers["content-length"])
        return SimpleNamespace(size=size, content_type=headers.get("content-type") or
                               "application/octet-stream", metadata=headers, md5=etag)
    finally:
        response.close()
        response.release_conn()


def same_object_info(first, second) -> bool:
    return (first.size == second.size and first.content_type == second.content_type and
            object_metadata(first) == object_metadata(second))


def copy_streaming(source_client, target_client, source, target, key, *,
                   temp_dir=None, verify_only=False, overwrite_changed=False,
                   target_exists=None, verify_etag=False):
    if target_exists is None:
        target_exists = target_stat(target_client, target, key) is not None
    if verify_only and not target_exists:
        raise RuntimeError(f"Target object is missing: {key!r}")
    if target_exists and verify_etag:
        source_probe = checksum_response(source_client, source, key)
        target_probe = checksum_response(target_client, target, key)
        if (source_probe and target_probe and source_probe.md5 == target_probe.md5 and
                same_object_info(source_probe, target_probe)):
            return "verified", source_probe.size
    with tempfile.TemporaryDirectory(prefix="s3-migration-", dir=temp_dir) as work_dir:
        local_path = Path(work_dir) / "object"
        with local_path.open("wb") as output:
            source_info, source_hash, size = download_response(source_client, source, key, output)
        if target_exists:
            existing, existing_hash, _ = download_response(target_client, target, key)
            if same_object_info(source_info, existing) and existing_hash == source_hash:
                return "verified", size
            if verify_only or not overwrite_changed:
                raise RuntimeError(f"Target object differs: {key!r}")
        part_size = max(size, 5 * 1024 * 1024) if size <= target.single_put_max else 0
        target_client.fput_object(
            target.bucket, key, str(local_path), content_type=source_info.content_type,
            metadata=object_metadata(source_info), part_size=part_size, **target.write_args(),
        )
        if verify_etag:
            uploaded_probe = checksum_response(target_client, target, key)
            if (uploaded_probe and uploaded_probe.md5 == source_info.md5 and
                    same_object_info(source_info, uploaded_probe)):
                return "copied", size
        uploaded, uploaded_hash, _ = download_response(target_client, target, key)
        if not same_object_info(source_info, uploaded) or uploaded_hash != source_hash:
            raise RuntimeError(f"Verification failed after upload: {key!r}")
        return "copied", size


def copy_object(source_client, target_client, source: S3Config, target: S3Config,
                key: str, *, temp_dir: str | None = None, verify_only: bool = False,
                overwrite_changed: bool = False,
                use_if_match: bool = True,
                target_exists: bool | None = None,
                stream_metadata: bool = False,
                verify_etag: bool = False) -> tuple[str, int]:
    if stream_metadata or verify_etag:
        return copy_streaming(
            source_client, target_client, source, target, key, temp_dir=temp_dir,
            verify_only=verify_only, overwrite_changed=overwrite_changed,
            target_exists=target_exists,
            verify_etag=verify_etag,
        )
    source_info = source_client.stat_object(source.bucket, key, **source.read_args())
    # ListBucket is authoritative for a missing key. Some providers return
    # AccessDenied from HEAD on a missing object instead of NoSuchKey.
    existing = None if target_exists is False else target_stat(target_client, target, key)
    if verify_only and existing is None:
        raise RuntimeError(f"Target object is missing: {key!r}")

    with tempfile.TemporaryDirectory(prefix="s3-migration-", dir=temp_dir) as work_dir:
        # Never use an untrusted object key as a filesystem path.
        local_path = Path(work_dir) / "object"
        with local_path.open("wb") as output:
            source_hash, size = read_object(source_client, source, key, source_info, output,
                                            use_if_match=use_if_match)
        metadata = object_metadata(source_info)
        content_type = source_info.content_type or "application/octet-stream"
        if existing is not None:
            same = (existing.size == size and
                    (existing.content_type or "application/octet-stream") == content_type and
                    object_metadata(existing) == metadata)
            if same:
                same = read_object(target_client, target, key, existing,
                                   use_if_match=use_if_match)[0] == source_hash
            if same:
                return "verified", size
            if verify_only or not overwrite_changed:
                raise RuntimeError(
                    f"Target object differs: {key!r}; use --overwrite-changed to replace it"
                )

        # bucket.ru multipart workaround, matching storage.py's upload policy.
        part_size = max(size, 5 * 1024 * 1024) if size <= target.single_put_max else 0
        target_client.fput_object(
            target.bucket, key, str(local_path), content_type=content_type,
            metadata=metadata, part_size=part_size, **target.write_args(),
        )
        uploaded = target_stat(target_client, target, key)
        if (uploaded is None or uploaded.size != size or
                (uploaded.content_type or "application/octet-stream") != content_type or
                object_metadata(uploaded) != metadata or
                read_object(target_client, target, key, uploaded,
                            use_if_match=use_if_match)[0] != source_hash):
            raise RuntimeError(f"Verification failed after upload: {key!r}")
        return "copied", size


def migrate(source: S3Config, target: S3Config, *, workers: int = 2,
            dry_run: bool = False, verify_only: bool = False,
            overwrite_changed: bool = False, temp_dir: str | None = None,
            use_if_match: bool = True, stream_metadata: bool = False,
            verify_etag: bool = False) -> dict:
    validate_pair(source, target)
    if workers < 1:
        raise ValueError("workers must be positive")
    source_client, target_client = source.client(), target.client()
    for config, client in ((source, source_client), (target, target_client)):
        if not client.bucket_exists(config.bucket):
            raise ValueError(f"Bucket does not exist or is inaccessible: {config.bucket}")
    objects = source_client.list_objects(source.bucket, recursive=True)
    totals = {"copied": 0, "verified": 0, "planned": 0, "bytes": 0}
    if dry_run:
        for obj in objects:
            totals["planned"] += 1
            totals["bytes"] += obj.size
        return totals

    target_keys = {obj.object_name for obj in target_client.list_objects(target.bucket, recursive=True)}

    def work(obj):
        for attempt in range(3):
            try:
                result = copy_object(
                    source_client, target_client, source, target, obj.object_name,
                    temp_dir=temp_dir, verify_only=verify_only,
                    overwrite_changed=overwrite_changed, use_if_match=use_if_match,
                    target_exists=obj.object_name in target_keys, stream_metadata=stream_metadata,
                    verify_etag=verify_etag,
                )
                return obj.object_name, result, None
            except (S3Error, OSError, RuntimeError, urllib3.exceptions.HTTPError) as exc:
                code = exc.code if isinstance(exc, S3Error) else type(exc).__name__
                if attempt < 2:
                    logger.warning("retry %r (%s)", obj.object_name, code)
                    time.sleep(attempt + 1)
                else:
                    return obj.object_name, None, code

    failures = {}

    # Bound the queue: a large bucket must not allocate a future per object.
    with ThreadPoolExecutor(max_workers=workers) as executor:
        pending = set()
        exhausted = False
        while pending or not exhausted:
            while not exhausted and len(pending) < workers:
                obj = next(objects, None)
                if obj is None:
                    exhausted = True
                else:
                    pending.add(executor.submit(work, obj))
            if not pending:
                break
            done, pending = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                key, result, error = future.result()
                if error:
                    failures[error] = failures.get(error, 0) + 1
                    logger.error("copy failed %r (%s)", key, error)
                    continue
                status, size = result
                totals[status] += 1
                totals["bytes"] += size
                logger.info("%s %r (%d bytes)", status, key, size)
    if failures:
        totals["failed"] = sum(failures.values())
        totals["failure_codes"] = failures
    return totals


def main() -> int:
    parser = argparse.ArgumentParser(description="Copy and verify all current S3 objects")
    parser.add_argument("--source-env", type=Path, required=True)
    parser.add_argument("--target-env", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--temp-dir", help="Space for up to --workers full objects")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Read-only count of source objects")
    mode.add_argument("--verify-only", action="store_true", help="Compare bytes and metadata; no writes")
    parser.add_argument("--overwrite-changed", action="store_true",
                        help="Replace target objects that differ from the source")
    parser.add_argument("--no-if-match", action="store_true",
                        help="Guard reads with HEAD snapshots for providers with inconsistent ETags")
    parser.add_argument("--stream-metadata", action="store_true",
                        help="Read metadata and bytes from the same GET response; avoid extra HEAD requests")
    parser.add_argument("--verify-etag", action="store_true",
                        help="Use plaintext MD5 ETags from GET when available; fall back to full SHA-256 reads")
    parser.add_argument("--fresh-connections", action="store_true",
                        help="Avoid keep-alive reuse for providers that drop idle connections")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        totals = migrate(
            replace(S3Config.from_env(args.source_env), fresh_connections=args.fresh_connections),
            replace(S3Config.from_env(args.target_env), fresh_connections=args.fresh_connections),
            workers=args.workers, dry_run=args.dry_run, verify_only=args.verify_only,
            overwrite_changed=args.overwrite_changed, temp_dir=args.temp_dir,
            use_if_match=not args.no_if_match,
            stream_metadata=args.stream_metadata,
            verify_etag=args.verify_etag,
        )
    except (ValueError, OSError, S3Error, RuntimeError, urllib3.exceptions.HTTPError) as exc:
        # Avoid exception bodies/tracebacks which can contain credentials or signed URLs.
        if isinstance(exc, (ValueError, RuntimeError)):
            logger.error("%s", exc)
        elif isinstance(exc, S3Error):
            logger.error("S3 request failed (%s)", exc.code)
        else:
            logger.error("Migration stopped (%s); rerun to resume", type(exc).__name__)
        return 1
    logger.info("Completed: %s", totals)
    return 1 if totals.get("failed") else 0


if __name__ == "__main__":
    raise SystemExit(main())
