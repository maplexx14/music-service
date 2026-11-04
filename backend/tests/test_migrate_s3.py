"""Migration safety checks use in-memory S3 clients; no external requests."""

import base64
import hashlib
import io
import os
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from minio.error import S3Error
from minio.sse import SseCustomerKey

from app.scripts import migrate_s3 as migration


class Body(io.BytesIO):
    def read(self, size=-1, decode_content=False):
        return super().read(size)

    def release_conn(self):
        self.released = True


class FakeS3:
    def __init__(self, config, objects=None):
        self.config = config
        self.objects = dict(objects or {})
        self.uploads = []
        self.reads = []
        self.get_lengths = []
        self.bodies = []
        self.corrupt_upload = False
        self.conditional_reads_fail = False

    def bucket_exists(self, bucket):
        assert bucket == self.config.bucket
        return True

    def list_objects(self, bucket, recursive):
        assert bucket == self.config.bucket and recursive is True
        for key, (data, _, _) in list(self.objects.items()):
            yield SimpleNamespace(object_name=key, size=len(data))

    def _check_read(self, kwargs):
        assert isinstance(kwargs.get("ssec"), SseCustomerKey) == bool(self.config.sse_key)

    def stat_object(self, bucket, key, **kwargs):
        assert bucket == self.config.bucket
        self._check_read(kwargs)
        if key not in self.objects:
            raise S3Error("NoSuchKey", "missing", None, "request", "host", None)
        data, content_type, metadata = self.objects[key]
        return SimpleNamespace(
            size=len(data), content_type=content_type, metadata=metadata,
            etag=hashlib.md5(data).hexdigest(), version_id=None,
        )

    def get_object(self, bucket, key, request_headers=None, version_id=None, length=0, **kwargs):
        self._check_read(kwargs)
        data, _, _ = self.objects[key]
        assert request_headers is None or request_headers == {
            "If-Match": f'"{hashlib.md5(data).hexdigest()}"',
        }
        if request_headers and self.conditional_reads_fail:
            raise S3Error("PreconditionFailed", "provider ETag mismatch", None, "request", "host", None)
        self.reads.append(key)
        self.get_lengths.append(length)
        body = Body(data[:length] if length else data)
        _, content_type, metadata = self.objects[key]
        body.headers = {**metadata, "content-length": str(min(length, len(data)) if length else len(data)),
                        "content-type": content_type, "etag": '"' + hashlib.md5(data).hexdigest() + '"'}
        if length and data:
            body.headers['content-range'] = f'bytes 0-{min(length, len(data)) - 1}/{len(data)}'
        self.bodies.append(body)
        return body

    def fput_object(self, bucket, key, path, content_type, metadata, part_size, **kwargs):
        assert bucket == self.config.bucket
        assert Path(path).name == "object"
        assert isinstance(kwargs.get("sse"), SseCustomerKey) == bool(self.config.sse_key)
        data = Path(path).read_bytes()
        if self.corrupt_upload:
            data = b"!" * len(data)
        self.objects[key] = (data, content_type, dict(metadata))
        self.uploads.append((key, part_size))


@pytest.fixture
def pair():
    source = migration.S3Config(
        "s3.buckets.ru", "old", "ru-1", "old-access", "old-secret",
        sse_key=bytes(range(32)),
    )
    target = replace(source, bucket="bol", access_key="new-access", secret_key="new-secret")
    return source, target


def test_copy_preserves_keys_bytes_content_metadata_and_sse(pair, tmp_path):
    source, target = pair
    key = "music/external/ytmusic/../original.m4a"
    data = b"track audio" * 100
    original_metadata = {"X-Amz-Meta-Owner": "123", "Cache-Control": "private",
                         "Content-Encoding": "identity", "ETag": "do-not-copy"}
    src = FakeS3(source, {key: (data, "audio/mp4", original_metadata)})
    dst = FakeS3(target)

    assert migration.copy_object(src, dst, source, target, key, temp_dir=str(tmp_path)) == (
        "copied", len(data),
    )
    assert dst.objects[key] == (data, "audio/mp4", {
        "x-amz-meta-owner": "123", "cache-control": "private", "content-encoding": "identity",
    })
    assert src.objects[key][2] == original_metadata
    assert dst.uploads == [(key, 5 * 1024 * 1024)]
    assert all(body.closed and body.released for body in src.bodies + dst.bodies)
    assert list(tmp_path.iterdir()) == []


def test_resume_verifies_existing_content_instead_of_trusting_size_or_etag(pair):
    source, target = pair
    obj = (b"same content", "image/jpeg", {})
    src, dst = FakeS3(source, {"covers/a.jpg": obj}), FakeS3(target, {"covers/a.jpg": obj})
    assert migration.copy_object(src, dst, source, target, "covers/a.jpg") == ("verified", 12)
    assert src.reads == dst.reads == ["covers/a.jpg"]
    assert dst.uploads == []


