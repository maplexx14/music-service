#!/usr/bin/env python3
import argparse
import asyncio
import importlib
import json
import os
import shutil
from pathlib import Path

DEFAULT_DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+asyncpg://music_user:music_password@postgres:5432/music_db",
)


def parse_args():
    parser = argparse.ArgumentParser(description="Import scraped HitmoTop tracks into library")
    parser.add_argument("--data-dir", default="/tmp/music_import_data", help="Directory with tracks.json, audio/, covers/")
    parser.add_argument("--music-dir", default="/app/music_files", help="Library music files directory")
    parser.add_argument("--cover-dir", default="/app/cover_files", help="Library cover files directory")
    parser.add_argument("--database-url", default=DEFAULT_DATABASE_URL, help="Async SQLAlchemy database URL")
    return parser.parse_args()


def normalize_text(value):
    return (value or "").strip()


def resolve_data_layout(base_dir: Path):
    """
    Supports both layouts:
      1) data_dir/tracks.json + data_dir/audio + data_dir/covers
      2) data_dir/scraped_data/tracks.json + ...
    """
    direct_tracks = base_dir / "tracks.json"
    nested_tracks = base_dir / "scraped_data" / "tracks.json"

    if direct_tracks.exists():
        root = base_dir
    elif nested_tracks.exists():
        root = base_dir / "scraped_data"
    else:
        root = base_dir

    audio_dir = root / "audio"
    covers_dir = root / "covers"

    # docker cp may create nested directories: /audio/audio and /covers/covers
    nested_audio = audio_dir / "audio"
    nested_covers = covers_dir / "covers"
    if nested_audio.exists():
        audio_dir = nested_audio
    if nested_covers.exists():
        covers_dir = nested_covers

    return {
        "root": root,
        "tracks_path": root / "tracks.json",
        "audio_dir": audio_dir,
        "covers_dir": covers_dir,
    }


def get_primary_genre(track):
    genres = track.get("genres") or []
    return next((genre for genre in genres if genre and genre != "ТОП-100"), "") or track.get("primary_genre") or ""


def find_media_file(media_dir: Path, track_id: int) -> Path | None:
    if not media_dir.exists():
        return None
    matches = sorted(media_dir.glob(f"{track_id}.*"))
    for match in matches:
        if match.suffix.lower() == ".part":
            continue
        if match.is_file():
            return match
    return None


def resolve_media_path(local_path_value: str | None, track_id: int, fallback_dir: Path) -> Path | None:
    raw = normalize_text(local_path_value)
    if raw:
        candidate = Path(raw)
        if candidate.exists() and candidate.is_file():
            return candidate

    return find_media_file(fallback_dir, track_id)


def copy_to_library(source_path: Path, target_dir: Path, target_stem: str) -> str:
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{target_stem}{source_path.suffix.lower()}"
    if not target.exists():
        shutil.copy2(source_path, target)
    return target.name


async def main():
    args = parse_args()
    data_dir = Path(args.data_dir)
    layout = resolve_data_layout(data_dir)
    tracks_path = layout["tracks_path"]
    music_source_dir = layout["audio_dir"]
    cover_source_dir = layout["covers_dir"]
    library_music_dir = Path(args.music_dir)
    library_cover_dir = Path(args.cover_dir)

    if not tracks_path.exists():
        raise SystemExit(f"tracks.json not found: {tracks_path}")

    with open(tracks_path, encoding="utf-8") as file_obj:
        tracks = json.load(file_obj)

    try:
        sqlalchemy = importlib.import_module("sqlalchemy")
        sqlalchemy_asyncio = importlib.import_module("sqlalchemy.ext.asyncio")
    except ModuleNotFoundError as exc:
        raise SystemExit("sqlalchemy/asyncpg не найдены в текущем окружении.") from exc

    text = sqlalchemy.text
    create_async_engine = sqlalchemy_asyncio.create_async_engine
    async_sessionmaker = sqlalchemy_asyncio.async_sessionmaker

    engine = create_async_engine(args.database_url, pool_pre_ping=True)
    session_maker = async_sessionmaker(bind=engine, expire_on_commit=False)

    created = 0
    updated = 0
    skipped = 0
    failed = 0

    try:
        async with session_maker() as db:
            for track in tracks:
                try:
                    track_id = int(track["id"])
                    audio_file = resolve_media_path(track.get("audio_local"), track_id, music_source_dir)
                    if not audio_file:
                        skipped += 1
                        continue

                    library_music_name = copy_to_library(audio_file, library_music_dir, f"hitmotop-{track_id}")
                    file_path = f"/music_files/{library_music_name}"

                    cover_url = track.get("cover_url") or None
                    cover_file = resolve_media_path(track.get("cover_local"), track_id, cover_source_dir)
                    if cover_file:
                        library_cover_name = copy_to_library(cover_file, library_cover_dir, f"hitmotop-{track_id}")
                        cover_url = f"/cover_files/{library_cover_name}"

                    duration = int(track.get("duration_sec") or 0)
                    primary_genre = get_primary_genre(track) or None
                    lookup = await db.execute(
                        text(
                            """
                            SELECT id, file_path, cover_url, genre, duration
                            FROM tracks
                            WHERE lower(title) = :title
                              AND lower(artist) = :artist
                              AND coalesce(lower(album), '') = :album
                            LIMIT 1
                            """
                        ),
                        {
                            "title": normalize_text(track.get("title")).lower(),
                            "artist": normalize_text(track.get("artist")).lower(),
                            "album": normalize_text(track.get("album")).lower(),
                        },
                    )
                    existing = lookup.mappings().first()

                    if existing:
                        new_file_path = file_path if str(existing["file_path"] or "").startswith("/music_files/hitmotop-") else existing["file_path"]
                        new_cover_url = existing["cover_url"] or cover_url
                        new_genre = existing["genre"] or primary_genre
                        new_duration = existing["duration"] or duration

                        if (
                            new_file_path != existing["file_path"]
                            or new_cover_url != existing["cover_url"]
                            or new_genre != existing["genre"]
                            or new_duration != existing["duration"]
                        ):
                            await db.execute(
                                text(
                                    """
                                    UPDATE tracks
                                    SET file_path = :file_path,
                                        cover_url = :cover_url,
                                        genre = :genre,
                                        duration = :duration
                                    WHERE id = :id
                                    """
                                ),
                                {
                                    "id": existing["id"],
                                    "file_path": new_file_path,
                                    "cover_url": new_cover_url,
                                    "genre": new_genre,
                                    "duration": new_duration,
                                },
                            )
                            updated += 1
                        continue

                    await db.execute(
                        text(
                            """
                            INSERT INTO tracks (title, artist, album, duration, file_path, cover_url, genre, play_count)
                            VALUES (:title, :artist, :album, :duration, :file_path, :cover_url, :genre, 0)
                            """
                        ),
                        {
                            "title": normalize_text(track.get("title")),
                            "artist": normalize_text(track.get("artist")),
                            "album": normalize_text(track.get("album")) or None,
                            "duration": duration,
                            "file_path": file_path,
                            "cover_url": cover_url,
                            "genre": primary_genre,
                        },
                    )
                    created += 1
                except Exception as exc:
                    failed += 1
                    print(f"track_id={track.get('id')} import error: {exc}")
                    await db.rollback()
                    continue

                # Reduce risk of losing progress on long imports.
                if (created + updated) and (created + updated) % 50 == 0:
                    await db.commit()

            await db.commit()
    finally:
        await engine.dispose()

    print(f"created={created} updated={updated} skipped={skipped} failed={failed}")


if __name__ == "__main__":
    asyncio.run(main())
