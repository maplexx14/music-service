"""Пересчитать длительность существующих треков из аудиофайлов.

Использование: python -m scripts.backfill_durations
"""
from pathlib import Path

from mutagen import File as MutagenFile

from app.database import SessionLocal
from app.models import Track
from app.routers.tracks import MUSIC_DIR


def main() -> None:
    db = SessionLocal()
    updated = skipped = 0
    try:
        for track in db.query(Track).all():
            file_path = MUSIC_DIR / Path(track.file_path).name
            if not file_path.exists():
                print(f"[skip] track {track.id}: file not found")
                skipped += 1
                continue
            try:
                audio = MutagenFile(str(file_path))
                if audio is None or audio.info is None:
                    raise ValueError("unreadable audio")
            except Exception as e:
                print(f"[skip] track {track.id}: {e}")
                skipped += 1
                continue
            new_duration = int(audio.info.length)
            if new_duration != track.duration:
                print(f"[upd]  track {track.id}: {track.duration}s -> {new_duration}s")
                track.duration = new_duration
                updated += 1
        db.commit()
        print(f"Done: {updated} updated, {skipped} skipped")
    finally:
        db.close()


if __name__ == "__main__":
    main()
