#!/usr/bin/env python3
"""
hitmotop_scraper.py — Парсер треков с hitmotop.me

Собирает: название трека, исполнитель, жанр, обложка, ссылка на скачивание.
Данные сохраняются в JSON и CSV в папку scraped_data/.

Использование:
    # Быстрый старт — топ-чарт + первая страница всех жанров
    python hitmotop_scraper.py

    # Только определённые жанры, все страницы
    python hitmotop_scraper.py --genres rusrap ruspop rock --max-pages 0

    # С загрузкой обложек локально
    python hitmotop_scraper.py --genres rusrap --download-covers

    # Продолжить после остановки
    python hitmotop_scraper.py --resume

    # Только топ-100 чарт
    python hitmotop_scraper.py --top-only
"""

import os
import sys
import json
import csv
import time
import logging
import argparse
import requests
from html import unescape
from pathlib import Path
from datetime import datetime

# ─── Константы ────────────────────────────────────────────────────────────────

BASE_URL = "https://hitmotop.me"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
}

# ─── Утилиты ──────────────────────────────────────────────────────────────────

def setup_logging(output_dir: Path) -> logging.Logger:
    output_dir.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("hitmotop")
    logger.setLevel(logging.DEBUG)
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", "%H:%M:%S")

    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    ch.setFormatter(fmt)

    fh = logging.FileHandler(output_dir / "scraper.log", encoding="utf-8")
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(fmt)

    logger.addHandler(ch)
    logger.addHandler(fh)
    return logger


def fetch_inertia_data(url: str, session: requests.Session, logger: logging.Logger) -> dict | None:
    """
    Загружает страницу и извлекает JSON из атрибута data-page (Inertia.js).
    Возвращает распарсенный dict с ключами component, props, ...
    """
    try:
        resp = session.get(url, timeout=30)
        resp.raise_for_status()
    except requests.RequestException as e:
        logger.error(f"Ошибка запроса {url}: {e}")
        return None

    marker = "data-page="
    idx = resp.text.find(marker)
    if idx == -1:
        logger.error(f"data-page не найден на странице {url}")
        return None

    start = idx + len(marker) + 1       # пропускаем открывающую кавычку
    end = resp.text.find('"></div>', start)
    if end == -1:
        logger.error(f"Не найден конец data-page на странице {url}")
        return None

    try:
        return json.loads(unescape(resp.text[start:end]))
    except json.JSONDecodeError as e:
        logger.error(f"Ошибка парсинга JSON на {url}: {e}")
        return None


# ─── Получение данных ──────────────────────────────────────────────────────────

def get_all_genres(session: requests.Session, logger: logging.Logger) -> list[dict]:
    """Возвращает список всех жанров с главной страницы."""
    data = fetch_inertia_data(BASE_URL, session, logger)
    if not data:
        return []
    genres = data.get("props", {}).get("genres", [])
    logger.info(f"Найдено жанров: {len(genres)}")
    return genres


def get_top_chart(session: requests.Session, logger: logging.Logger) -> list[dict]:
    """Возвращает треки из топ-100 чарта."""
    data = fetch_inertia_data(f"{BASE_URL}/songs/top", session, logger)
    if not data:
        return []
    return data.get("props", {}).get("chart_tracks", [])


def get_genre_page(
    genre_slug: str,
    page: int,
    session: requests.Session,
    logger: logging.Logger,
) -> dict | None:
    """Возвращает paginated объект items для страницы жанра."""
    url = f"{BASE_URL}/genre/{genre_slug}?page={page}"
    data = fetch_inertia_data(url, session, logger)
    if not data:
        return None
    return data.get("props", {}).get("items")


# ─── Нормализация трека ────────────────────────────────────────────────────────

def normalize_track(raw: dict, genre_name: str, genre_slug: str) -> dict:
    """Преобразует сырые данные трека в единый формат."""
    album = raw.get("album") or {}
    return {
        "id":           raw.get("id"),
        "title":        raw.get("name", "").strip(),
        "artist":       raw.get("performers", "").strip(),
        "genres":       [genre_name],           # список — трек может быть в нескольких жанрах
        "genre_slugs":  [genre_slug],
        "album":        album.get("name", "").strip(),
        "year":         album.get("year", ""),
        "duration_sec": int(raw.get("duration") or 0),
        "cover_url":    album.get("cover", ""),
        "cover_local":  "",
        "download_url": raw.get("download", ""),
        "track_url":    f"{BASE_URL}/song/{raw.get('id')}",
    }


def merge_track(existing: dict, new: dict) -> dict:
    """Объединяет жанры, если трек уже есть в базе."""
    for g in new["genres"]:
        if g not in existing["genres"]:
            existing["genres"].append(g)
    for s in new["genre_slugs"]:
        if s not in existing["genre_slugs"]:
            existing["genre_slugs"].append(s)
    # Обновляем cover_url, если он был пустым (URL протухает — берём свежий)
    if not existing.get("cover_url") and new.get("cover_url"):
        existing["cover_url"] = new["cover_url"]
    return existing


