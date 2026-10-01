"""Сравнение двух записей по звуку: та же ли это запись и где они расходятся.

Нужно для цензуры по закону РФ (app/censorship.py): цензурная версия трека —
это тот же мастер, в котором заглушены или запиканы отдельные слова. По
метаданным её не отличить («Клей» у CUPSIZE называется так же), по звуку —
можно:

1. Chromaprint (fpcalc) даёт отпечаток ~8 кадров в секунду. По окнам ~2 с
   ищем сдвиг, при котором окна совпадают: так узнаём, что это одна запись, и
   строим отображение времени. Оно линейное, но не тождественное: заливы
   расходятся по темпу на 1–3% (замер: «В этой оу е» против оригинала —
   коэффициент 0.98) и по тишине в начале.
2. Сам chromaprint слов не различает — он про гармонию, а заглушённое слово её
   почти не меняет (замер: все окна цензурной версии совпали с оригиналом).
   Поэтому дальше сравниваем огибающую громкости в полосе голоса
   (300–3400 Гц) по кадрам 50 мс вдоль найденного отображения. Цензура видна
   как участок ≥0.4 с, где громкость расходится на ≥6 дБ (замер: «В этой оу е»
   — −15 дБ на 70.0 с; «Клей» — −7…−8 дБ на 1.9 с против двух независимых
   перезаливов; два перезалива «Клей» между собой и пять нецензурных треков
   против своих заливов — ни одного участка).

Тяжёлых зависимостей нет: fpcalc (пакет libchromaprint-tools) и ffmpeg —
внешние бинарники, остальное — чистый Python. Сравнение пары треков — пара
секунд CPU, вызывать из тредпула.
"""
from __future__ import annotations

import array
import logging
import math
import os
import statistics
import subprocess
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)

FPCALC_BIN = os.getenv("FPCALC_BIN", "fpcalc")
FFMPEG_BIN = os.getenv("FFMPEG_BIN", "ffmpeg")

# Шаг кадра chromaprint: 4096/3 сэмпла при 11025 Гц.
_ITEM_SECONDS = 4096 / 3 / 11025
# Окно выравнивания: 16 кадров ≈ 2 с.
_WINDOW = 16
# Поиск сдвига окна: ±200 кадров ≈ ±25 с (тишина в начале, вырезанные куски).
_MAX_SHIFT = 200
_WINDOW_MATCH = 0.8
# Доля совпавших окон: выше — одна запись, ниже _DIFFERENT — разные.
_SAME_RECORDING = 0.8
_DIFFERENT = 0.6

_ENV_RATE = 8000
_ENV_FRAME = 0.05
_SMOOTH_FRAMES = 4
# ±2 кадра (±100 мс) — погрешность отображения времени между заливами.
_ALIGN_SLACK_FRAMES = 2
# Пороги подобраны на реальных парах (сравнение терпимо к сдвигу, см.
# _differing_segments): цензура — −7…−15 дБ на 0.45–1.45 с, нецензурные треки
# против своих заливов — не глубже −4.8 дБ.
_DIFF_DB = 6.0
_EXTEND_DB = 4.0
_MIN_SEGMENT = 0.4
# Края трека — тишина, фейды и обрезка у разных заливов разные.
_EDGE_HEAD = 1.0
_EDGE_TAIL = 2.0
_TIMEOUT = 120


@dataclass
class Comparison:
    # censored — та же запись, но есть заглушённые/изменённые участки;
    # same — та же запись без отличий; different — разные записи;
    # uncertain — совпадение частичное, решать не берёмся.
    verdict: str
    match: float
    rate: float = 1.0
    offset: float = 0.0
    # (начало в секундах по первой записи, длительность, разница в дБ;
    # минус — в первой записи тише).
    segments: list = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "verdict": self.verdict,
            "match": round(self.match, 3),
            "rate": round(self.rate, 4),
            "offset": round(self.offset, 2),
            "segments": [list(s) for s in self.segments],
        }


def available() -> bool:
    try:
        subprocess.run([FPCALC_BIN, "-version"], capture_output=True, timeout=10, check=True)
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def fingerprint(path: str) -> list[int]:
    result = subprocess.run(
        [FPCALC_BIN, "-raw", "-length", "0", path],
        capture_output=True, text=True, timeout=_TIMEOUT,
    )
    for line in result.stdout.splitlines():
        if line.startswith("FINGERPRINT="):
            return [int(v) & 0xFFFFFFFF for v in line.split("=", 1)[1].split(",") if v]
    return []


def _similarity(a: int, b: int) -> float:
    return 1 - bin(a ^ b).count("1") / 32


def _window_points(x: list[int], y: list[int]) -> tuple[list[tuple[int, int]], int]:
    """Совпавшие окна (кадр в x, кадр в y) и общее число окон."""
    points = []
    windows = 0
    for i in range(0, len(x) - _WINDOW + 1, _WINDOW):
        windows += 1
        best_sim, best_shift = 0.0, 0
        for shift in range(-_MAX_SHIFT, _MAX_SHIFT + 1):
            j = i + shift
            if j < 0 or j + _WINDOW > len(y):
                continue
            sim = sum(_similarity(x[i + k], y[j + k]) for k in range(_WINDOW)) / _WINDOW
            if sim > best_sim:
                best_sim, best_shift = sim, shift
        if best_sim >= _WINDOW_MATCH:
            points.append((i, i + best_shift))
    return points, windows


