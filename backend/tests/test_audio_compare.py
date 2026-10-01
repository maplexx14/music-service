"""Сравнение записей по звуку (app/audio_compare.py) на синтетике.

Настоящие пары (СЕРЕГА ПИРАТ, CUPSIZE) в репозиторий не положить, поэтому
собираем «песню» ffmpeg'ом: непериодичная мелодия + шум в полосе голоса.
Цензурная версия — та же запись с заглушённой секундой, оригинал — она же,
но ускоренная на 2% и пережатая в mp3 (так расходятся реальные заливы).
"""

import shutil
import subprocess

import pytest

from app import audio_compare

pytestmark = pytest.mark.skipif(
    not shutil.which(audio_compare.FFMPEG_BIN) or not audio_compare.available(),
    reason="нужны ffmpeg и fpcalc (libchromaprint-tools)",
)

_N1 = "floor(mod(abs(sin(floor(t/0.4)*12.9898)*43758.5453),12))"
_N2 = "floor(mod(abs(sin(floor(t/0.6)*78.233)*12345.678),12))"
_MELODY = f"0.3*sin(2*PI*t*220*pow(2,{_N1}/12))+0.2*sin(2*PI*t*330*pow(2,{_N2}/12))"


def _ffmpeg(*args):
    subprocess.run([audio_compare.FFMPEG_BIN, "-v", "error", "-y", *args], check=True)


@pytest.fixture(scope="module")
def songs(tmp_path_factory):
    d = tmp_path_factory.mktemp("songs")
    base, censored, original, other = (str(d / n) for n in ("base.wav", "cens.wav", "orig.mp3", "other.wav"))
    _ffmpeg(
        "-f", "lavfi", "-i", f"aevalsrc='{_MELODY}':s=44100:d=40",
        "-f", "lavfi", "-i", "anoisesrc=d=40:c=pink:a=0.5:r=44100:seed=7",
        "-filter_complex",
        "[1]bandpass=f=1200:w=1500,volume='if(lt(mod(t,1.3),0.8),1,0)':eval=frame[v];"
        "[0][v]amix=inputs=2:normalize=0[o]",
        "-map", "[o]", base,
    )
    _ffmpeg("-i", base, "-af", "volume=enable='between(t,15,16.2)':volume=0.05", censored)
    _ffmpeg("-i", base, "-af", "atempo=1.02", "-b:a", "128k", original)
    _ffmpeg(
        "-f", "lavfi", "-i",
        "aevalsrc='0.3*sin(2*PI*t*200*pow(2,floor(mod(abs(sin(floor(t/0.5)*3.3)*999.1),12))/12))'"
        ":s=44100:d=40",
        other,
    )
    return {"base": base, "censored": censored, "original": original, "other": other}


def test_muted_word_is_found_despite_tempo_drift(songs):
    result = audio_compare.compare(songs["censored"], songs["original"])

    assert result.verdict == "censored"
    assert 0.97 < result.rate < 0.99
    start, length, db = result.segments[0]
    assert 14.5 < start < 15.5 and length >= 1.0 and db < -10


def test_same_recording_without_edits(songs):
    assert audio_compare.compare(songs["base"], songs["original"]).verdict == "same"


def test_other_recording_is_different(songs):
    assert audio_compare.compare(songs["other"], songs["original"]).verdict == "different"