@pytest.mark.parametrize("target_object", [
    (b"BBBB", "audio/mp4", {}),
    (b"AAAA", "image/jpeg", {}),
    (b"AAAA", "audio/mp4", {"Cache-Control": "public"}),
])
def test_conflicting_target_is_not_overwritten(pair, target_object):
    source, target = pair
    src = FakeS3(source, {"music/a": (b"AAAA", "audio/mp4", {})})
    dst = FakeS3(target, {"music/a": target_object})
    with pytest.raises(RuntimeError, match="Target object differs"):
        migration.copy_object(src, dst, source, target, "music/a")
    assert dst.objects["music/a"] == target_object
    assert dst.uploads == []


def test_final_pass_can_explicitly_replace_changed_content(pair):
    source, target = pair
    src = FakeS3(source, {"music/a": (b"new!", "audio/mp4", {})})
    dst = FakeS3(target, {"music/a": (b"old!", "audio/mp4", {})})
    assert migration.copy_object(src, dst, source, target, "music/a", overwrite_changed=True) == (
        "copied", 4,
    )
    assert dst.objects["music/a"][0] == b"new!"


@pytest.mark.parametrize("existing", [None, (b"BBBB", "audio/mp4", {})])
def test_verify_only_never_writes_even_with_overwrite_flag(pair, existing):
    source, target = pair
    src = FakeS3(source, {"music/a": (b"AAAA", "audio/mp4", {})})
    dst = FakeS3(target, {} if existing is None else {"music/a": existing})
    with pytest.raises(RuntimeError):
        migration.copy_object(src, dst, source, target, "music/a",
                              verify_only=True, overwrite_changed=True)
    assert dst.uploads == []


def test_corrupt_upload_fails_sha256_verification_and_cleans_up(pair, tmp_path):
    source, target = pair
    src = FakeS3(source, {"music/a": (b"AAAA", "audio/mp4", {})})
    dst = FakeS3(target)
    dst.corrupt_upload = True
    with pytest.raises(RuntimeError, match="Verification failed"):
        migration.copy_object(src, dst, source, target, "music/a", temp_dir=str(tmp_path))
    assert list(tmp_path.iterdir()) == []


def test_permission_error_is_not_treated_as_missing(pair, monkeypatch):
    source, target = pair
    src = FakeS3(source, {"music/a": (b"AAAA", "audio/mp4", {})})
    dst = FakeS3(target)

    def forbidden(*args, **kwargs):
        raise S3Error("AccessDenied", "denied", None, "request", "host", None)

    monkeypatch.setattr(dst, "stat_object", forbidden)
    with pytest.raises(S3Error, match="AccessDenied"):
        migration.copy_object(src, dst, source, target, "music/a")
    assert dst.uploads == src.reads == []


def test_inventory_missing_key_avoids_provider_denied_head_but_verifies_upload(pair, monkeypatch):
    source, target = pair
    src = FakeS3(source, {"music/a": (b"AAAA", "audio/mp4", {})})
    dst = FakeS3(target)
    stat = dst.stat_object

    def denied_if_missing(bucket, key, **kwargs):
        if key not in dst.objects:
            raise S3Error("AccessDenied", "missing keys return 403", None, "request", "host", None)
        return stat(bucket, key, **kwargs)

    monkeypatch.setattr(dst, "stat_object", denied_if_missing)
    monkeypatch.setattr(migration.S3Config, "client", lambda config: src if config is source else dst)
    assert migration.migrate(source, target)["copied"] == 1
    assert dst.reads == ["music/a"]


def test_truncated_read_is_rejected_and_connection_closed(pair):
    source, _ = pair
    src = FakeS3(source, {"music/a": (b"short", "audio/mp4", {})})
    info = src.stat_object(source.bucket, "music/a", **source.read_args())
    info.size += 1
    with pytest.raises(RuntimeError, match="Incomplete read"):
        migration.read_object(src, source, "music/a", info)
    assert src.bodies[0].closed and src.bodies[0].released


def test_sse_provider_with_different_head_and_get_etags_can_be_copied(pair):
    source, target = pair
    src = FakeS3(source, {"music/a": (b"AAAA", "audio/mp4", {})})
    dst = FakeS3(target)
    src.conditional_reads_fail = dst.conditional_reads_fail = True
    assert migration.copy_object(src, dst, source, target, "music/a") == ("copied", 4)
    assert dst.objects == src.objects


def test_head_guard_can_skip_known_broken_if_match(pair):
    source, target = pair
    src = FakeS3(source, {"music/a": (b"AAAA", "audio/mp4", {})})
    dst = FakeS3(target)
    src.conditional_reads_fail = dst.conditional_reads_fail = True
    assert migration.copy_object(src, dst, source, target, "music/a", use_if_match=False) == (
        "copied", 4,
    )


