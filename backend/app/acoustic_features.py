"""Offline acoustic content profiles for recommendation ranking.

Beets owns media decoding metadata through ``Item.from_path``.  ffmpeg then
decodes a bounded mono excerpt so the recommender can compare actual signal
properties without adding a large scientific Python stack to the API image.
Analysis is best-effort: a missing binary, unreadable file, or old deployment
without beets leaves the track unprofiled and never breaks upload or playback.
"""

from __future__ import annotations

import logging
import math
import os
import subprocess
import sys
import tempfile
from array import array
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Optional

from app import storage

logger = logging.getLogger(__name__)

ANALYZER_VERSION = "beets-ffmpeg-v1"
SAMPLE_RATE = 8000
ANALYSIS_SECONDS = max(15, int(os.getenv("ACOUSTIC_ANALYSIS_SECONDS", "60")))
FFMPEG_BIN = os.getenv("FFMPEG_BIN", "ffmpeg")
# Below this point an audio vector is too far from the user's centroid to be a
# useful independent candidate source. It may still enter through artist,
# genre, collaborative, or provider signals and compete with its lower score.
MIN_RECOMMENDATION_SIMILARITY = 0.55

FEATURE_NAMES = (
    "tempo",
    "loudness",
    "dynamics",
    "brightness",
    "bass",
    "zero_crossing",
    "pulse_clarity",
)

_FEATURE_WEIGHTS = {
    "tempo": 1.35,
    "loudness": 0.65,
    "dynamics": 0.8,
    "brightness": 1.05,
    "bass": 1.0,
    "zero_crossing": 0.65,
    "pulse_clarity": 0.8,
}


def _clamp(value: Any, low: float = 0.0, high: float = 1.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return low
    if not math.isfinite(number):
        return low
    return max(low, min(high, number))


def normalize_features(features: Any) -> dict[str, float]:
    """Return the stable 0..1 recommendation vector from stored JSON."""
    if not isinstance(features, Mapping):
        return {}
    vector = features.get("vector", features)
    if not isinstance(vector, Mapping):
        return {}
    normalized = {
        name: _clamp(vector.get(name))
        for name in FEATURE_NAMES
        if vector.get(name) is not None
    }
    return normalized if len(normalized) >= 3 else {}


def weighted_centroid(
    rows: Iterable[tuple[Any, float]],
) -> dict[str, float]:
    """Build a user acoustic profile from weighted track feature vectors."""
    totals = {name: 0.0 for name in FEATURE_NAMES}
    weights = {name: 0.0 for name in FEATURE_NAMES}
    for raw_features, raw_weight in rows:
        vector = normalize_features(raw_features)
        try:
            weight = max(0.0, float(raw_weight))
        except (TypeError, ValueError):
            continue
        if not vector or weight <= 0.0:
            continue
        for name, value in vector.items():
            totals[name] += value * weight
            weights[name] += weight
    centroid = {
        name: totals[name] / weights[name]
        for name in FEATURE_NAMES
        if weights[name] > 0.0
    }
    return centroid if len(centroid) >= 3 else {}


def acoustic_similarity(features: Any, centroid: Any) -> float:
    """Return acoustic similarity in 0..1, or 0 when either side is unknown."""
    vector = normalize_features(features)
    target = normalize_features(centroid)
    common = [name for name in FEATURE_NAMES if name in vector and name in target]
    if len(common) < 3:
        return 0.0
    total_weight = sum(_FEATURE_WEIGHTS[name] for name in common)
    squared_distance = sum(
        _FEATURE_WEIGHTS[name] * (vector[name] - target[name]) ** 2
        for name in common
    ) / total_weight
    # exp gives close matches a useful separation while smoothly retaining
    # imperfect candidates instead of creating another hard content gate.
    return math.exp(-3.25 * math.sqrt(max(0.0, squared_distance)))


def _beets_media(path: Path) -> Optional[dict[str, Any]]:
    try:
        from beets.library import Item
    except ImportError:
        logger.info("acoustic analysis disabled: beets is not installed")
        return None

    try:
        item = Item.from_path(str(path))
    except Exception:
        logger.exception("beets could not read audio metadata: %s", path)
        return None

    result: dict[str, Any] = {}
    fields = {
        "duration": "length",
        "bitrate": "bitrate",
        "sample_rate": "samplerate",
        "channels": "channels",
        "bit_depth": "bitdepth",
        "format": "format",
        "tagged_bpm": "bpm",
    }
    for output_name, field_name in fields.items():
        value = getattr(item, field_name, None)
        if value not in (None, ""):
            result[output_name] = value
    return result


def _decode_excerpt(path: Path, duration: float) -> Optional[array]:
    start = min(15.0, max(0.0, duration * 0.1)) if duration > 0 else 0.0
    command = [
        FFMPEG_BIN,
        "-v",
        "error",
        "-ss",
        f"{start:.3f}",
        "-i",
        str(path),
        "-map",
        "0:a:0",
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE),
        "-t",
        str(ANALYSIS_SECONDS),
        "-f",
        "s16le",
        "pipe:1",
    ]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            timeout=max(90, ANALYSIS_SECONDS * 3),
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        logger.exception("ffmpeg acoustic decode failed: %s", path)
        return None
    if result.returncode != 0 or len(result.stdout) < SAMPLE_RATE * 2:
        logger.warning(
            "ffmpeg acoustic decode returned no usable audio for %s: %s",
            path,
            result.stderr.decode("utf-8", "ignore")[-500:],
        )
        return None
    samples = array("h")
    samples.frombytes(result.stdout)
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


