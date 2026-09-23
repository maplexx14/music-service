"""AAC transcoding for smaller, faster-loading audio files.

All tracks are transcoded to AAC-LC at a controlled bitrate before serving.
AAC is universally supported in browsers (Safari, Chrome, Firefox, Edge)
and provides ~30-50% size reduction over MP3 at equivalent quality.

Two integration points:
    * upload_track  — transcodes uploaded files before storing in MinIO
    * archive_track — transcodes downloaded external tracks before archiving
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import tempfile
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# ─────────────────────────── configuration ───────────────────────────

# AAC bitrate in kbps. 128 = transparent quality for most listeners.
# Set via env to allow tuning without code changes.
AAC_BITRATE = os.getenv("AAC_BITRATE", "128")

# AAC sample rate. 44100 preserves original; 48000 for broadcast-standard.
AAC_SAMPLE_RATE = os.getenv("AAC_SAMPLE_RATE", "44100")

# Whether transcoding is enabled. Set to "0" to disable (passthrough original).
TRANSCODE_ENABLED = os.getenv("TRANSCODE_ENABLED", "1").strip() not in ("0", "false", "no")

# File extension for transcoded output.
AAC_EXT = ".m4a"
AAC_CONTENT_TYPE = "audio/mp4"

# ffmpeg binary path (auto-detected or explicit).
FFMPEG_BIN = os.getenv("FFMPEG_BIN", "ffmpeg")
FFPROBE_BIN = os.getenv("FFPROBE_BIN", "ffprobe")

# ───────────────── низкобитрейтный вариант (медленные каналы) ─────────────────
#
# 128 kbps — это 16 КБ/с аудио в реальном времени, то есть пятиминутный трек
# весит ~4.7 МБ. На канале 25-60 КБ/с (мобильный интернет) такой трек тянется
# минутами, и никакая настройка сервера этого не меняет: байтов столько.
# Вдвое меньший вариант (HE-AAC v1, 64 kbps) играет в реальном времени уже при
# 8 КБ/с, а SBR возвращает верхнюю октаву, поэтому на слух он ближе к 128k LC,
# чем к обычному 64k LC.
LOW_AAC_BITRATE = os.getenv("LOW_AAC_BITRATE", "64")

# Суффикс имени объекта: external/ytmusic/<id>.m4a → external/ytmusic/<id>.low.m4a
LOW_AAC_SUFFIX = ".low"

# fdkaac — CLI над libfdk-aac, единственный доступный нам энкодер HE-AAC.
# Нативный энкодер ffmpeg HE-AAC не умеет (см. комментарий в Dockerfile).
FDKAAC_BIN = os.getenv("FDKAAC_BIN", "fdkaac")

# Сколько ждём связку decode|encode на один трек. Пятиминутный трек кодируется
# единицы секунд; запас нужен, чтобы запрос стрима не висел на этом вечно.
LOW_AAC_TIMEOUT = int(os.getenv("LOW_AAC_TIMEOUT", "120"))

# Насколько битрейт уже-AAC файла может превышать цель, чтобы его не трогать.
# 1.3 — запас на контейнерный оверхед и VBR-разброс.
_AAC_BITRATE_TOLERANCE = 1.3


# ─────────────────────────── helpers ───────────────────────────

def _ffmpeg_available() -> bool:
    """Check that ffmpeg is installed and callable."""
    return shutil.which(FFMPEG_BIN) is not None


def _fdkaac_available() -> bool:
    """Есть ли fdkaac (libfdk-aac). Без него HE-AAC недоступен, и низкий
    вариант кодируется обычным LC — качество хуже, байтов столько же."""
    return shutil.which(FDKAAC_BIN) is not None


def _bitrate_kbps_value(bitrate: str) -> str:
    """'64' и '64k' → '64' — fdkaac и ffmpeg по-разному понимают суффикс."""
    digits = "".join(ch for ch in str(bitrate) if ch.isdigit())
    return digits or LOW_AAC_BITRATE


def _bitrate_kbps_float(bitrate) -> Optional[float]:
    """Тот же разбор в число — для сравнения с измеренным битрейтом."""
    try:
        return float(_bitrate_kbps_value(bitrate))
    except (TypeError, ValueError):
        return None


def _probe_duration(input_path: str) -> Optional[float]:
    """Get audio duration in seconds via ffprobe."""
    try:
        import subprocess
        result = subprocess.run(
            [
                FFPROBE_BIN,
                "-v", "quiet",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                input_path,
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        return float(result.stdout.strip()) if result.returncode == 0 else None
    except Exception:
        return None


def _probe_audio_format(input_path: str) -> tuple[Optional[str], Optional[float]]:
    """(codec_name, эффективный битрейт в kbps) через ffprobe.

    Битрейт считаем по размеру файла и длительности, а не берём из
    ``stream.bit_rate``: у m4a он часто отсутствует, а у VBR-потоков занижен.
    Ошибка или таймаут → (None, None): неизвестность не должна ронять
    транскодинг.
    """
    try:
        import subprocess

        result = subprocess.run(
            [
                FFPROBE_BIN,
                "-v", "quiet",
                "-select_streams", "a:0",
                "-show_entries", "stream=codec_name",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1",
                input_path,
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode != 0:
            return None, None
        values = {}
        for line in result.stdout.splitlines():
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip()
        codec = values.get("codec_name") or None
        try:
            duration = float(values.get("duration") or 0)
            size = os.path.getsize(input_path)
        except (TypeError, ValueError, OSError):
            return codec, None
        if duration <= 0 or size <= 0:
            return codec, None
        return codec, size * 8 / duration / 1000
    except Exception:
        return None, None


def is_already_aac(input_path: str, target_kbps: Optional[float] = None) -> bool:
    """Уже AAC и не жирнее цели → перекодировать не нужно.

    Раньше здесь стояло «расширение .m4a/.aac ИЛИ кодек в (aac, alac)», то есть
    любой m4a проходил без проверки, а ALAC (lossless, ~1000 kbps) считался
    готовым AAC. Такие файлы лежали в MinIO как есть: 30-50 МБ на трек, минуты
    загрузки на телефоне. Теперь решают кодек И битрейт — ALAC и завышенный AAC
    уходят в перекодирование наравне со всем, что не AAC.
    """
    codec, measured_kbps = _probe_audio_format(input_path)
    if codec != "aac":
        return False
    if target_kbps is None or measured_kbps is None:
        # Кодек AAC, битрейт неизвестен — считаем готовым: перекодировать
        # вслепую дороже, чем оставить как есть.
        return True
    return measured_kbps <= target_kbps * _AAC_BITRATE_TOLERANCE


def transcode_to_aac(
    input_path: str,
    output_path: Optional[str] = None,
    bitrate: Optional[str] = None,
    sample_rate: Optional[str] = None,
) -> str:
    """Transcode an audio file to AAC-LC.

    Returns the path to the output file. If transcoding is disabled or the
    input is already AAC, returns the input path unchanged.
    """
    if not TRANSCODE_ENABLED:
        return input_path

    if not _ffmpeg_available():
        logger.warning("transcode: ffmpeg not found, serving original file")
        return input_path

    if is_already_aac(input_path, target_kbps=_bitrate_kbps_float(bitrate)):
        return input_path

    if output_path is None:
        fd, output_path = tempfile.mkstemp(suffix=AAC_EXT)
        os.close(fd)

    bitrate = bitrate or AAC_BITRATE
    sample_rate = sample_rate or AAC_SAMPLE_RATE

    cmd = [
        FFMPEG_BIN,
        "-y",                    # overwrite output
        "-i", input_path,
        "-c:a", "aac",           # AAC-LC codec
        "-b:a", f"{bitrate}k",   # target bitrate
        "-ar", sample_rate,      # sample rate
        "-ac", "2",              # stereo
        "-movflags", "+faststart",  # moov atom at start for streaming
        "-vn",                   # strip video tracks
        "-loglevel", "error",
        output_path,
    ]

    try:
        import subprocess
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            logger.warning("transcode failed: %s", result.stderr[:500])
            # Clean up failed output
            try:
                os.unlink(output_path)
            except OSError:
                pass
            return input_path

        # Verify output is valid and non-empty
        if os.path.getsize(output_path) < 1024:
            logger.warning("transcode output too small, using original")
            try:
                os.unlink(output_path)
            except OSError:
                pass
            return input_path

        logger.info(
            "transcoded %s → %s (%s kbps)",
            Path(input_path).name,
            Path(output_path).name,
            bitrate,
        )
        return output_path

    except subprocess.TimeoutExpired:
        logger.warning("transcode timed out for %s", input_path)
        try:
            os.unlink(output_path)
        except OSError:
            pass
        return input_path
    except Exception:
        logger.exception("transcode error for %s", input_path)
        try:
            os.unlink(output_path)
        except OSError:
            pass
        return input_path


# ─────────────────── низкобитрейтный вариант: HE-AAC ───────────────────


def low_variant_key(key: str) -> str:
    """Ключ низкобитрейтного варианта: ``a/b.m4a`` → ``a/b.low.m4a``.

    Отдельный объект рядом с оригиналом, а не замена: качество выбирает клиент
    на каждый запрос, и оба варианта должны существовать одновременно.
    """
    stem, _ = os.path.splitext(key)
    return f"{stem}{LOW_AAC_SUFFIX}{AAC_EXT}"


def transcode_to_low_aac(input_path: str, output_path: str) -> Optional[str]:
    """Кодирует низкобитрейтный вариант. Путь результата или None при неудаче.

    HE-AAC v1 делаем через fdkaac: нативный энкодер ffmpeg HE-AAC не умеет
    вовсе (``-profile:a aac_he`` падает с Invalid argument), без libfdk-aac
    вариант вырождается в обычный LC того же битрейта — байтов столько же,
    качество хуже. Факт фолбэка логируем: по логу видно, что на машине нет
    fdkaac (так ведут себя дев-машины без пакета).

    Вход в fdkaac идёт ПАЙПОМ из ffmpeg, а не файлом: libfdk-aac не декодирует
    m4a/mp3/webm, fdkaac читает только WAV/RAW, а промежуточный PCM
    пятиминутного трека — это ~50 МБ на диске и лишний проход. ``-I`` нужен
    именно из-за пайпа: длина в WAV-заголовке потока недостоверна.
    """
    if not TRANSCODE_ENABLED:
        return None

    if not _fdkaac_available():
        logger.warning(
            "transcode: fdkaac не найден — низкий вариант пойдёт как AAC-LC %s kbps "
            "(HE-AAC требует libfdk-aac)",
            LOW_AAC_BITRATE,
        )
        result = transcode_to_aac(input_path, output_path, bitrate=LOW_AAC_BITRATE)
        return result if result != input_path else None

    if not _ffmpeg_available():
        logger.warning("transcode: ffmpeg не найден — низкий вариант невозможен")
        return None

    decode = [
        FFMPEG_BIN,
        "-hide_banner",
        "-nostdin",
        "-loglevel", "error",
        "-i", input_path,
        "-vn",                           # обложка-видеопоток не нужна
        "-f", "wav", "-acodec", "pcm_s16le",
        "-ar", AAC_SAMPLE_RATE,
        "-ac", "2",
        "-",
    ]
    encode = [
        FDKAAC_BIN,
        "-p", "5",                       # 5 = HE-AAC v1 (SBR)
        "-b", str(int(_bitrate_kbps_value(LOW_AAC_BITRATE)) * 1000),  # бит/с, не kbps
        "-I",                            # длина WAV из пайпа недостоверна
        "-S",                            # без прогресс-бара в stderr
        "--moov-before-mdat",            # moov в начало: без него Range-старт не играет
        "-o", output_path,
        "-",
    ]
    if not _encode_piped(decode, encode, output_path):
        return None
    logger.info(
        "transcode: низкий вариант %s (%s kbps HE-AAC)",
        Path(output_path).name,
        LOW_AAC_BITRATE,
    )
    return output_path


def _encode_piped(decode_cmd: list[str], encode_cmd: list[str], output_path: str) -> bool:
    """Прогоняет ``decode | encode`` и проверяет, что файл собрался.

    Обе стороны запускаются явно (а не через shell), stderr собирается, чтобы
    ошибка попадала в лог, а не в никуда. По таймауту оба процесса убиваются:
    запрос стрима ждёт этот вызов, и «повиснуть навсегда» он не имеет права.
    """
    _unlink_quiet(output_path)
    try:
        import subprocess

        decoder = subprocess.Popen(
            decode_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        encoder = subprocess.Popen(
            encode_cmd,
            stdin=decoder.stdout,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        # Закрываем свою копию read-конца: иначе ffmpeg не получит SIGPIPE,
        # если fdkaac умер первым, и будет писать в пустоту до конца трека.
        decoder.stdout.close()
        try:
            _, dec_err = decoder.communicate(timeout=LOW_AAC_TIMEOUT)
            _, enc_err = encoder.communicate(timeout=LOW_AAC_TIMEOUT)
        except subprocess.TimeoutExpired:
            for proc in (decoder, encoder):
                proc.kill()
            for proc in (decoder, encoder):
                proc.communicate()
            logger.warning(
                "transcode: низкий вариант не уложился в %ss", LOW_AAC_TIMEOUT
            )
            _unlink_quiet(output_path)
            return False
    except Exception:
        logger.exception("transcode: низкий вариант — ошибка запуска")
        _unlink_quiet(output_path)
        return False

    if decoder.returncode != 0 or encoder.returncode != 0:
        logger.warning(
            "transcode: низкий вариант не собрался (ffmpeg %s, fdkaac %s): %s %s",
            decoder.returncode,
            encoder.returncode,
            (dec_err or b"")[-300:].decode("utf-8", "replace"),
            (enc_err or b"")[-300:].decode("utf-8", "replace"),
        )
        _unlink_quiet(output_path)
        return False

    try:
        size = os.path.getsize(output_path)
    except OSError:
        size = 0
    if size < 1024:
        logger.warning("transcode: низкий вариант пустой (%d байт)", size)
        _unlink_quiet(output_path)
        return False
    return True


# ─────────────────────────── HLS remux ───────────────────────────

# Сколько ждём ffmpeg на сборку одного HLS-трека. Сегменты качаются по сети,
# для четырёхминутного трека это единицы секунд; 180 с — запас на медленный
# канал, но не «навсегда» (запрос стрима висит на этом вызове).
HLS_REMUX_TIMEOUT = int(os.getenv("HLS_REMUX_TIMEOUT", "180"))


def remux_hls_to_file(
    m3u8_url: str,
    output_path: str,
    container: str = "mp4",
    max_bytes: int = 0,
) -> bool:
    """Собирает HLS-плейлист в цельный файл без перекодирования (``-c copy``).

    Нужен для источников, которые раздают часть каталога только через HLS
    (SoundCloud так отдаёт лейбловые треки): байт-range-прокси m3u8 играть не
    умеет, а ffmpeg склеивает сегменты в готовый m4a за секунды и без потери
    качества.

    ``container`` задаётся явно (``-f``), а не выводится из расширения: пишем
    в ``*.part``, по которому ffmpeg формат не угадает. Возвращает True, если
    на выходе получился непустой файл.
    """
    if not _ffmpeg_available():
        logger.warning("hls remux: ffmpeg not found")
        return False

    cmd = [
        FFMPEG_BIN,
        "-y",
        "-nostdin",
        "-loglevel", "error",
        "-i", m3u8_url,
        "-vn",                       # обложка-видеопоток в аудиофайле не нужна
        "-c:a", "copy",              # без перекодирования: быстро и без потерь
    ]
    if container == "mp4":
        # moov в начале файла — иначе браузер не может играть/сикать до
        # полной загрузки, а отдаём мы как раз Range-запросами.
        cmd += ["-movflags", "+faststart"]
    if max_bytes:
        cmd += ["-fs", str(max_bytes)]
    cmd += ["-f", container, output_path]

    try:
        import subprocess
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=HLS_REMUX_TIMEOUT
        )
    except subprocess.TimeoutExpired:
        logger.warning("hls remux timed out after %ss", HLS_REMUX_TIMEOUT)
        _unlink_quiet(output_path)
        return False
    except Exception:
        logger.exception("hls remux error")
        _unlink_quiet(output_path)
        return False

    if result.returncode != 0:
        logger.warning("hls remux failed: %s", (result.stderr or "")[:500])
        _unlink_quiet(output_path)
        return False

    try:
        size = os.path.getsize(output_path)
    except OSError:
        size = 0
    if size < 1024:
        logger.warning("hls remux output too small (%d bytes)", size)
        _unlink_quiet(output_path)
        return False

    logger.info("hls remux ok: %s (%.1f MiB)", Path(output_path).name, size / 1048576)
    return True


def _unlink_quiet(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


def transcode_bytes_to_aac(
    input_bytes: bytes,
    input_ext: str = ".mp3",
    bitrate: Optional[str] = None,
) -> Optional[bytes]:
    """Transcode audio bytes to AAC. Returns None on failure."""
    if not TRANSCODE_ENABLED or not _ffmpeg_available():
        return None

    fd_in, in_path = tempfile.mkstemp(suffix=input_ext)
    fd_out, out_path = tempfile.mkstemp(suffix=AAC_EXT)
    os.close(fd_in)
    os.close(fd_out)

    try:
        with open(in_path, "wb") as f:
            f.write(input_bytes)
        result_path = transcode_to_aac(in_path, out_path, bitrate=bitrate)
        if result_path == in_path:
            return None  # transcoding failed
        with open(result_path, "rb") as f:
            return f.read()
    finally:
        for p in (in_path, out_path):
            try:
                os.unlink(p)
            except OSError:
                pass