# ─── Скачивание обложек ────────────────────────────────────────────────────────

def download_cover(
    track_id: int,
    cover_url: str,
    covers_dir: Path,
    session: requests.Session,
    logger: logging.Logger,
) -> str:
    """Скачивает обложку и возвращает локальный путь. Пропускает уже скачанные."""
    if not cover_url:
        return ""

    # Определяем расширение по Content-Type
    for ext in (".jpg", ".webp", ".png"):
        candidate = covers_dir / f"{track_id}{ext}"
        if candidate.exists():
            return str(candidate)

    try:
        resp = session.get(cover_url, timeout=30, stream=True)
        resp.raise_for_status()
        ct = resp.headers.get("Content-Type", "image/jpeg")
        ext = ".webp" if "webp" in ct else ".png" if "png" in ct else ".jpg"
        path = covers_dir / f"{track_id}{ext}"
        with open(path, "wb") as f:
            for chunk in resp.iter_content(8192):
                f.write(chunk)
        return str(path)
    except Exception as e:
        logger.warning(f"Не удалось скачать обложку трека {track_id}: {e}")
        return ""


# ─── Сохранение ───────────────────────────────────────────────────────────────

CSV_FIELDS = [
    "id", "title", "artist", "genres", "album", "year",
    "duration_sec", "cover_url", "cover_local", "download_url", "track_url",
]


def save_database(db: dict[int, dict], output_dir: Path, logger: logging.Logger):
    """Сохраняет базу треков в JSON и CSV."""
    tracks = list(db.values())

    # JSON
    json_path = output_dir / "tracks.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(tracks, f, ensure_ascii=False, indent=2)

    # CSV (жанры через '; ')
    csv_path = output_dir / "tracks.csv"
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction="ignore")
        writer.writeheader()
        for track in tracks:
            row = dict(track)
            row["genres"] = "; ".join(track.get("genres", []))
            writer.writerow(row)

    logger.info(f"Сохранено {len(tracks)} треков → {json_path}, {csv_path}")


def load_database(output_dir: Path) -> dict[int, dict]:
    """Загружает существующую базу треков (для продолжения/докачки)."""
    json_path = output_dir / "tracks.json"
    if not json_path.exists():
        return {}
    with open(json_path, encoding="utf-8") as f:
        try:
            tracks = json.load(f)
            return {t["id"]: t for t in tracks}
        except (json.JSONDecodeError, KeyError):
            return {}


# ─── Прогресс ─────────────────────────────────────────────────────────────────

def load_progress(output_dir: Path) -> dict:
    p = output_dir / "progress.json"
    if p.exists():
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    return {"done_genres": [], "started_at": datetime.now().isoformat()}


def save_progress(progress: dict, output_dir: Path):
    p = output_dir / "progress.json"
    progress["updated_at"] = datetime.now().isoformat()
    with open(p, "w", encoding="utf-8") as f:
        json.dump(progress, f, ensure_ascii=False, indent=2)


# ─── Основная логика скрапинга ────────────────────────────────────────────────

def scrape_genre(
    genre: dict,
    session: requests.Session,
    db: dict[int, dict],
    covers_dir: Path | None,
    max_pages: int,
    delay: float,
    logger: logging.Logger,
) -> int:
    """
    Скрапит все треки жанра постранично.
    Возвращает количество новых/обновлённых треков.
    """
    slug = genre["slug"]
    name = genre["name"]
    count = 0
    page = 1

    while True:
        if max_pages and page > max_pages:
            break

        items = get_genre_page(slug, page, session, logger)
        if not items or not items.get("data"):
            break

        last_page = items.get("last_page", 1)
        total = items.get("total", 0)
        logger.info(f"  [{name}] стр. {page}/{last_page} (всего ~{total} треков)")

        for raw in items["data"]:
            track = normalize_track(raw, name, slug)
            tid = track["id"]

            if tid in db:
                db[tid] = merge_track(db[tid], track)
            else:
                db[tid] = track
                count += 1

            if covers_dir and track["cover_url"] and not db[tid].get("cover_local"):
                local = download_cover(tid, track["cover_url"], covers_dir, session, logger)
                db[tid]["cover_local"] = local

        if page >= last_page:
            break

        page += 1
        time.sleep(delay)

    logger.info(f"  [{name}] готово: +{count} новых треков")
    return count


