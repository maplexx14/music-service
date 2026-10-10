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
3. Слово, заменённое звуком той же громкости, огибающую не меняет (замер:
   shadowraze «skyline ryodan» — ни одного участка, хотя «на спидах»,
   «Юзаю drug» и «roll'ю» в цензурной версии другие). Тот же мастер совпадает
   по самой волне: выравниваем её с точностью до долей сэмпла и вычитаем —
   остаток по кадрам ~−13…−18 дБ, а заменённые слова встают пиками до 0…+3 дБ.
   Какая из двух версий цензурная, по остатку не сказать — вердикт altered.
4. Залив, ускоренный или замедленный вместе с высотой тона (тот же «skyline
   ryodan» на SoundCloud у артиста — на 3% медленнее и ниже релиза),
   chromaprint не узнаёт вовсе: он про ноты, а они сдвинуты. Сдвиг находится
   по среднему спектру; кандидат пересэмпливается обратно и сравнивается
   заново.

Зависимости: fpcalc (пакет libchromaprint-tools) и ffmpeg — внешние
бинарники, numpy (приходит с beets) — для пунктов 3 и 4, без него они
пропускаются. Сравнение пары треков — несколько секунд CPU, вызывать из
тредпула.
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

# Сравнение волн (пункт 3). Полоса голоса, как у огибающей.
_WAVE_RATE = 16000
# Сколько сэмплов вокруг найденного сдвига смотрит блок: остаточный дрейф
# темпа после подгонки — доли миллисекунды.
_WAVE_BLOCK = 0.5
_WAVE_SLACK = 16
# Остаток кадра выше медианного на столько — заменённый участок. Замер на
# «skyline ryodan» (Deezer, YouTube, SoundCloud в любых парах): медиана
# −13…−15 дБ, заменённые слова −1.4…+3.4 дБ; тот же трек из Deezer и YouTube
# (The Weeknd, Miyagi, сам «skyline ryodan» в цензурных версиях) — медиана
# −16…−18 дБ, ни одного кадра выше порога.
_WAVE_RISE_DB = 8.0
_WAVE_MIN_SEGMENT = 0.2
# Медиана выше — это не тот же мастер (другое сведение, ремастер): по волне
# судить не о чем.
_WAVE_SAME_MASTER_DB = -8.0
# И сам остаток участка не ниже этого: у копий без пережатия медиана бывает
# −70 дБ, и шум округления на её фоне — тоже «подъём».
_WAVE_FLOOR_DB = -10.0
# Цензура — отдельные слова. Расхождение длиннее — другая редакция (лишний
# куплет, интро), а не цензура.
_WAVE_MAX_SEGMENT = 4.0
# Выравнивание: окна по всей длине, корреляция окна не ниже порога.
_WAVE_POINTS = 12
_WAVE_MIN_CORR = 0.5

# Сдвиг тона (пункт 4): меньше — погрешность, chromaprint его и так терпит.
_RETUNE_MIN = 0.004
_RETUNE_MAX = 0.1
_RETUNE_MIN_CORR = 0.9
_RETUNE_GAIN = 0.1


@dataclass
class Comparison:
    # censored — та же запись, но есть заглушённые участки (тише в первой);
    # altered — та же запись, но отдельные слова заменены звуком той же
    # громкости — в какой из двух, по звуку не сказать;
    # same — та же запись без отличий; different — разные записи;
    # uncertain — совпадение частичное, решать не берёмся.
    verdict: str
    match: float
    rate: float = 1.0
    offset: float = 0.0
    # (начало в секундах по первой записи, длительность, разница в дБ;
    # минус — в первой записи тише; у altered — остаток волны в дБ).
    segments: list = field(default_factory=list)
    # Во сколько раз второй залив пришлось ускорить (с тоном), чтобы он совпал.
    retune: float = 1.0

    def as_dict(self) -> dict:
        result = {
            "verdict": self.verdict,
            "match": round(self.match, 3),
            "rate": round(self.rate, 4),
            "offset": round(self.offset, 2),
            "segments": [list(s) for s in self.segments],
        }
        if self.retune != 1.0:
            result["retune"] = round(self.retune, 5)
        return result


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


def _decode_wave(path: str):
    """Волна в полосе голоса, моно _WAVE_RATE."""
    import numpy as np

    raw = subprocess.run(
        [
            FFMPEG_BIN, "-v", "quiet", "-i", path, "-af", "highpass=f=300,lowpass=f=3400",
            "-ac", "1", "-ar", str(_WAVE_RATE), "-f", "s16le", "-",
        ],
        capture_output=True, timeout=_TIMEOUT,
    ).stdout
    return np.frombuffer(raw[: len(raw) - len(raw) % 2], dtype=np.int16).astype(np.float64) / 32768


def _mean_spectrum(wave):
    import numpy as np

    size, hop = 8192, 4096
    count = (len(wave) - size) // hop
    if count <= 0:
        return None
    index = np.arange(size)[None, :] + hop * np.arange(count)[:, None]
    return np.abs(np.fft.rfft(wave[index] * np.hanning(size), axis=1)).mean(axis=0)


def retune_factor(catalog_path: str, candidate_path: str) -> Optional[float]:
    """Во сколько раз ускорить кандидата (с тоном), чтобы он совпал с записью
    каталога, или None — тон тот же или записи разные.

    Средний спектр трека — гребёнка его нот и обертонов. У пересэмпленного
    залива она вся сдвинута в одно и то же число раз; ищем растяжение, при
    котором гребёнки совпадают (замер: «skyline ryodan» — корреляция 0.99 на
    0.97 против 0.27 без растяжения; разные записи — не выше 0.8).
    """
    import numpy as np

    a, b = _mean_spectrum(_decode_wave(catalog_path)), _mean_spectrum(_decode_wave(candidate_path))
    if a is None or b is None:
        return None
    freqs = np.fft.rfftfreq(8192, 1 / _WAVE_RATE)
    band = (freqs > 150) & (freqs < 3300)

    def comb(values):
        values = np.log(values + 1e-9)
        return values - np.convolve(values, np.ones(41) / 41, "same")

    reference = comb(a[band])

    def corr(scale: float) -> float:
        return float(np.corrcoef(reference, comb(np.interp(freqs[band] * scale, freqs, b)))[0, 1])

    coarse = np.arange(1 - _RETUNE_MAX, 1 + _RETUNE_MAX + 1e-9, 0.0025)
    best = coarse[int(np.argmax([corr(s) for s in coarse]))]
    fine = np.arange(best - 0.003, best + 0.003, 0.0002)
    scores = [corr(s) for s in fine]
    scale = float(fine[int(np.argmax(scores))])
    score = max(scores)
    if (
        abs(scale - 1) < _RETUNE_MIN
        or score < _RETUNE_MIN_CORR
        or score - corr(1.0) < _RETUNE_GAIN
    ):
        return None
    # Нота каталога f лежит у кандидата на scale·f: ускоряем в 1/scale раз.
    return 1 / scale


def _xcorr(x, y) -> tuple[int, float]:
    """Положение x внутри более длинного y и нормированная корреляция."""
    import numpy as np

    size = 1 << (len(x) + len(y) - 1).bit_length()
    full = np.fft.irfft(np.fft.rfft(y, size) * np.conj(np.fft.rfft(x, size)), size)
    values = full[: len(y) - len(x) + 1]
    k = int(np.argmax(values))
    norm = np.linalg.norm(x) * np.linalg.norm(y[k:k + len(x)])
    return k, float(values[k] / norm) if norm else 0.0


def _refine_map(a, b, rate: float, offset: float, search: float, window: float):
    """Точнее отображение времени b = rate·a + offset по корреляции волн."""
    import numpy as np

    duration = len(a) / _WAVE_RATE
    times, positions = [], []
    for t in np.linspace(_EDGE_HEAD + 2, duration - _EDGE_TAIL - 2 - window, _WAVE_POINTS):
        x = a[int(t * _WAVE_RATE):int((t + window) * _WAVE_RATE)]
        u = rate * t + offset
        start, end = int((u - search) * _WAVE_RATE), int((u + window + search) * _WAVE_RATE)
        if start < 0 or end > len(b) or not np.any(x):
            continue
        k, c = _xcorr(x, b[start:end])
        if c >= _WAVE_MIN_CORR:
            times.append(t)
            positions.append((start + k) / _WAVE_RATE)
    if len(times) < 4:
        return None
    slope, intercept = np.polyfit(times, positions, 1)
    return float(slope), float(intercept)


def replaced_segments(catalog_path: str, candidate_path: str, rate: float, offset: float) -> Optional[list]:
    """Участки, где волна той же записи расходится (см. пункт 3 в начале модуля).

    rate/offset — грубое отображение по chromaprint. None — сравнить нечем:
    нет numpy, волны не сошлись или это не тот же мастер.
    """
    try:
        import numpy as np
    except ImportError:
        return None
    a, b = _decode_wave(catalog_path), _decode_wave(candidate_path)
    if not len(a) or not len(b):
        return None
    # Chromaprint даёт отображение с точностью до кадра (0.12 с); волне нужны
    # доли миллисекунды — два прохода, второй с узким поиском.
    mapping = _refine_map(a, b, rate, offset, search=0.5, window=3.0)
    if mapping is not None:
        mapping = _refine_map(a, b, *mapping, search=0.02, window=4.0)
    if mapping is None:
        return None
    rate, offset = mapping
    block, slack = int(_WAVE_BLOCK * _WAVE_RATE), _WAVE_SLACK
    grid = np.arange(len(b))
    starts, lags = [], []
    for start in range(0, len(a) - block, block):
        x = a[start:start + block]
        positions = (rate * np.arange(start - slack, start + block + slack) / _WAVE_RATE + offset) * _WAVE_RATE
        if positions[0] < 0 or positions[-1] >= len(b) - 1:
            continue
        corr = np.correlate(np.interp(positions, grid, b), x, "valid")
        k = int(np.argmax(corr))
        shift = 0.0
        if 0 < k < len(corr) - 1:
            # Пик между сэмплами — по параболе.
            denom = corr[k - 1] - 2 * corr[k] + corr[k + 1]
            shift = 0.5 * (corr[k - 1] - corr[k + 1]) / denom if denom else 0.0
        starts.append(start)
        lags.append(k - slack + shift)
    if not starts:
        return None
    # Сдвиг блока — медиана соседей: у блока с заменённым словом свой пик
    # корреляции случаен, и с ним расходился бы весь блок, а не одно слово.
    lags = [float(np.median(lags[max(0, i - 2):i + 3])) for i in range(len(lags))]
    blocks, gains = [], []
    for start, lag in zip(starts, lags):
        x = a[start:start + block]
        positions = (rate * np.arange(start, start + block) / _WAVE_RATE + offset) * _WAVE_RATE
        y = np.interp(positions + lag * rate, grid, b)
        energy = np.dot(y, y)
        if energy:
            gains.append(np.dot(x, y) / energy)
        blocks.append((start, x, y))
    # Громкость у заливов разная (нормализация площадок) — одна на трек.
    gain = float(np.median(gains)) if gains else 1.0
    frame = int(_ENV_FRAME * _WAVE_RATE)
    starts, signal, residue = [], [], []
    for start, x, y in blocks:
        rest = x - gain * y
        count = len(x) // frame
        signal.append((x[:count * frame].reshape(count, frame) ** 2).mean(axis=1))
        residue.append((rest[:count * frame].reshape(count, frame) ** 2).mean(axis=1))
        starts.append(start / _WAVE_RATE + np.arange(count) * _ENV_FRAME)
    times, signal, residue = np.concatenate(starts), np.concatenate(signal), np.concatenate(residue)
    db = 10 * np.log10((residue + 1e-12) / (signal + 1e-12))
    loud = signal > np.percentile(signal, 20)
    median = float(np.median(db[loud]))
    if median > _WAVE_SAME_MASTER_DB:
        return None
    smooth = np.convolve(db, np.ones(5) / 5, "same")
    head, tail = _EDGE_HEAD + 1, times[-1] - _EDGE_TAIL
    segments = []
    begin = None
    for i in range(len(smooth) + 1):
        bad = (
            i < len(smooth)
            and head <= times[i] <= tail
            and loud[i]
            and smooth[i] >= max(median + _WAVE_RISE_DB, _WAVE_FLOOR_DB)
        )
        if bad and begin is None:
            begin = i
        elif not bad and begin is not None:
            length = (i - begin) * _ENV_FRAME
            if length >= _WAVE_MIN_SEGMENT:
                segments.append((
                    round(float(times[begin]), 2), round(length, 2),
                    round(float(smooth[begin:i].max()), 1),
                ))
            begin = None
    return segments


def compare(catalog_path: str, candidate_path: str) -> Optional[Comparison]:
    """Сравнивает запись каталога с кандидатом. None — сравнить нечем
    (fpcalc/ffmpeg не справились, слишком короткий файл).

    Кандидат, которого chromaprint не узнал, может быть той же записью в
    другом тоне (пункт 4): тогда он пересэмпливается и сравнивается заново.
    """
    result = _compare(catalog_path, candidate_path)
    if result is None or result.verdict != "different":
        return result
    try:
        factor = retune_factor(catalog_path, candidate_path)
    except ImportError:
        return result
    except (OSError, subprocess.SubprocessError):
        logger.warning("retune check failed: %s / %s", catalog_path, candidate_path, exc_info=True)
        return result
    if factor is None:
        return result
    import tempfile

    fd, retuned = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        subprocess.run(
            [
                FFMPEG_BIN, "-v", "quiet", "-y", "-i", candidate_path, "-af",
                f"aresample=44100,asetrate={44100 * factor:.3f},aresample=44100", retuned,
            ],
            capture_output=True, timeout=_TIMEOUT, check=True,
        )
        again = _compare(catalog_path, retuned)
    except (OSError, subprocess.SubprocessError):
        logger.warning("retune failed: %s", candidate_path, exc_info=True)
        return result
    finally:
        try:
            os.remove(retuned)
        except OSError:
            pass
    if again is None or again.verdict == "different":
        return result
    again.retune = factor
    return again


def _compare(catalog_path: str, candidate_path: str) -> Optional[Comparison]:
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
    if segments:
        return Comparison("censored", match, rate, offset, segments)
    try:
        replaced = replaced_segments(catalog_path, candidate_path, rate, offset)
    except (OSError, subprocess.SubprocessError):
        logger.warning("wave compare failed: %s / %s", catalog_path, candidate_path, exc_info=True)
        replaced = None
    if not replaced:
        return Comparison("same", match, rate, offset)
    if any(length > _WAVE_MAX_SEGMENT for _start, length, _db in replaced):
        return Comparison("uncertain", match, rate, offset, replaced)
    return Comparison("altered", match, rate, offset, replaced)