def _percentile(sorted_values: list[float], quantile: float) -> float:
    if not sorted_values:
        return 0.0
    index = int(round((len(sorted_values) - 1) * quantile))
    return sorted_values[max(0, min(len(sorted_values) - 1, index))]


def _tempo(onsets: list[float], frames_per_second: float) -> tuple[float, float]:
    if len(onsets) < 16 or not any(onsets):
        return 0.0, 0.0
    norm = math.sqrt(sum(value * value for value in onsets)) or 1.0
    best_bpm = 0.0
    best_score = 0.0
    for bpm in range(60, 201):
        lag = max(1, round(frames_per_second * 60.0 / bpm))
        if lag >= len(onsets):
            continue
        correlation = sum(
            onsets[index] * onsets[index - lag]
            for index in range(lag, len(onsets))
        )
        score = correlation / (norm * norm)
        if score > best_score:
            best_score = score
            best_bpm = float(bpm)
    return best_bpm, _clamp(best_score * 4.0)


def _signal_features(samples: array) -> Optional[dict[str, Any]]:
    count = len(samples)
    if count < SAMPLE_RATE:
        return None
    scale = 32768.0
    squares = sum((sample / scale) ** 2 for sample in samples)
    rms = math.sqrt(squares / count)
    if rms <= 1e-7:
        return None

    peak = max(abs(sample) for sample in samples) / scale
    zero_crossings = sum(
        1
        for previous, current in zip(samples, samples[1:])
        if (previous < 0 <= current) or (previous >= 0 > current)
    )
    zcr = zero_crossings / max(1, count - 1)

    diff_squares = sum(
        ((current - previous) / scale) ** 2
        for previous, current in zip(samples, samples[1:])
    )
    diff_rms = math.sqrt(diff_squares / max(1, count - 1))
    brightness = _clamp(diff_rms / (2.0 * rms))

    # One-pole low-pass energy is a robust bass proxy and much cheaper than a
    # full FFT for the bounded, low-resolution profile needed by ranking.
    alpha = math.exp(-2.0 * math.pi * 250.0 / SAMPLE_RATE)
    low = 0.0
    low_squares = 0.0
    for sample in samples:
        value = sample / scale
        low = alpha * low + (1.0 - alpha) * value
        low_squares += low * low
    bass_ratio = _clamp(math.sqrt(low_squares / count) / rms)

    frame_size = 512
    energies: list[float] = []
    for offset in range(0, count - frame_size + 1, frame_size):
        frame = samples[offset : offset + frame_size]
        frame_rms = math.sqrt(
            sum((sample / scale) ** 2 for sample in frame) / frame_size
        )
        energies.append(frame_rms)
    sorted_energies = sorted(energies)
    p20 = _percentile(sorted_energies, 0.2)
    p90 = _percentile(sorted_energies, 0.9)
    dynamics = _clamp((p90 - p20) / max(p90, 1e-6))

    onsets: list[float] = []
    for index, energy in enumerate(energies):
        previous = energies[max(0, index - 4) : index]
        baseline = sum(previous) / len(previous) if previous else energy
        onsets.append(max(0.0, energy - baseline))
    bpm, pulse_clarity = _tempo(onsets, SAMPLE_RATE / frame_size)

    dbfs = 20.0 * math.log10(rms)
    vector = {
        "tempo": _clamp((bpm - 50.0) / 170.0) if bpm else 0.0,
        "loudness": _clamp((dbfs + 60.0) / 60.0),
        "dynamics": dynamics,
        "brightness": brightness,
        "bass": bass_ratio,
        "zero_crossing": _clamp(zcr / 0.25),
        "pulse_clarity": pulse_clarity,
    }
    return {
        "vector": {name: round(value, 6) for name, value in vector.items()},
        "signal": {
            "bpm": round(bpm, 2),
            "dbfs": round(dbfs, 3),
            "peak": round(peak, 6),
            "sample_seconds": round(count / SAMPLE_RATE, 2),
        },
    }


