"""MP4 → ADTS на лету: кадры AAC перекладываются по индексу из таблиц MP4.

Раньше ADTS собирал ffmpeg, и ему нужен был файл целиком: архивный трек
качался из bucket.ru весь, перекладывался и только потом отдавал первый байт.
На iOS это давало старт p75 0.53 с, p90 1.2 с против 0.30/0.41 с у десктопа
(nginx-лог прода 2026-10-14), а почти каждый старт там — трек, которого в
кэше ADTS ещё нет (654 разных трека на 688 стартов за сутки).

ADTS — те же кадры AAC, перед каждым 7-байтный заголовок. Размеры и смещения
кадров лежат в moov (stsz/stsc/stco), поэтому длина ADTS известна до первого
байта звука: Σ(7 + размер кадра). Отсюда честные Content-Length и Range, а
сами кадры читаются из MP4 по мере закачки — старт ждёт только moov (десятки
КБ в начале файла с faststart, так лежит большая часть архива).

Фрагментированный MP4 (DASH-файлы YouTube: moov без таблиц, кадры в moof)
индексируется по готовому файлу целиком.

Байты те же, что у ``ffmpeg -c:a copy -f adts``: заголовок без CRC, buffer
fullness 0x7FF, пустые кадры пропускаются (проверяется тестом против ffmpeg).
"""

from __future__ import annotations

import bisect
import itertools
import os
import struct
from array import array
from typing import AsyncIterator, Callable, Iterator, Optional

HEADER_SIZE = 7
# aac_frame_length — 13 бит и включает заголовок.
_MAX_FRAME = (1 << 13) - 1
# Сколько байт ADTS копить перед отдачей: кадр ~400 байт, а отдавать по кадру
# значило бы тысячи мелких записей в сокет на трек.
_OUT_CHUNK = 64 * 1024
# Разобранное начало буфера MP4 выбрасываем, когда оно копится до этого
# размера: удаление с головы bytearray — memmove всего остатка.
_COMPACT = 1 << 20

# Флаги tfhd/trun (ISO/IEC 14496-12, 8.8.7 и 8.8.8).
_TFHD_BASE_OFFSET = 0x000001
_TFHD_DESCRIPTION = 0x000002
_TFHD_DURATION = 0x000008
_TFHD_SIZE = 0x000010
_TFHD_BASE_IS_MOOF = 0x020000
_TRUN_DATA_OFFSET = 0x000001
_TRUN_FIRST_FLAGS = 0x000004
_TRUN_DURATION = 0x000100
_TRUN_SIZE = 0x000200
_TRUN_FLAGS = 0x000400
_TRUN_CTO = 0x000800


class AdtsIndex:
    """Где лежит каждый кадр AAC в MP4 и где он окажется в ADTS."""

    __slots__ = ("profile", "sf_index", "channels", "offsets", "sizes", "starts", "total", "_fixed")

    def __init__(self, profile: int, sf_index: int, channels: int, offsets: array, sizes: array):
        self.profile = profile
        self.sf_index = sf_index
        self.channels = channels
        self.offsets = offsets
        self.sizes = sizes
        starts = array("q", [0])
        starts.extend(itertools.accumulate(size + HEADER_SIZE for size in sizes))
        # starts[i] — смещение i-го кадра в ADTS, последний элемент — длина ADTS.
        self.starts = starts
        self.total = starts[-1]
        self._fixed = bytes((0xFF, 0xF1, (profile << 6) | (sf_index << 2) | (channels >> 2)))

    def header(self, size: int) -> bytes:
        """Заголовок ADTS кадра с полезной нагрузкой ``size`` байт."""
        length = size + HEADER_SIZE
        return self._fixed + bytes((
            ((self.channels & 3) << 6) | (length >> 11),
            (length >> 3) & 0xFF,
            ((length & 7) << 5) | 0x1F,
            0xFC,
        ))


# ─────────────────────────── разбор боксов ───────────────────────────


def _boxes(buf, start: int, end: int) -> Iterator[tuple[bytes, int, int]]:
    """(тип, начало тела, конец бокса) дочерних боксов диапазона [start, end)."""
    pos = start
    while pos + 8 <= end:
        size, kind = struct.unpack_from(">I4s", buf, pos)
        header = 8
        if size == 1:
            if pos + 16 > end:
                return
            size = struct.unpack_from(">Q", buf, pos + 8)[0]
            header = 16
        elif size == 0:
            size = end - pos
        if size < header or pos + size > end:
            return
        yield kind, pos + header, pos + size
        pos += size


