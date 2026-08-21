import ast
from pathlib import Path

from starlette.requests import Request

from app.models import recommendation_events
from app.recommendation_scoring import (
    population_quality_score,
    population_rejects,
)
from app.routers.flow import _external_population_stats_on_bind, _taste_profile
from app.routers.soundcloud import _normalize_api as normalize_soundcloud
from app.routers.ytdlp import _normalize as normalize_ytmusic
from app.schemas import ExternalTrackResponse

from tests.conftest import create_user


def test_alembic_revision_ids_fit_version_column():
    versions = Path(__file__).parents[1] / "alembic" / "versions"
    for migration in versions.glob("*.py"):
        module = ast.parse(migration.read_text(encoding="utf-8"))
        revision = next(
            (
                node.value.value
                for node in module.body
                if isinstance(node, ast.Assign)
                and any(
                    isinstance(target, ast.Name) and target.id == "revision"
                    for target in node.targets
                )
                and isinstance(node.value, ast.Constant)
                and isinstance(node.value.value, str)
            ),
            None,
        )
        assert revision is not None, migration.name
        assert len(revision) <= 32, f"{migration.name}: {revision!r} exceeds VARCHAR(32)"


def _request() -> Request:
    return Request(
        {
            "type": "http",
            "scheme": "http",
            "server": ("testserver", 80),
            "root_path": "",
            "path": "/",
            "query_string": b"",
            "headers": [],
        }
    )


def test_population_quality_penalizes_broad_skips():
    assert population_quality_score(0, 1) == 0.0
    assert population_quality_score(0, 3) < 0.0
    assert population_rejects(0, 3)
    assert not population_rejects(0, 2)
    assert not population_rejects(2, 3)


def test_provider_popularity_is_normalized():
    youtube = normalize_ytmusic(
        {
            "videoId": "yt-1",
            "title": "Song",
            "artists": [{"name": "Artist"}],
            "views": "1.2M views",
        }
    )
    soundcloud = normalize_soundcloud(
        _request(),
        {
            "id": 123,
            "title": "Artist - Song",
            "permalink_url": "https://soundcloud.com/artist/song",
            "duration": 180000,
            "view_count": "45.6K",
            "user": {"username": "Artist"},
        },
    )

    assert youtube is not None and youtube.play_count == 1_200_000
    assert soundcloud is not None and soundcloud.play_count == 45_600


def test_external_skip_is_part_of_personal_flow_exclusions(db):
    user = create_user(db, username="external-skip-user")
    db.execute(
        recommendation_events.insert().values(
            user_id=user.id,
            source="ytmusic",
            external_id="skipped-video",
            title="Skipped song",
            artist="Skipped artist",
            event_type="skip",
            surface="flow",
            algorithm_version="hybrid-v5",
        )
    )
    db.commit()

    profile = _taste_profile(db, user.id)

    assert "ytmusic:skipped-video" in profile["skipped_external_ids"]
    assert "skipped-video" in profile["recent_video_ids"]


def test_external_population_stats_count_distinct_users_on_sqlite(db):
    users = [create_user(db, username=f"quality-user-{index}") for index in range(4)]
    for user in users[:3]:
        db.execute(
            recommendation_events.insert().values(
                user_id=user.id,
                source="ytmusic",
                external_id="widely-skipped",
                event_type="skip",
                surface="flow",
                algorithm_version="hybrid-v5",
            )
        )
    # A repeated event from the same listener must not amplify population harm.
    db.execute(
        recommendation_events.insert().values(
            user_id=users[0].id,
            source="ytmusic",
            external_id="widely-skipped",
            event_type="skip",
            surface="flow",
            algorithm_version="hybrid-v5",
        )
    )
    db.execute(
        recommendation_events.insert().values(
            user_id=users[3].id,
            source="ytmusic",
            external_id="accepted",
            event_type="listen",
            surface="flow",
            algorithm_version="hybrid-v5",
        )
    )
    db.commit()

    items = [
        ExternalTrackResponse(
            id="ytmusic:widely-skipped",
            source="ytmusic",
            external_id="widely-skipped",
            title="Skipped",
            artist="Unknown",
            duration=180,
            stream_url="",
        ),
        ExternalTrackResponse(
            id="ytmusic:accepted",
            source="ytmusic",
            external_id="accepted",
            title="Accepted",
            artist="Known",
            duration=180,
            stream_url="",
        ),
    ]

    stats = _external_population_stats_on_bind(db.get_bind(), items)

    skipped = stats["ytmusic:widely-skipped"]
    assert skipped["negative_users"] == 3
    assert skipped["quality"] < 0.0
    assert population_rejects(skipped["positive_users"], skipped["negative_users"])
    assert stats["ytmusic:accepted"]["positive_users"] == 1
