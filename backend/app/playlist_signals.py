"""SQL helpers for recommendation signals derived from user playlists."""

from sqlalchemy import case, func, or_
from sqlalchemy.orm import Session

from app.models import Playlist


IMPORTED_DESCRIPTION_MARKERS = (
    "Импортировано из %",
    "Ð˜Ð¼Ð¿Ð¾Ñ€Ñ‚Ð¸Ñ€Ð¾Ð²Ð°Ð½Ð¾ Ð¸Ð· %",
    "Imported from %",
)


def imported_playlist_clause():
    """Recognize explicit and legacy imported playlists in SQL queries."""
    return or_(
        func.lower(func.coalesce(Playlist.origin, "")) == "imported",
        *(Playlist.description.like(marker) for marker in IMPORTED_DESCRIPTION_MARKERS),
    )


def aggregate_playlist_origin():
    """Return ``manual`` when any containing playlist was manually curated.

    A track can belong to several playlists.  Manual curation is the stronger
    signal, so it must win over imported membership instead of relying on the
    lexical order of the stored origin strings.
    """
    imported_flag = case((imported_playlist_clause(), 1), else_=0)
    return case(
        (func.min(imported_flag) == 1, "imported"),
        else_="manual",
    )


def find_liked_playlist_id(db: Session, user_id: int) -> int | None:
    """Id of the user's is_liked playlist, or None when there is none yet.

    Uniqueness is only enforced from migration 0021 onwards, and a pair of
    concurrent likes could insert two rows before that. A bare `.scalar()`
    here raised MultipleResultsFound and took the caller down with it — the
    admin dashboard walks every user, so a single duplicated row broke the
    whole panel. Oldest row wins so repeated calls agree with each other.
    """
    return (
        db.query(Playlist.id)
        .filter(Playlist.owner_id == user_id, Playlist.is_liked.is_(True))
        .order_by(Playlist.id)
        .limit(1)
        .scalar()
    )