def _child(buf, start: int, end: int, kind: bytes) -> Optional[tuple[int, int]]:
    for found, body, box_end in _boxes(buf, start, end):
        if found == kind:
            return body, box_end
    return None


def _path(buf, start: int, end: int, *kinds: bytes) -> Optional[tuple[int, int]]:
    span: Optional[tuple[int, int]] = (start, end)
    for kind in kinds:
        span = _child(buf, span[0], span[1], kind)
        if span is None:
            return None
    return span


def _descriptor(buf, pos: int, end: int) -> Optional[tuple[int, int, int]]:
    """(тег, начало, конец) дескриптора MPEG-4 Systems внутри esds."""
    if pos >= end:
        return None
    tag = buf[pos]
    pos += 1
    length = 0
    for _ in range(4):
        if pos >= end:
            return None
        byte = buf[pos]
        pos += 1
        length = (length << 7) | (byte & 0x7F)
        if not byte & 0x80:
            break
    return tag, pos, min(pos + length, end)


def _decoder_config(buf, start: int, end: int) -> Optional[bytes]:
    """AudioSpecificConfig из esds (ES_Descriptor → DecoderConfig → DecSpecificInfo)."""
    es = _descriptor(buf, start + 4, end)  # после version/flags
    if es is None or es[0] != 0x03:
        return None
    pos, es_end = es[1] + 2, es[2]  # ES_ID
    if pos >= es_end:
        return None
    flags = buf[pos]
    pos += 1
    if flags & 0x80:  # streamDependenceFlag
        pos += 2
    if flags & 0x40:  # URL_Flag
        if pos >= es_end:
            return None
        pos += 1 + buf[pos]
    if flags & 0x20:  # OCRstreamFlag
        pos += 2
    config = _descriptor(buf, pos, es_end)
    if config is None or config[0] != 0x04 or config[2] - config[1] < 13:
        return None
    # 0x40 — MPEG-4 Audio, 0x66-0x68 — MPEG-2 AAC Main/LC/SSR: у всех кадры AAC.
    if buf[config[1]] not in (0x40, 0x66, 0x67, 0x68):
        return None
    pos = config[1] + 13
    while pos < config[2]:
        sub = _descriptor(buf, pos, config[2])
        if sub is None:
            return None
        if sub[0] == 0x05:
            return bytes(buf[sub[1]:sub[2]])
        pos = sub[2]
    return None


def parse_audio_specific_config(asc: bytes) -> Optional[tuple[int, int, int]]:
    """(profile, sampling_frequency_index, channel_configuration) для ADTS.

    Как у ffmpeg: у HE-AAC (AOT 5/29) в заголовок идут тип и частота ядра —
    SBR в ADTS сигналится неявно. None — ADTS такой поток не выразит (тип
    объекта старше LTP, частота вне таблицы, раскладка каналов через PCE).
    """
    bits = int.from_bytes(asc, "big")
    total = len(asc) * 8
    pos = 0

    def take(count: int) -> int:
        nonlocal pos
        if pos + count > total:
            raise ValueError("ASC короче ожидаемого")
        pos += count
        return (bits >> (total - pos)) & ((1 << count) - 1)

    def object_type() -> int:
        value = take(5)
        return 32 + take(6) if value == 31 else value

    try:
        aot = object_type()
        sf_index = take(4)
        if sf_index == 15:
            return None
        channels = take(4)
        if aot in (5, 29):
            if take(4) == 15:
                take(24)
            aot = object_type()
    except ValueError:
        return None
    if not 1 <= aot <= 4 or not 1 <= channels <= 7:
        return None
    return aot - 1, sf_index, channels


def _audio_config(buf, stbl: tuple[int, int]) -> Optional[tuple[int, int, int]]:
    stsd = _child(buf, *stbl, b"stsd")
    if stsd is None or stsd[1] - stsd[0] < 8:
        return None
    if struct.unpack_from(">I", buf, stsd[0] + 4)[0] != 1:
        return None
    entry = next(_boxes(buf, stsd[0] + 8, stsd[1]), None)
    if entry is None or entry[0] != b"mp4a" or entry[2] - entry[1] < 28:
        return None
    _, body, end = entry
    # Звуковое описание QuickTime: версия 1 и 2 длиннее на 16 и 36 байт.
    extra = {0: 0, 1: 16, 2: 36}.get(struct.unpack_from(">H", buf, body + 8)[0])
    if extra is None:
        return None
    children = body + 28 + extra
    esds = _child(buf, children, end, b"esds")
    if esds is None:
        wave = _child(buf, children, end, b"wave")
        esds = _child(buf, *wave, b"esds") if wave else None
    if esds is None:
        return None
    asc = _decoder_config(buf, *esds)
    return parse_audio_specific_config(asc) if asc else None