def scrape_top_chart(
    session: requests.Session,
    db: dict[int, dict],
    covers_dir: Path | None,
    logger: logging.Logger,
) -> int:
    """Добавляет треки из топ-100 чарта (жанр помечается как 'ТОП-100')."""
    logger.info("Скрапинг топ-100 чарта...")
    raw_tracks = get_top_chart(session, logger)
    count = 0

    for raw in raw_tracks:
        track = normalize_track(raw, "ТОП-100", "top")
        tid = track["id"]
        if tid in db:
            db[tid] = merge_track(db[tid], track)
        else:
            db[tid] = track
            count += 1

        if covers_dir and track["cover_url"] and not db[tid].get("cover_local"):
            local = download_cover(tid, track["cover_url"], covers_dir, session, logger)
            db[tid]["cover_local"] = local

    logger.info(f"Топ-100: +{count} новых треков")
    return count


# ─── CLI ──────────────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(
        description="Парсер треков с hitmotop.me",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument(
        "--genres", nargs="*", metavar="SLUG",
        help="Слаги жанров (напр.: rusrap ruspop rock). По умолчанию — все.",
    )
    p.add_argument(
        "--max-pages", type=int, default=1, metavar="N",
        help="Макс. страниц на жанр (50 треков/страница). 0 = без лимита. По умолчанию: 1.",
    )
    p.add_argument(
        "--top-only", action="store_true",
        help="Скачать только топ-100 чарт, не трогать жанры.",
    )
    p.add_argument(
        "--download-covers", action="store_true",
        help="Скачать обложки в папку scraped_data/covers/.",
    )
    p.add_argument(
        "--delay", type=float, default=0.5, metavar="SEC",
        help="Задержка между запросами в секундах (по умолчанию: 0.5).",
    )
    p.add_argument(
        "--resume", action="store_true",
        help="Продолжить с места остановки (пропустить уже скрапленные жанры).",
    )
    p.add_argument(
        "--output", default="scraped_data", metavar="DIR",
        help="Папка для сохранения данных (по умолчанию: scraped_data).",
    )
    p.add_argument(
        "--list-genres", action="store_true",
        help="Вывести список всех жанров и выйти.",
    )
    return p.parse_args()


def main():
    args = parse_args()
    output_dir = Path(args.output)
    logger = setup_logging(output_dir)

    session = requests.Session()
    session.headers.update(HEADERS)

    covers_dir = None
    if args.download_covers:
        covers_dir = output_dir / "covers"
        covers_dir.mkdir(parents=True, exist_ok=True)

    # ── Показать жанры ──
    if args.list_genres:
        genres = get_all_genres(session, logger)
        sys.stdout.reconfigure(encoding="utf-8")
        print(f"\n{'Слаг':<30} {'Название'}")
        print("-" * 60)
        for g in genres:
            print(f"{g['slug']:<30} {g['name']}")
        return

    # ── Загрузить существующую базу ──
    db = load_database(output_dir)
    logger.info(f"В базе уже {len(db)} треков")

    progress = load_progress(output_dir) if args.resume else {"done_genres": []}

    total_new = 0

    # ── Топ-100 чарт ──
    if not ("top" in progress["done_genres"]):
        total_new += scrape_top_chart(session, db, covers_dir, logger)
        progress["done_genres"].append("top")
        save_database(db, output_dir, logger)
        save_progress(progress, output_dir)

    if args.top_only:
        logger.info("Режим --top-only: жанры пропущены.")
        return

    # ── Жанры ──
    all_genres = get_all_genres(session, logger)

    if args.genres:
        genres_to_scrape = [g for g in all_genres if g["slug"] in args.genres]
        missing = set(args.genres) - {g["slug"] for g in genres_to_scrape}
        if missing:
            logger.warning(f"Жанры не найдены: {', '.join(missing)}")
    else:
        genres_to_scrape = all_genres

    if args.resume:
        done = set(progress.get("done_genres", []))
        genres_to_scrape = [g for g in genres_to_scrape if g["slug"] not in done]
        logger.info(f"Продолжение: осталось {len(genres_to_scrape)} жанров")

    for i, genre in enumerate(genres_to_scrape, 1):
        logger.info(f"[{i}/{len(genres_to_scrape)}] Жанр: {genre['name']} ({genre['slug']})")

        new = scrape_genre(
            genre, session, db, covers_dir,
            max_pages=args.max_pages,
            delay=args.delay,
            logger=logger,
        )
        total_new += new

        progress["done_genres"].append(genre["slug"])
        save_progress(progress, output_dir)

        # Сохраняем после каждого жанра
        save_database(db, output_dir, logger)
        time.sleep(args.delay)

    logger.info("=" * 60)
    logger.info(f"Готово! Новых треков в этом сеансе: {total_new}")
    logger.info(f"Итого в базе: {len(db)} уникальных треков")
    logger.info(f"Файлы: {output_dir / 'tracks.json'}, {output_dir / 'tracks.csv'}")


if __name__ == "__main__":
    main()
