"""MP4 → ADTS по индексу кадров (app/mp4_adts.py).

Главное, что ломается молча: байты должны совпадать с ffmpeg (иначе тот же
URL отдавал бы разное в разных воркерах и после деплоя), любой Range — быть
срезом полного ответа, а длина — известна по одной голове файла с faststart.
"""

import asyncio
import random
import shutil
import subprocess

import pytest

from app import mp4_adts

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="нужен ffmpeg")

LAYOUTS = {
    "faststart": ["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"],
    "moov_at_end": ["-c:a", "aac", "-b:a", "128k"],
    "mono_48k": ["-c:a", "aac", "-b:a", "96k", "-ar", "48000", "-ac", "1", "-movflags", "+faststart"],
    # Как DASH-файлы YouTube: moov без таблиц, кадры во фрагментах, sidx.
    "fragmented_sidx": ["-c:a", "aac", "-b:a", "128k", "-movflags", "+dash+global_sidx",
                        "-frag_duration", "1000000"],
    "fragmented_no_base_moof": ["-c:a", "aac", "-b:a", "128k", "-movflags", "+empty_moov+separate_moof",
                                "-frag_duration", "1000000"],
}


def _encode(path, args, seconds=3):
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
         "-ac", "2", *args, str(path)],
        check=True,
    )


def _ffmpeg_adts(path):
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-c:a", "copy", "-f", "adts", "-"],
        check=True, capture_output=True,
    )
    return out.stdout


def _reader(data):
    async def read(start, end):
        # Мелкими кусками, как с диска/из сети: кадры режутся на границах.
        for at in range(start, end + 1, 777):
            await asyncio.sleep(0)
            yield data[at:min(at + 777, end + 1)]

    return read


async def _collect(index, start, end, read):
    return b"".join([chunk async for chunk in mp4_adts.iter_range(index, start, end, read)])


@pytest.mark.parametrize("layout", sorted(LAYOUTS))
def test_bytes_match_ffmpeg_and_ranges_are_slices(tmp_path, layout):
    src = tmp_path / "a.m4a"
    _encode(src, LAYOUTS[layout])
    data = src.read_bytes()

    index = mp4_adts.index_file(str(src))
    assert index is not None
    full = asyncio.run(_collect(index, 0, index.total - 1, _reader(data)))

    assert full == _ffmpeg_adts(src)
    assert index.total == len(full)
    rng = random.Random(layout)
    for _ in range(25):
        start = rng.randrange(index.total)
        end = min(index.total - 1, start + rng.randrange(20000))
        assert asyncio.run(_collect(index, start, end, _reader(data))) == full[start:end + 1]
    # Пробный запрос Safari (bytes=0-1) — синхрослово первого кадра.
    assert asyncio.run(_collect(index, 0, 1, _reader(data))) == b"\xff\xf1"


def test_faststart_head_is_enough_for_the_whole_index(tmp_path):
    src = tmp_path / "a.m4a"
    _encode(src, LAYOUTS["faststart"])
    data = src.read_bytes()

    plan, index = mp4_adts.plan_from_head(data[:64 * 1024], len(data))

    assert plan == mp4_adts.INDEX
    whole = mp4_adts.index_file(str(src))
    assert list(index.offsets) == list(whole.offsets) and index.total == whole.total


def test_short_head_asks_for_the_rest_of_moov(tmp_path):
    src = tmp_path / "a.m4a"
    _encode(src, LAYOUTS["faststart"])
    data = src.read_bytes()

    plan, needed = mp4_adts.plan_from_head(data[:100], len(data))

    assert plan == mp4_adts.NEED_MORE and 100 < needed < len(data)
    plan, _ = mp4_adts.plan_from_head(data[:needed], len(data))
    assert plan in (mp4_adts.NEED_MORE, mp4_adts.INDEX)


@pytest.mark.parametrize("layout", ["moov_at_end", "fragmented_sidx"])
def test_layouts_without_tables_in_head_need_the_whole_file(tmp_path, layout):
    src = tmp_path / "a.m4a"
    _encode(src, LAYOUTS[layout])
    data = src.read_bytes()

    assert mp4_adts.plan_from_head(data[:64 * 1024], len(data))[0] == mp4_adts.NEED_FILE


def test_non_aac_mp4_is_not_indexed(tmp_path):
    src = tmp_path / "a.m4a"
    _encode(src, ["-c:a", "alac", "-movflags", "+faststart"])
    data = src.read_bytes()

    assert mp4_adts.index_file(str(src)) is None
    assert mp4_adts.plan_from_head(data, len(data))[0] == mp4_adts.UNSUPPORTED


def _asc(bits):
    bits += "0" * (-len(bits) % 8)
    return int(bits, 2).to_bytes(len(bits) // 8, "big")


def test_he_aac_header_carries_the_core_profile():
    # AudioSpecificConfig HE-AAC с явной сигнализацией: AOT 5, ядро 22050 Гц
    # (индекс 7), стерео, выход 44100 (индекс 4), ядро AAC-LC (AOT 2).
    asc = _asc("00101" + "0111" + "0010" + "0100" + "00010")

    assert mp4_adts.parse_audio_specific_config(asc) == (1, 7, 2)
    # Обычный AAC-LC 44100 стерео.
    assert mp4_adts.parse_audio_specific_config(_asc("00010" + "0100" + "0010")) == (1, 4, 2)
    # Частота вне таблицы и раскладка через PCE в ADTS не выражаются.
    assert mp4_adts.parse_audio_specific_config(_asc("00010" + "1111" + "0" * 28)) is None
    assert mp4_adts.parse_audio_specific_config(_asc("00010" + "0100" + "0000")) is None