def _audio_track(buf, moov: tuple[int, int]) -> Optional[tuple[int, tuple[int, int]]]:
    """(track_ID, границы stbl) первой звуковой дорожки."""
    for kind, body, end in _boxes(buf, *moov):
        if kind != b"trak":
            continue
        mdia = _child(buf, body, end, b"mdia")
        if mdia is None:
            continue
        hdlr = _child(buf, *mdia, b"hdlr")
        if hdlr is None or hdlr[1] - hdlr[0] < 12 or bytes(buf[hdlr[0] + 8:hdlr[0] + 12]) != b"soun":
            continue
        tkhd = _child(buf, body, end, b"tkhd")
        stbl = _path(buf, *mdia, b"minf", b"stbl")
        if tkhd is None or stbl is None:
            return None
        id_at = tkhd[0] + (20 if buf[tkhd[0]] == 1 else 12)
        if id_at + 4 > tkhd[1]:
            return None
        return struct.unpack_from(">I", buf, id_at)[0], stbl
    return None


def _sample_table(buf, stbl: tuple[int, int]) -> Optional[tuple[array, array]]:
    """(смещения, размеры) кадров из stsz/stsc/stco; пустые у фрагментированного MP4."""
    stsz = _child(buf, *stbl, b"stsz")
    stsc = _child(buf, *stbl, b"stsc")
    chunks_box = _child(buf, *stbl, b"stco")
    wide = chunks_box is None
    if wide:
        chunks_box = _child(buf, *stbl, b"co64")
    if stsz is None or stsc is None or chunks_box is None or stsz[1] - stsz[0] < 12:
        return None
    constant, count = struct.unpack_from(">II", buf, stsz[0] + 4)
    if constant:
        sizes = array("I", [constant]) * count
    else:
        if stsz[0] + 12 + 4 * count > stsz[1]:
            return None
        sizes = array("I", struct.unpack_from(f">{count}I", buf, stsz[0] + 12))
    offsets = array("q")
    if count == 0:
        return offsets, sizes
    if stsc[1] - stsc[0] < 8 or chunks_box[1] - chunks_box[0] < 8:
        return None
    runs_count = struct.unpack_from(">I", buf, stsc[0] + 4)[0]
    chunk_count = struct.unpack_from(">I", buf, chunks_box[0] + 4)[0]
    step = 8 if wide else 4
    if (
        runs_count == 0
        or stsc[0] + 8 + 12 * runs_count > stsc[1]
        or chunks_box[0] + 8 + step * chunk_count > chunks_box[1]
    ):
        return None
    runs = struct.unpack_from(f">{3 * runs_count}I", buf, stsc[0] + 8)
    chunks = struct.unpack_from(f">{chunk_count}{'Q' if wide else 'I'}", buf, chunks_box[0] + 8)
    sample = 0
    for run in range(runs_count):
        first, per_chunk, description = runs[3 * run:3 * run + 3]
        last = runs[3 * run + 3] - 1 if run + 1 < runs_count else chunk_count
        # Одно описание на дорожку: второе (другой кодек/частота посреди
        # файла) ADTS с одним заголовком не выразит.
        if description != 1 or first < 1 or last > chunk_count or first > last + 1:
            return None
        for chunk in range(first, last + 1):
            offset = chunks[chunk - 1]
            for _ in range(per_chunk):
                if sample >= count:
                    return None
                offsets.append(offset)
                offset += sizes[sample]
                sample += 1
    if sample != count:
        return None
    return offsets, sizes


def _trex_default_size(buf, moov: tuple[int, int], track_id: int) -> Optional[int]:
    """default_sample_size из trex дорожки; None — файл не фрагментирован (нет mvex)."""
    mvex = _child(buf, *moov, b"mvex")
    if mvex is None:
        return None
    for kind, body, end in _boxes(buf, *mvex):
        if kind == b"trex" and end - body >= 24:
            found, _description, _duration, size, _flags = struct.unpack_from(">5I", buf, body + 4)
            if found == track_id:
                return size
    return 0


