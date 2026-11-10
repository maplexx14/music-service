"""Conservative music prior used only until the listener has a taste profile.

Metadata cannot prove that a song is neutral. Prefer approachable genres and
original versions; untagged catalogue tracks are a lower-confidence fallback.
These rules must never filter a listener's explicit or learned preferences.
"""

import re

from app.artist_utils import effective_track_artist_title
from app.lang import is_foreign_script


NEUTRAL_GENRES = frozenset({
    "pop", "поп", "поп музыка", "indie pop", "synthpop", "synth pop",
    "soft rock", "pop rock", "acoustic", "acoustic pop", "акустика",
    "singer songwriter", "adult contemporary", "easy listening",
    "chill", "chillout", "chill out", "ambient", "эмбиент", "downtempo",
    "lofi", "lo fi", "lounge", "soul", "smooth jazz",
})
_UNKNOWN_GENRES = {"", "unknown", "other", "n/a", "неизвестно"}
_GENRE_SEPARATOR = re.compile(r"[,;/|]")
_NEUTRAL_TITLE = re.compile(
    r"\b(?:acoustic|акустика|soft rock|easy listening|chill(?:out)?|lo[ -]?fi)\b",
    re.IGNORECASE,
)
# A broad tag such as "pop" must not admit a phonk remix, and missing tags
# must not make an obviously niche upload look like an ordinary catalogue song.
_NICHE = re.compile(
    r"\b(?:phonk|фонк|trap|трэп|треп|drill|rap|рэп|hip[ -]?hop|хип[ -]?хоп|"
    r"metal|метал|металл|punk|панк|hardcore|хардкор|hardstyle|хардстайл|"
    r"dubstep|дабстеп|techno|техно|noise|grindcore|screamo|"
    r"remix|ремикс|mashup|мэшап|nightcore|найткор|slowed|sped[ -]?up|"
    r"bass[ -]?boost(?:ed)?|earrape|пародия|parody)\b",
    re.IGNORECASE,
)
_EXPLICIT = re.compile(
    r"\b(?:fuck\w*|shit\w*|bitch\w*|porn\w*|"
    r"хуй\w*|хуя\w*|хуе\w*|пизд\w*|еба\w*|ёба\w*|бляд\w*|блят\w*|порно\w*)\b",
    re.IGNORECASE,
)


def neutral_tier(track) -> int | None:
    """0: neutral metadata; 1: unknown genre; None: unsuitable for cold start."""
    artist, title = effective_track_artist_title(track)
    genre = str(getattr(track, "genre", None) or "").strip().lower().replace("-", " ")
    text = f"{artist} {title} {genre}"
    if is_foreign_script(title) or _NICHE.search(text) or _EXPLICIT.search(text):
        return None
    if genre not in _UNKNOWN_GENRES:
        tags = {part.strip() for part in _GENRE_SEPARATOR.split(genre)}
        # Exact tags: "noise pop" and "dark ambient" are not broad pop/ambient.
        return 0 if tags and tags <= NEUTRAL_GENRES else None
    return 0 if _NEUTRAL_TITLE.search(title) else 1
