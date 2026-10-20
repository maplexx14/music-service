"""Возврат новичков: кто вернулся и чем вернувшиеся отличаются от ушедших.

Когорта — юзеры, подтвердившие почту за последние ``--days`` дней (админы
не считаются). Активный день — день с показом в волне, прослушиванием или
скипом. Для каждого печатается:

* звук в день 0 — было ли хоть одно прослушивание/скип в день регистрации;
* импорт — треков в импортированных плейлистах;
* good за 3 дня — дослушано до 55% (``feedback_labels.GOOD_COMPLETION``);
* дни 1–7 — в какие дни после регистрации был активен;
* push — подписано ли хоть одно устройство.

Ниже — доля вернувшихся (активен в дни 1–7) по группам и статистика пушей
из Redis (``push:stats:<дата>``: sent/opened по видам).

Только чтение. Использование (из каталога backend или контейнера):
    python -m scripts.retention_report [--days 30]
"""
import argparse
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func, select

from app.cache import redis_client
from app.database import SessionLocal
from app.feedback_labels import GOOD_COMPLETION
from app.models import (
    Playlist,
    User,
    playlist_tracks,
    push_subscriptions,
    recommendation_events,
    recommendation_impressions,
    user_play_events,
)


def _platform(user_agent: str) -> str:
    ua = (user_agent or "").lower()
    if "iphone" in ua or "ipad" in ua:
        return "ios"
    if "android" in ua:
        return "android"
    return "desk" if ua else "?"


def _share(rows, flag) -> str:
    if not rows:
        return "-"
    hit = sum(1 for row in rows if row[flag])
    return f"{hit}/{len(rows)}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--days", type=int, default=30)
    args = parser.parse_args()

    now = datetime.now(timezone.utc)
    since = now - timedelta(days=args.days)
    db = SessionLocal()
    try:
        users = (
            db.query(User)
            .filter(User.created_at >= since, User.is_admin.is_(False))
            .order_by(User.id)
            .all()
        )
        ids = [user.id for user in users]
        if not ids:
            print("новичков нет")
            return

        days = defaultdict(set)  # user_id -> {номер дня от регистрации}
        sound_days = defaultdict(set)
        good = defaultdict(int)
        created = {user.id: user.created_at for user in users}

        def day_of(user_id, ts):
            return (ts.date() - created[user_id].date()).days

        for user_id, ts in db.execute(
            select(recommendation_impressions.c.user_id, recommendation_impressions.c.shown_at).where(
                recommendation_impressions.c.user_id.in_(ids), recommendation_impressions.c.visible.is_(True)
            )
        ):
            days[user_id].add(day_of(user_id, ts))
        for user_id, ts, kind in db.execute(
            select(
                recommendation_events.c.user_id,
                recommendation_events.c.occurred_at,
                recommendation_events.c.event_type,
            ).where(
                recommendation_events.c.user_id.in_(ids),
                recommendation_events.c.event_type.in_(("listen", "skip", "play")),
            )
        ):
            days[user_id].add(day_of(user_id, ts))
            sound_days[user_id].add(day_of(user_id, ts))
        for user_id, ts, completion in db.execute(
            select(user_play_events.c.user_id, user_play_events.c.played_at, user_play_events.c.completion).where(
                user_play_events.c.user_id.in_(ids)
            )
        ):
            day = day_of(user_id, ts)
            days[user_id].add(day)
            sound_days[user_id].add(day)
            if day <= 2 and (completion or 0) >= GOOD_COMPLETION:
                good[user_id] += 1

        imported = dict(
            db.execute(
                select(Playlist.owner_id, func.count())
                .select_from(Playlist)
                .join(playlist_tracks, playlist_tracks.c.playlist_id == Playlist.id)
                .where(Playlist.owner_id.in_(ids), Playlist.origin == "imported")
                .group_by(Playlist.owner_id)
            ).all()
        )
        subscribed = set(
            db.execute(
                select(push_subscriptions.c.user_id).distinct().where(push_subscriptions.c.user_id.in_(ids))
            ).scalars()
        )
    finally:
        db.close()

    rows = []
    print(f"{'uid':>4} {'создан':<11} {'платф':<7} {'звук д0':<7} {'импорт':>6} {'good 3д':>7} {'push':<4}  дни 1–7")
    for user in users:
        age = (now.date() - user.created_at.date()).days
        later = sorted(d for d in days[user.id] if 1 <= d <= 7)
        row = {
            "sound0": 0 in sound_days[user.id],
            "import": imported.get(user.id, 0) > 0,
            "push": user.id in subscribed,
            "returned": bool(later),
            # Возврат за неделю можно судить только у тех, кому уже больше суток.
            "judged": age >= 2,
        }
        rows.append(row)
        print(
            f"{user.id:>4} {user.created_at:%m-%d %H:%M} {_platform(user.last_user_agent):<7} "
            f"{'да' if row['sound0'] else 'нет':<7} {imported.get(user.id, 0):>6} {good[user.id]:>7} "
            f"{'да' if row['push'] else '':<4}  {' '.join(map(str, later)) or '—'}"
        )

    judged = [row for row in rows if row["judged"]]
    print(f"\nвернулись в дни 1–7 (из зарегистрированных ≥2 дней назад): {_share(judged, 'returned')}")
    for flag, title in (("sound0", "звук в день 0"), ("import", "импорт"), ("push", "подписка на пуши")):
        yes = [row for row in judged if row[flag]]
        no = [row for row in judged if not row[flag]]
        print(f"  {title:<18} да {_share(yes, 'returned'):>6}   нет {_share(no, 'returned'):>6}")

    print("\nпуши по дням (sent/opened):")
    try:
        for offset in range(min(args.days, 14), -1, -1):
            day = date.today() - timedelta(days=offset)
            stats = redis_client.hgetall(f"push:stats:{day.isoformat()}")
            if stats:
                print(f"  {day}  " + "  ".join(f"{k}={v}" for k, v in sorted(stats.items())))
    except Exception as exc:  # noqa: BLE001 — отчёт по БД ценен и без Redis
        print(f"  Redis недоступен: {exc!r}")


if __name__ == "__main__":
    main()