def _moof_samples(
    moof, moof_at: int, track_id: int, trex_size: int, offsets: array, sizes: array
) -> bool:
    """Дописывает кадры дорожки из одного moof (байты бокса целиком, moof_at —
    его смещение в файле). False — раскладку не поддерживаем."""
    body = 16 if struct.unpack_from(">I", moof, 0)[0] == 1 else 8
    for position, (kind, traf, traf_end) in enumerate(
        (box for box in _boxes(moof, body, len(moof)) if box[0] == b"traf")
    ):
        tfhd = _child(moof, traf, traf_end, b"tfhd")
        if tfhd is None or tfhd[1] - tfhd[0] < 8:
            return False
        flags = int.from_bytes(moof[tfhd[0] + 1:tfhd[0] + 4], "big")
        found = struct.unpack_from(">I", moof, tfhd[0] + 4)[0]
        if found != track_id:
            continue
        at = tfhd[0] + 8
        base = moof_at
        if flags & _TFHD_BASE_OFFSET:
            base = struct.unpack_from(">Q", moof, at)[0]
            at += 8
        elif not flags & _TFHD_BASE_IS_MOOF and position:
            # База — конец данных предыдущего traf: без разбора чужих дорожек
            # её не узнать. В DASH-файлах дорожка одна, так не бывает.
            return False
        if flags & _TFHD_DESCRIPTION:
            at += 4
        if flags & _TFHD_DURATION:
            at += 4
        default_size = trex_size
        if flags & _TFHD_SIZE:
            default_size = struct.unpack_from(">I", moof, at)[0]
        data = base
        for run_kind, run, run_end in _boxes(moof, traf, traf_end):
            if run_kind != b"trun" or run_end - run < 8:
                continue
            run_flags = int.from_bytes(moof[run + 1:run + 4], "big")
            count = struct.unpack_from(">I", moof, run + 4)[0]
            at = run + 8
            if run_flags & _TRUN_DATA_OFFSET:
                data = base + struct.unpack_from(">i", moof, at)[0]
                at += 4
            if run_flags & _TRUN_FIRST_FLAGS:
                at += 4
            fields = [flag for flag in (_TRUN_DURATION, _TRUN_SIZE, _TRUN_FLAGS, _TRUN_CTO) if run_flags & flag]
            record = 4 * len(fields)
            if at + record * count > run_end:
                return False
            if run_flags & _TRUN_SIZE:
                size_at = at + 4 * fields.index(_TRUN_SIZE)
                run_sizes = [struct.unpack_from(">I", moof, size_at + record * i)[0] for i in range(count)]
            else:
                run_sizes = [default_size] * count
            for size in run_sizes:
                offsets.append(data)
                sizes.append(size)
                data += size
    return True


def _build(config, offsets: array, sizes: array, file_size: Optional[int]) -> Optional[AdtsIndex]:
    """Индекс по кадрам, если они годятся для ADTS. Пустые кадры ffmpeg
    пропускает — и мы тоже."""
    if 0 in sizes:
        kept = [(offset, size) for offset, size in zip(offsets, sizes) if size]
        offsets = array("q", (offset for offset, _ in kept))
        sizes = array("I", (size for _, size in kept))
    if not sizes or max(sizes) + HEADER_SIZE > _MAX_FRAME:
        return None
    # Кадры читаются из MP4 одним проходом вперёд: смещения должны расти и не
    # перекрываться (в чужих раскладках — отказ, остаётся ffmpeg).
    end = 0
    for offset, size in zip(offsets, sizes):
        if offset < end:
            return None
        end = offset + size
    if file_size is not None and end > file_size:
        return None
    return AdtsIndex(*config, offsets, sizes)


# ──────────────────────── индекс из файла и из головы ────────────────────────

INDEX = "index"
NEED_MORE = "more"
NEED_FILE = "file"
UNSUPPORTED = "none"


def plan_from_head(head, file_size: int) -> tuple[str, object]:
    """Что можно сделать по началу файла ``head``.

    (INDEX, AdtsIndex) — moov с таблицами целиком в голове, кадры можно
    отдавать по мере закачки; (NEED_MORE, n) — moov длиннее головы, нужно n
    байт; (NEED_FILE, None) — moov после mdat или файл фрагментирован, индекс
    строится по готовому файлу; (UNSUPPORTED, None) — в ADTS не переложить.
    """
    pos = 0
    while True:
        if pos + 8 > file_size:
            return UNSUPPORTED, None
        need = min(pos + 16, file_size)
        if len(head) < need:
            return NEED_MORE, need
        size, kind = struct.unpack_from(">I4s", head, pos)
        header = 8
        if size == 1:
            if pos + 16 > file_size:
                return UNSUPPORTED, None
            size = struct.unpack_from(">Q", head, pos + 8)[0]
            header = 16
        elif size == 0:
            size = file_size - pos
        if size < header or pos + size > file_size:
            return UNSUPPORTED, None
        if kind in (b"mdat", b"moof"):
            return NEED_FILE, None
        if kind == b"moov":
            if pos + size > len(head):
                return NEED_MORE, pos + size
            moov = (pos + header, pos + size)
            track = _audio_track(head, moov)
            if track is None:
                return UNSUPPORTED, None
            track_id, stbl = track
            if _trex_default_size(head, moov, track_id) is not None:
                return NEED_FILE, None
            config = _audio_config(head, stbl)
            table = _sample_table(head, stbl) if config else None
            if table is None:
                return UNSUPPORTED, None
            if not table[1]:
                return NEED_FILE, None
            index = _build(config, *table, file_size)
            return (INDEX, index) if index else (UNSUPPORTED, None)
        pos += size


