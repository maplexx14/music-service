"""Backfill versioned acoustic profiles for locally available tracks.

Run after migration 0020, for example::

    python -m scripts.backfill_acoustic_features --commit-every 25

Use ``--force`` after changing the analyzer without changing its version, or
``--limit`` for a small production smoke run.
"""

from __future__ import annotations

import argparse

from app.acoustic_features import ANALYZER_VERSION, analyze_track
from app.database import SessionLocal
from app.models import Track


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--commit-every", type=int, default=25)
    args = parser.parse_args()

    db = SessionLocal()
    analyzed = 0
    skipped = 0
    failed = 0
    try:
        # Do not combine ``yield_per()`` with commits. PostgreSQL implements
        # that iterator with a server-side named cursor, and COMMIT closes the
        # cursor before SQLAlchemy can fetch the next page. Keyset pagination
        # gives every committed batch its own ordinary SELECT instead.
        batch_size = max(1, args.commit_every)
        last_id = 0
        while args.limit <= 0 or analyzed + failed < args.limit:
            remaining = (
                batch_size
                if args.limit <= 0
                else min(batch_size, args.limit - analyzed - failed)
            )
            query = db.query(Track).filter(
                Track.id > last_id,
                Track.file_path.isnot(None),
            )
            if not args.force:
                query = query.filter(
                    (Track.acoustic_analyzer_version.is_(None))
                    | (Track.acoustic_analyzer_version != ANALYZER_VERSION)
                )
            batch = query.order_by(Track.id).limit(remaining).all()
            if not batch:
                break

            for track in batch:
                last_id = track.id
                if analyze_track(track):
                    analyzed += 1
                else:
                    failed += 1
            db.commit()
    except KeyboardInterrupt:
        db.commit()
        skipped += 1
    finally:
        db.close()
    print(
        f"acoustic backfill: analyzed={analyzed} failed={failed} "
        f"interrupted={skipped} version={ANALYZER_VERSION}"
    )


if __name__ == "__main__":
    main()