def test_head_guard_rejects_source_changed_during_read(pair, monkeypatch):
    source, target = pair
    src = FakeS3(source, {"music/a": (b"AAAA", "audio/mp4", {})})
    dst = FakeS3(target)
    stat = src.stat_object

    def changed_stat(*args, **kwargs):
        info = stat(*args, **kwargs)
        if src.reads:
            info.etag = "replaced-during-read"
        return info

    monkeypatch.setattr(src, "stat_object", changed_stat)
    with pytest.raises(RuntimeError, match="Object changed while being read"):
        migration.copy_object(src, dst, source, target, "music/a", use_if_match=False)
    assert dst.uploads == []


def test_response_metadata_copy_avoids_all_head_requests(pair, monkeypatch):
    source, target = pair
    key = "music/a"
    src = FakeS3(source, {key: (b"AAAA", "audio/mp4", {"Cache-Control": "private"})})
    dst = FakeS3(target)

    def no_head(*args, **kwargs):
        pytest.fail("GET metadata mode must not issue HEAD")

    monkeypatch.setattr(src, "stat_object", no_head)
    monkeypatch.setattr(dst, "stat_object", no_head)
    assert migration.copy_object(src, dst, source, target, key, stream_metadata=True,
                                 target_exists=False) == ("copied", 4)
    assert dst.objects[key] == (b"AAAA", "audio/mp4", {"cache-control": "private"})
    assert src.reads == dst.reads == [key]
    assert migration.copy_object(src, dst, source, target, key, stream_metadata=True,
                                 target_exists=True, verify_only=True) == ("verified", 4)


def test_response_metadata_copy_detects_corrupt_target(pair):
    source, target = pair
    src = FakeS3(source, {"music/a": (b"AAAA", "audio/mp4", {})})
    dst = FakeS3(target)
    dst.corrupt_upload = True
    with pytest.raises(RuntimeError, match="Verification failed"):
        migration.copy_object(src, dst, source, target, "music/a", stream_metadata=True,
                              target_exists=False)


def test_verified_plaintext_etag_avoids_full_target_download_and_checks_resume(pair):
    source, target = pair
    data = b"original audio bytes" * 100
    src = FakeS3(source, {"music/a": (data, "audio/mp4", {})})
    dst = FakeS3(target)
    assert migration.copy_object(src, dst, source, target, "music/a", verify_etag=True,
                                 target_exists=False) == ("copied", len(data))
    assert src.get_lengths == [0] and dst.get_lengths == [1]
    src.get_lengths.clear(); dst.get_lengths.clear(); dst.uploads.clear()
    assert migration.copy_object(src, dst, source, target, "music/a", verify_etag=True,
                                 target_exists=True, verify_only=True) == ("verified", len(data))
    assert src.get_lengths == dst.get_lengths == [1]
    assert dst.uploads == []


def test_etag_verification_falls_back_to_sha256_on_checksum_mismatch(pair):
    source, target = pair
    src = FakeS3(source, {"music/a": (b"AAAA", "audio/mp4", {})})
    dst = FakeS3(target)
    dst.corrupt_upload = True
    with pytest.raises(RuntimeError, match="Verification failed"):
        migration.copy_object(src, dst, source, target, "music/a", verify_etag=True,
                              target_exists=False)
    assert dst.get_lengths == [1, 0]


def test_etag_verification_handles_zero_length_folder_objects(pair):
    source, target = pair
    src = FakeS3(source, {"folder/": (b"", "application/octet-stream", {})})
    dst = FakeS3(target)
    assert migration.copy_object(src, dst, source, target, "folder/", verify_etag=True,
                                 target_exists=False) == ("copied", 0)


def test_fresh_connection_pool_preserves_signed_headers_and_disables_reuse(monkeypatch):
    original = {"Authorization": "signed-request", "X-Amz-Date": "timestamp"}
    seen = {}

    def capture(self, method, url, **kwargs):
        seen.update(kwargs)
        return "response"

    monkeypatch.setattr(migration.urllib3.PoolManager, "urlopen", capture)
    assert migration.FreshConnectionsPool().urlopen("GET", "https://s3.example", headers=original) == "response"
    assert seen["headers"] == {**original, "Connection": "close"}
    assert original == {"Authorization": "signed-request", "X-Amz-Date": "timestamp"}


