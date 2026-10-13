"""Офлайн-сравнение обучаемого ранкера с ручным скором по телеметрии волны.

Ничего не пишет: обучает модель на ранних показах и считает AUC на поздних
(хорошо против плохо) — у модели и у суммы компонент ручного скора. AUC 0.5 —
не лучше монетки.

    python -m scripts.ranker_eval [--days 30] [--user 1]
"""
import argparse
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app import learned_ranker
from app.database import SessionLocal
from app.discovery_feedback import delivery_outcomes
from app.models import recommendation_impressions


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--days", type=int, default=learned_ranker.WINDOW_DAYS)
    parser.add_argument("--user", type=int)
    args = parser.parse_args()
    since = datetime.now(timezone.utc) - timedelta(days=args.days)
    db = SessionLocal()
    try:
        if args.user:
            user_ids = [args.user]
        else:
            user_ids = db.scalars(
                select(recommendation_impressions.c.user_id).distinct().where(
                    recommendation_impressions.c.surface == "flow",
                    recommendation_impressions.c.shown_at >= since,
                )
            ).all()
        by_user = {
            user_id: learned_ranker.samples_from_outcomes(
                delivery_outcomes(db, user_id, since=since)
            )
            for user_id in user_ids
        }
    finally:
        db.close()

    def report(name, samples, prior=None):
        model = learned_ranker.train(samples, prior=prior)
        positives = sum(label for _f, label, _a in samples)
        if model is None:
            print(f"  {name:<10} n={len(samples):<6} good={positives:<5} модель не принята (мало данных или AUC < {learned_ranker.MIN_AUC})")
            return None
        print(
            f"  {name:<10} n={model['n']:<6} good={model['positives']:<5} "
            f"AUC ранкер={model['auc']:.3f}  ручной скор={model['baseline_auc']:.3f}"
        )
        return model

    print(f"days={args.days} users={len(user_ids)}")
    global_model = report("все", [s for samples in by_user.values() for s in samples])
    for user_id, samples in sorted(by_user.items()):
        if len(samples) >= learned_ranker.USER_MIN_ROWS:
            report(f"user {user_id}", samples, prior=global_model)
    if global_model:
        print("\nВеса глобальной модели (по стандартизованным признакам):")
        weighted = sorted(
            zip(learned_ranker.FEATURE_NAMES, global_model["weights"][1:]),
            key=lambda pair: -abs(pair[1]),
        )
        for name, weight in weighted:
            print(f"  {name:<18}{weight:+.3f}")


if __name__ == "__main__":
    main()