def _top_level(fh, file_size: int) -> Iterator[tuple[bytes, int, int]]:
    """(тип, смещение, размер) боксов верхнего уровня открытого файла."""
    pos = 0
    while pos + 8 <= file_size:
        fh.seek(pos)
        raw = fh.read(16)
        size, kind = struct.unpack_from(">I4s", raw, 0)
        if size == 1:
            if len(raw) < 16:
                return
            size = struct.unpack_from(">Q", raw, 8)[0]
        elif size == 0:
            size = file_size - pos
        if size < 8 or pos + size > file_size:
            return
        yield kind, pos, size
        pos += size


def index_file(path: str) -> Optional[AdtsIndex]:
    """Индекс готового файла: обычного MP4 (moov где угодно) и фрагментированного."""
    with open(path, "rb") as fh:
        file_size = os.fstat(fh.fileno()).st_size
        boxes = list(_top_level(fh, file_size))
        moov_box = next((box for box in boxes if box[0] == b"moov"), None)
        if moov_box is None:
            return None
        fh.seek(moov_box[1])
        moov = fh.read(moov_box[2])
        body = 16 if struct.unpack_from(">I", moov, 0)[0] == 1 else 8
        track = _audio_track(moov, (body, len(moov)))
        if track is None:
            return None
        track_id, stbl = track
        config = _audio_config(moov, stbl)
        table = _sample_table(moov, stbl) if config else None
        if table is None:
            return None
        offsets, sizes = table
        trex_size = _trex_default_size(moov, (body, len(moov)), track_id)
        if trex_size is not None:
            for kind, at, size in boxes:
                if kind != b"moof":
                    continue
                fh.seek(at)
                if not _moof_samples(fh.read(size), at, track_id, trex_size, offsets, sizes):
                    return None
        return _build(config, offsets, sizes, file_size)


# ─────────────────────────────── отдача ───────────────────────────────


async def iter_range(
    index: AdtsIndex, start: int, end: int, read: Callable[[int, int], AsyncIterator[bytes]]
) -> AsyncIterator[bytes]:
    """ADTS-байты [start, end] (включительно).

    ``read(a, b)`` — async-итератор байтов MP4 [a, b]: из файла, из идущей
    закачки — откуда угодно. Читается один непрерывный кусок MP4 от первого
    нужного кадра до последнего; промежутки между кадрами пропускаются.
    """
    end = min(end, index.total - 1)
    if start > end:
        return
    starts, offsets, sizes = index.starts, index.offsets, index.sizes
    first = bisect.bisect_right(starts, start) - 1
    last = bisect.bisect_right(starts, end) - 1
    source = read(offsets[first], offsets[last] + sizes[last] - 1).__aiter__()
    buf = bytearray()
    buf_at = offsets[first]  # смещение buf[0] в MP4
    used = 0  # байт buf уже разобрано
    out = bytearray()
    try:
        for frame in range(first, last + 1):
            size = sizes[frame]
            a = offsets[frame] - buf_at
            b = a + size
            while len(buf) < b:
                if used > _COMPACT:
                    del buf[:used]
                    buf_at += used
                    a -= used
                    b -= used
                    used = 0
                try:
                    buf += await source.__anext__()
                except StopAsyncIteration:
                    raise IOError("MP4 кончился раньше кадров индекса") from None
            lo = start - starts[frame] if frame == first else 0
            hi = end - starts[frame] + 1 if frame == last else size + HEADER_SIZE
            if lo < HEADER_SIZE:
                out += index.header(size)[lo:hi]
            if hi > HEADER_SIZE:
                out += buf[a + max(lo - HEADER_SIZE, 0):a + hi - HEADER_SIZE]
            used = b
            if len(out) >= _OUT_CHUNK:
                yield bytes(out)
                out.clear()
        if out:
            yield bytes(out)
    finally:
        # Слушатель ушёл посреди трека — закрываем чтение MP4 сразу, а не
        # когда сборщик доберётся до брошенного генератора.
        close = getattr(source, "aclose", None)
        if close is not None:
            await close()