def test_failed_object_does_not_stop_other_copies_and_is_reported(pair, monkeypatch):
    source, target = pair
    src = FakeS3(source, {"music/bad": (b"bad", "audio/mp4", {}),
                          "music/good": (b"good", "audio/mp4", {})})
    dst = FakeS3(target)
    get = src.get_object

    def denied_key(bucket, key, **kwargs):
        if key == "music/bad":
            raise S3Error("AccessDenied", "denied", None, "request", "host", None)
        return get(bucket, key, **kwargs)

    monkeypatch.setattr(src, "get_object", denied_key)
    monkeypatch.setattr(migration.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(migration.S3Config, "client", lambda config: src if config is source else dst)
    result = migration.migrate(source, target, stream_metadata=True)
    assert result["copied"] == 1 and result["failed"] == 1
    assert result["failure_codes"] == {"AccessDenied": 1}
    assert dst.objects["music/good"][0] == b"good"


def test_dry_run_counts_all_prefixes_without_reading_or_writing(pair, monkeypatch):
    source, target = pair
    src = FakeS3(source, {
        "music/a": (b"aaa", "audio/mp4", {}),
        "covers/b": (b"bb", "image/jpeg", {}),
        "other/empty/": (b"", "application/octet-stream", {}),
    })
    dst = FakeS3(target)
    monkeypatch.setattr(migration.S3Config, "client", lambda config: src if config is source else dst)
    assert migration.migrate(source, target, dry_run=True) == {
        "copied": 0, "verified": 0, "planned": 3, "bytes": 5,
    }
    assert src.reads == dst.reads == dst.uploads == []


def test_parallel_copy_all_objects_and_second_pass_verify_only(pair, monkeypatch):
    source, target = pair
    originals = {f"music/{i}": (str(i).encode(), "audio/mp4", {}) for i in range(12)}
    originals["other/empty/"] = (b"", "application/octet-stream", {})
    src, dst = FakeS3(source, originals), FakeS3(target)
    monkeypatch.setattr(migration.S3Config, "client", lambda config: src if config is source else dst)
    copied = migration.migrate(source, target, workers=3)
    assert copied["copied"] == 13
    assert dst.objects == originals == src.objects
    dst.uploads.clear()
    verified = migration.migrate(source, target, workers=3, verify_only=True)
    assert verified["verified"] == 13 and verified["copied"] == 0
    assert dst.uploads == []


def test_small_threshold_keeps_large_upload_multipart(pair):
    source, target = pair
    target = replace(target, single_put_max=3)
    src = FakeS3(source, {"music/a": (b"AAAA", "audio/mp4", {})})
    dst = FakeS3(target)
    migration.copy_object(src, dst, source, target, "music/a")
    assert dst.uploads == [("music/a", 0)]


def test_validate_pair_rejects_self_copy_and_removing_encryption(pair):
    source, target = pair
    with pytest.raises(ValueError, match="same account"):
        migration.validate_pair(source, source)
    with pytest.raises(ValueError, match="Source uses SSE-C"):
        migration.validate_pair(source, replace(target, sse_key=None))
    migration.validate_pair(source, replace(target, bucket=source.bucket))


def test_env_parser_normalizes_endpoint_and_does_not_interpolate_secrets(tmp_path, monkeypatch):
    path = tmp_path / "target.env"
    monkeypatch.setenv("S3_SECRET_KEY", "active-secret")
    encoded = base64.b64encode(bytes(range(32))).decode()
    path.write_text(
        "S3_ENDPOINT=https://s3.buckets.ru/\nS3_REGION=ru-1\nS3_BUCKET=bol\n"
        "S3_ACCESS_KEY=new-access\nS3_SECRET_KEY='${S3_SECRET_KEY}'\n"
        f"S3_SSE_C_KEY={encoded}\n", encoding="utf-8-sig",
    )
    config = migration.S3Config.from_env(path)
    assert config.endpoint == "s3.buckets.ru" and config.secure
    assert config.secret_key == "${S3_SECRET_KEY}"
    assert config.sse_key == bytes(range(32))
    assert "new-access" not in repr(config) and "${S3_SECRET_KEY}" not in repr(config)
    assert os.environ["S3_SECRET_KEY"] == "active-secret"


@pytest.mark.parametrize("extra", [
    "S3_SSE_C_KEY=not-base64!\n",
    "S3_SSE_C_KEY=YWJj\n",
    "S3_SINGLE_PUT_MAX_MB=0\n",
    "S3_ENDPOINT=https://s3.buckets.ru/path\n",
    "S3_ENDPOINT=https://user:password@s3.buckets.ru/\n",
])
def test_invalid_env_is_rejected_without_echoing_credentials(tmp_path, extra):
    path = tmp_path / "target.env"
    path.write_text(
        "S3_ENDPOINT=https://s3.buckets.ru/\nS3_BUCKET=bol\n"
        "S3_ACCESS_KEY=private-access\nS3_SECRET_KEY=private-secret\n" + extra,
        encoding="utf-8",
    )
    with pytest.raises(ValueError) as caught:
        migration.S3Config.from_env(path)
    assert "private-access" not in str(caught.value)
    assert "private-secret" not in str(caught.value)