def analyze_file(path: str | Path) -> Optional[dict[str, Any]]:
    """Analyze one local audio file and return JSON-serializable features."""
    local_path = Path(path)
    if not local_path.is_file():
        return None
    media = _beets_media(local_path)
    if media is None:
        return None
    try:
        duration = float(media.get("duration") or 0.0)
    except (TypeError, ValueError):
        duration = 0.0
    samples = _decode_excerpt(local_path, duration)
    if samples is None:
        return None
    signal = _signal_features(samples)
    if signal is None:
        return None
    return {
        "version": ANALYZER_VERSION,
        "vector": signal["vector"],
        "signal": signal["signal"],
        "media": media,
    }


def _local_music_path(file_path: str) -> Path:
    candidate = Path(file_path)
    if candidate.is_file():
        return candidate
    music_dir = Path(
        os.getenv(
            "MUSIC_FILES_DIR",
            os.path.join(os.path.dirname(__file__), "..", "..", "music_files"),
        )
    )
    return music_dir / candidate.name


@contextmanager
def local_audio_path(file_path: Optional[str]) -> Iterator[Optional[Path]]:
    """Resolve a local or MinIO track path for offline/backfill analysis."""
    if not file_path:
        yield None
        return
    if not storage.is_minio_path(file_path):
        path = _local_music_path(file_path)
        yield path if path.is_file() else None
        return

    suffix = Path(storage.parse_object_path(file_path)[1]).suffix or ".audio"
    fd, temp_path = tempfile.mkstemp(suffix=suffix)
    os.close(fd)
    try:
        storage.download_music_file(file_path, temp_path)
        yield Path(temp_path)
    except Exception:
        logger.exception("could not download track for acoustic analysis: %s", file_path)
        yield None
    finally:
        try:
            os.unlink(temp_path)
        except OSError:
            pass


def analyze_track(track: Any, *, local_path: str | Path | None = None) -> bool:
    """Analyze and mutate a Track-like object; the caller owns persistence."""
    if local_path is not None:
        features = analyze_file(local_path)
    else:
        with local_audio_path(getattr(track, "file_path", None)) as resolved:
            features = analyze_file(resolved) if resolved is not None else None
    if not features:
        return False
    track.acoustic_features = features
    track.acoustic_analyzed_at = datetime.now(timezone.utc)
    track.acoustic_analyzer_version = ANALYZER_VERSION
    return True
