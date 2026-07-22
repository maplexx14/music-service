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


# ─────────────────────────── helpers ───────────────────────────

def _ffmpeg_available() -> bool:
    """Check that ffmpeg is installed and callable."""
    return shutil.which(FFMPEG_BIN) is not None


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


def is_already_aac(input_path: str) -> bool:
    """Check if a file is already AAC (m4a/MP4 container with AAC codec)."""
    ext = Path(input_path).suffix.lower()
    if ext in (".m4a", ".aac"):
        return True
    # Check codec via ffprobe for ambiguous containers
    try:
        import subprocess
        result = subprocess.run(
            [
                FFPROBE_BIN,
                "-v", "quiet",
                "-select_streams", "a:0",
                "-show_entries", "stream=codec_name",
                "-of", "default=noprint_wrappers=1:nokey=1",
                input_path,
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        codec = result.stdout.strip().lower()
        return codec in ("aac", "alac")
    except Exception:
        return False


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

    if is_already_aac(input_path):
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
