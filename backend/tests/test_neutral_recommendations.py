"""Cold-start rules also work on sparse or contradictory provider metadata."""

from types import SimpleNamespace

import pytest

from app.neutral_recommendations import neutral_tier


@pytest.mark.parametrize("genre,title,expected", [
    (" Pop ", "Ordinary song", 0),
    ("Soft-Rock", "Ordinary song", 0),
    ("Lo-Fi", "Ordinary song", 0),
    ("pop / acoustic", "Ordinary song", 0),
    (None, "Ordinary song (Acoustic)", 0),
    (None, "Ordinary song", 1),
    ("unknown", "Ordinary song", 1),
    ("metal", "Ordinary song", None),
    ("pop / rap", "Ordinary song", None),
    ("noise pop", "Ordinary song", None),
    ("dark ambient", "Ordinary song", None),
    ("pop", "Ordinary song (Phonk Remix)", None),
    (None, "Ordinary song (Slowed)", None),
    (None, "Ordinary song (Sped Up)", None),
    (None, "Ordinary song (Bass Boosted)", None),
    ("pop", "Fuck this", None),
    (None, "Хуйня", None),
    (None, "你好", None),
    ("pop", "Попробуй", 0),
])
def test_neutral_metadata(genre, title, expected):
    track = SimpleNamespace(genre=genre, title=title, artist="Singer", source="ytmusic")
    assert neutral_tier(track) == expected


def test_neutral_metadata_checks_effective_soundcloud_title():
    track = SimpleNamespace(
        title="Singer - Song (Phonk Remix)", artist="Uploader", source="soundcloud",
        genre="pop", album=None,
    )
    assert neutral_tier(track) is None