def _fit(points: list[tuple[int, int]]) -> tuple[float, float]:
    """y = rate·x + offset (Тейл–Сен: устойчив к случайно совпавшим окнам)."""
    slopes = [
        (q[1] - p[1]) / (q[0] - p[0])
        for n, p in enumerate(points)
        for q in points[n + 1:]
        if q[0] != p[0]
    ]
    rate = statistics.median(slopes) if slopes else 1.0
    offset = statistics.median(py - rate * px for px, py in points)
    return rate, offset * _ITEM_SECONDS


def vocal_envelope(path: str) -> list[float]:
    """Громкость (дБ) в полосе голоса по кадрам _ENV_FRAME."""
    raw = subprocess.run(
        [
            FFMPEG_BIN, "-v", "quiet", "-i", path, "-ac", "1", "-ar", str(_ENV_RATE),
            "-af", "highpass=f=300,lowpass=f=3400", "-f", "s16le", "-",
        ],
        capture_output=True, timeout=_TIMEOUT,
    ).stdout
    samples = array.array("h")
    samples.frombytes(raw[: len(raw) - len(raw) % 2])
    frame = int(_ENV_RATE * _ENV_FRAME)
    out = []
    for start in range(0, len(samples) - frame, frame):
        chunk = samples[start:start + frame]
        out.append(10 * math.log10(sum(v * v for v in chunk) / frame + 1))
    return out


def _differing_segments(ea: list[float], eb: list[float], rate: float, offset: float) -> list:
    if not ea or not eb:
        return []
    ma, mb = statistics.median(ea), statistics.median(eb)
    diffs = []
    slack = _ALIGN_SLACK_FRAMES
    for i, value in enumerate(ea):
        j = int(round((rate * i * _ENV_FRAME + offset) / _ENV_FRAME))
        near = [eb[n] - mb for n in range(j - slack, j + slack + 1) if 0 <= n < len(eb)]
        if not near:
            diffs.append(0.0)
            continue
        # Терпимость к погрешности выравнивания (десятки мс): «тише» — только
        # если тише ВСЕХ соседних кадров кандидата, «громче» — всех. Иначе
        # граница слова, сдвинутая на кадр, давала провал в −25 дБ (замер:
        # «Почему ты еще не фанат?» на 33.4 с).
        here = value - ma
        if here < min(near):
            diffs.append(here - min(near))
        elif here > max(near):
            diffs.append(here - max(near))
        else:
            diffs.append(0.0)
    k = _SMOOTH_FRAMES
    smooth = [
        sum(diffs[max(0, i - k):i + k + 1]) / len(diffs[max(0, i - k):i + k + 1])
        for i in range(len(diffs))
    ]
    head = int(_EDGE_HEAD / _ENV_FRAME)
    tail = len(smooth) - int(_EDGE_TAIL / _ENV_FRAME)
    # Гистерезис: участок — всё подряд, где разница не меньше _EXTEND_DB, если
    # внутри есть пик от _DIFF_DB. Иначе длина участка зависела бы от того, как
    # близко пик к порогу, а не от длины самого расхождения.
    segments = []
    start = None
    for i, value in enumerate(smooth + [0.0]):
        bad = head <= i < tail and abs(value) >= _EXTEND_DB
        if bad and start is None:
            start = i
        elif not bad and start is not None:
            peak = max(smooth[start:i], key=abs)
            if abs(peak) >= _DIFF_DB and (i - start) * _ENV_FRAME >= _MIN_SEGMENT:
                segments.append((
                    round(start * _ENV_FRAME, 2), round((i - start) * _ENV_FRAME, 2), round(peak, 1),
                ))
            start = None
    return segments


def compare(catalog_path: str, candidate_path: str) -> Optional[Comparison]:
    """Сравнивает запись каталога с кандидатом. None — сравнить нечем
    (fpcalc/ffmpeg не справились, слишком короткий файл)."""
    try:
        x, y = fingerprint(catalog_path), fingerprint(candidate_path)
    except (OSError, subprocess.SubprocessError):
        logger.warning("fingerprint failed: %s / %s", catalog_path, candidate_path, exc_info=True)
        return None
    if len(x) < _WINDOW * 5 or len(y) < _WINDOW * 5:
        return None
    points, windows = _window_points(x, y)
    match = len(points) / windows if windows else 0.0
    if match < _DIFFERENT or len(points) < 3:
        return Comparison("different", match)
    rate, offset = _fit(points)
    if not 0.9 <= rate <= 1.1:
        return Comparison("different", match, rate, offset)
    if match < _SAME_RECORDING:
        return Comparison("uncertain", match, rate, offset)
    try:
        segments = _differing_segments(
            vocal_envelope(catalog_path), vocal_envelope(candidate_path), rate, offset
        )
    except (OSError, subprocess.SubprocessError):
        logger.warning("envelope failed: %s / %s", catalog_path, candidate_path, exc_info=True)
        return Comparison("uncertain", match, rate, offset)
    return Comparison("censored" if segments else "same", match, rate, offset, segments)
