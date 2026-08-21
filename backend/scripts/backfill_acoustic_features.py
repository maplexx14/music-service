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
        query = db.query(Track).filter(Track.file_path.isnot(None)).order_by(Track.id)
        if not args.force:
            query = query.filter(
                (Track.acoustic_analyzer_version.is_(None))
                | (Track.acoustic_analyzer_version != ANALYZER_VERSION)
            )
        if args.limit > 0:
            query = query.limit(args.limit)

        for track in query.yield_per(25):
            if analyze_track(track):
                analyzed += 1
            else:
                failed += 1
            if (analyzed + failed) % max(1, args.commit_every) == 0:
                db.commit()
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
