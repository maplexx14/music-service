"""Отчёт о точности рекомендаций по телеметрии отдачи и обратной связи.

Считает по отданным позициям с исходом («хорошо» — лайк или дослушивание до
80%, «плохо» — скип, дизлайк или уход раньше 25%):

* новые артисты против знакомых и фактор приёма новизны на юзера;
* калибровку score по квинтилям — растёт ли доля «хорошо» вместе со score;
* источники кандидатов (features.origin) и средние компоненты score у
  хороших и плохих исходов — какой признак реально что-то предсказывает.

Использование (из каталога backend или контейнера):
    python -m scripts.recommendation_report [--days 30] [--surface flow]
        [--version hybrid-v8] [--user 1]
"""
import argparse
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.database import SessionLocal
from app.discovery_feedback import acceptance_factor, delivery_outcomes
from app.models import recommendation_impressions


def _rate(rows, key) -> str:
    return f"{sum(1 for row in rows if row[key]) / len(rows):.3f}" if rows else "-"


def _table(title, groups) -> None:
    print(f"\n{title}")
    print(f"  {'':<24}{'n':>7}{'good':>8}{'bad':>8}")
    for name, rows in groups:
        print(f"  {str(name):<24}{len(rows):>7}{_rate(rows, 'good'):>8}{_rate(rows, 'bad'):>8}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--surface", default="flow")
    parser.add_argument("--version", help="algorithm_version, например hybrid-v8")
    parser.add_argument("--user", type=int, help="только этот user_id")
    args = parser.parse_args()

    since = datetime.now(timezone.utc) - timedelta(days=args.days)
    db = SessionLocal()
    try:
        user_query = select(recommendation_impressions.c.user_id).distinct().where(
            recommendation_impressions.c.surface == args.surface,
            recommendation_impressions.c.shown_at >= since,
        )
        user_ids = [args.user] if args.user else sorted(db.scalars(user_query).all())
        by_user = {
            user_id: [
                row
                for row in delivery_outcomes(db, user_id, since=since, surface=args.surface)
                if not args.version or row["algorithm_version"] == args.version
            ]
            for user_id in user_ids
        }
    finally:
        db.close()

    rows = [row for user_rows in by_user.values() for row in user_rows]
    print(
        f"surface={args.surface} days={args.days} version={args.version or 'all'} "
        f"users={len(user_ids)} outcomes={len(rows)}"
    )
    if not rows:
        return

    _table("Итого", [("all", rows)])
    _table("Версии алгоритма", sorted(
        _group(rows, lambda row: row["algorithm_version"]).items()
    ))
    _table("Артист", [
        ("новый", [row for row in rows if row["novel"]]),
        ("знакомый", [row for row in rows if not row["novel"]]),
    ])
    _table("Источник кандидата (features.origin)", sorted(
        _group(rows, lambda row: row["features"].get("origin", "не записан")).items(),
        key=lambda item: -len(item[1]),
    ))

    scored = sorted((row for row in rows if row["score"] is not None), key=lambda row: row["score"])
    if scored:
        size = len(scored)
        quintiles = []
        for index in range(5):
            chunk = scored[index * size // 5:(index + 1) * size // 5]
            if chunk:
                label = f"q{index + 1} ({chunk[0]['score']:.2f}..{chunk[-1]['score']:.2f})"
                quintiles.append((label, chunk))
        _table("Калибровка score (квинтили; good должен расти)", quintiles)

    with_components = [row for row in rows if row["features"].get("components")]
    if with_components:
        print("\nСредние компоненты score: хорошо против плохо")
        names = sorted({name for row in with_components for name in row["features"]["components"]})
        good = [row for row in with_components if row["good"]]
        bad = [row for row in with_components if row["bad"]]
        print(f"  {'':<14}{'good':>9}{'bad':>9}{'diff':>9}")
        for name in names:
            good_mean = _mean(row["features"]["components"].get(name, 0.0) for row in good)
            bad_mean = _mean(row["features"]["components"].get(name, 0.0) for row in bad)
            print(f"  {name:<14}{good_mean:>9.3f}{bad_mean:>9.3f}{good_mean - bad_mean:>9.3f}")

    print("\nПриём новизны по юзерам (фактор 1.0 — новые принимаются не хуже знакомых)")
    print(f"  {'user':<8}{'новые':>12}{'знакомые':>12}{'фактор':>9}")
    for user_id, user_rows in by_user.items():
        counts = {
            "novel_n": sum(1 for row in user_rows if row["novel"]),
            "novel_good": sum(1 for row in user_rows if row["novel"] and row["good"]),
            "familiar_n": sum(1 for row in user_rows if not row["novel"]),
            "familiar_good": sum(1 for row in user_rows if not row["novel"] and row["good"]),
        }
        print(
            f"  {user_id:<8}"
            f"{counts['novel_good']:>5}/{counts['novel_n']:<6}"
            f"{counts['familiar_good']:>5}/{counts['familiar_n']:<6}"
            f"{acceptance_factor(counts):>9.2f}"
        )


def _group(rows, key) -> dict:
    groups = defaultdict(list)
    for row in rows:
        groups[key(row)].append(row)
    return groups


def _mean(values) -> float:
    values = list(values)
    return sum(values) / len(values) if values else 0.0


if __name__ == "__main__":
    main()
