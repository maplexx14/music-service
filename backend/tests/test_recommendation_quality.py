import ast
import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from starlette.requests import Request

from app.acoustic_features import acoustic_similarity, weighted_centroid
from app.models import Playlist, Track, playlist_tracks, recommendation_events
from app.playlist_signals import aggregate_playlist_origin, imported_playlist_clause
from app.recommendation_scoring import (
    LOCAL_POPULARITY_REFERENCE,
    SERVICE_POPULARITY_REFERENCE,
    popularity_score,
    population_quality_score,
    population_rejects,
    score_track,
)
from app.routers.flow import (
    _EXPLORE_MIN_SERVICE_PLAYS,
    _drop_service_unpopular,
    _external_population_stats_on_bind,
    _taste_profile,
)
from app.routers.soundcloud import _normalize_api as normalize_soundcloud
from app.routers.ytdlp import _normalize as normalize_ytmusic
from app.schemas import ExternalTrackResponse

from tests.conftest import create_user


def _features(**overrides):
    vector = {
        "tempo": 0.5,
        "loudness": 0.5,
        "dynamics": 0.5,
        "brightness": 0.5,
        "bass": 0.5,
        "zero_crossing": 0.5,
        "pulse_clarity": 0.5,
    }
    vector.update(overrides)
    return {"vector": vector}


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


def test_content_profile_migration_upgrades_0019_schema_and_cleans_only_fake_plays():
    """The data migration works on a real pre-origin schema and stays cautious."""
    engine = sa.create_engine("sqlite://")
    metadata = sa.MetaData()
    tracks = sa.Table(
        "tracks",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("play_count", sa.Integer, nullable=False, default=0),
        sa.Column("unique_listener_count", sa.Integer, nullable=False, default=0),
    )
    playlists = sa.Table(
        "playlists",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("owner_id", sa.Integer, nullable=False),
        sa.Column("description", sa.String),
        sa.Column("is_liked", sa.Boolean, nullable=False, default=False),
    )
    playlist_tracks_table = sa.Table(
        "playlist_tracks",
        metadata,
        sa.Column("playlist_id", sa.Integer, nullable=False),
        sa.Column("track_id", sa.Integer, nullable=False),
        sa.Column("added_at", sa.DateTime(timezone=True)),
    )
    plays = sa.Table(
        "user_track_plays",
        metadata,
        sa.Column("user_id", sa.Integer, primary_key=True),
        sa.Column("track_id", sa.Integer, primary_key=True),
        sa.Column("play_count", sa.Integer, nullable=False),
        sa.Column("last_played", sa.DateTime(timezone=True)),
    )
    events = sa.Table(
        "user_play_events",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, nullable=False),
        sa.Column("track_id", sa.Integer, nullable=False),
        sa.Column("played_at", sa.DateTime(timezone=True)),
        sa.Column("completion", sa.Float),
        sa.Column("client_hour", sa.Integer),
    )
    imported_at = datetime(2026, 7, 1, 12, tzinfo=timezone.utc)
    later = imported_at + timedelta(hours=1)

    migration_path = (
        Path(__file__).parents[1]
        / "alembic"
        / "versions"
        / "0020_recommendation_content_profile.py"
    )
    spec = importlib.util.spec_from_file_location("migration_0020_test", migration_path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)

    with engine.begin() as connection:
        metadata.create_all(connection)
        connection.execute(
            tracks.insert(),
            [
                {"id": 1, "play_count": 5, "unique_listener_count": 3},
                {"id": 2, "play_count": 8, "unique_listener_count": 4},
            ],
        )
        connection.execute(
            playlists.insert().values(
                id=10,
                owner_id=7,
                description="Импортировано из Spotify",
                is_liked=False,
            )
        )
        connection.execute(
            playlist_tracks_table.insert(),
            [
                {"playlist_id": 10, "track_id": 1, "added_at": imported_at},
                {"playlist_id": 10, "track_id": 2, "added_at": imported_at},
            ],
        )
        connection.execute(
            plays.insert(),
            [
                {
                    "user_id": 7,
                    "track_id": 1,
                    "play_count": 1,
                    "last_played": imported_at,
                },
                {
                    "user_id": 7,
                    "track_id": 2,
                    "play_count": 2,
                    "last_played": later,
                },
            ],
        )
        connection.execute(
            events.insert(),
            [
                {
                    "id": 100,
                    "user_id": 7,
                    "track_id": 1,
                    "played_at": imported_at,
                    "completion": 1.0,
                    "client_hour": None,
                },
                {
                    "id": 101,
                    "user_id": 7,
                    "track_id": 2,
                    "played_at": imported_at,
                    "completion": 1.0,
                    "client_hour": None,
                },
                {
                    "id": 102,
                    "user_id": 7,
                    "track_id": 2,
                    "played_at": later,
                    "completion": 0.9,
                    "client_hour": 13,
                },
            ],
        )

        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()

        upgraded = sa.MetaData()
        upgraded_tracks = sa.Table("tracks", upgraded, autoload_with=connection)
        upgraded_playlists = sa.Table("playlists", upgraded, autoload_with=connection)
        upgraded_plays = sa.Table("user_track_plays", upgraded, autoload_with=connection)
        upgraded_events = sa.Table("user_play_events", upgraded, autoload_with=connection)

        assert {
            "acoustic_features",
            "acoustic_analyzed_at",
            "acoustic_analyzer_version",
        } <= set(upgraded_tracks.c.keys())
        assert connection.execute(
            sa.select(upgraded_playlists.c.origin).where(upgraded_playlists.c.id == 10)
        ).scalar_one() == "imported"
        assert connection.execute(
            sa.select(upgraded_plays.c.track_id).order_by(upgraded_plays.c.track_id)
        ).scalars().all() == [2]
        assert connection.execute(
            sa.select(upgraded_events.c.id).order_by(upgraded_events.c.id)
        ).scalars().all() == [101, 102]
        counters = connection.execute(
            sa.select(
                upgraded_tracks.c.id,
                upgraded_tracks.c.play_count,
                upgraded_tracks.c.unique_listener_count,
            ).order_by(upgraded_tracks.c.id)
        ).all()
        assert counters == [(1, 4, 2), (2, 8, 4)]


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


def _external(external_id: str, play_count: int = 0) -> ExternalTrackResponse:
    return ExternalTrackResponse(
        id=f"ytmusic:{external_id}",
        source="ytmusic",
        external_id=external_id,
        title=external_id,
        artist="Somebody",
        duration=180,
        stream_url="",
        play_count=play_count,
    )


def test_popularity_scales_are_separate_for_local_and_provider_counters():
    """Наш счётчик и метрика площадки — разные порядки величин.

    300 прослушиваний в этом каталоге — заигранный трек; 300 просмотров на
    площадке значит, что его не слушал никто. На общей кривой оба выходили
    одинаково «популярными», и любой внешний кандидат получал почти полный балл.
    """
    assert popularity_score(300, 90, reference=LOCAL_POPULARITY_REFERENCE) > 0.6
    assert popularity_score(300, reference=SERVICE_POPULARITY_REFERENCE) < 0.45
    assert popularity_score(
        5_000, reference=SERVICE_POPULARITY_REFERENCE
    ) < popularity_score(3_000_000, reference=SERVICE_POPULARITY_REFERENCE)


def test_popularity_outweighs_the_novelty_bonus_for_a_service_hit():
    """Хит не должен уступать безымянной загрузке только за счёт новизны.

    До hybrid-v7 popularity_score сжимал весь реальный диапазон прослушиваний в
    0.72..0.98, поэтому разница между 5k и 3M стоила 0.04 балла — меньше одного
    бонуса за новизну (+0.16), и обскурный «новый» трек обгонял популярный.
    """
    hit = score_track(
        _external("hit", play_count=3_000_000),
        play_count=3_000_000,
        popularity_reference=SERVICE_POPULARITY_REFERENCE,
        novelty=False,
    )
    obscure = score_track(
        _external("obscure", play_count=5_000),
        play_count=5_000,
        popularity_reference=SERVICE_POPULARITY_REFERENCE,
        novelty=True,
    )

    assert hit > obscure


def test_search_exploration_drops_low_play_uploads_but_keeps_unknown_metric():
    """Поисковая разведка не должна тащить в пул любительские загрузки.

    Ноль — это «провайдер метрику не прислал», такой трек порог проходит:
    плоская выдача yt-dlp бывает вообще без счётчиков.
    """
    kept = {
        track.external_id
        for track in _drop_service_unpopular(
            [
                _external("loud", play_count=_EXPLORE_MIN_SERVICE_PLAYS * 2),
                _external("quiet", play_count=12),
                _external("no-metric", play_count=0),
            ]
        )
    }

    assert kept == {"loud", "no-metric"}


def test_acoustic_similarity_and_weighted_centroid():
    quiet = _features(tempo=0.2, brightness=0.2, bass=0.8)
    energetic = _features(tempo=0.8, brightness=0.8, bass=0.2)
    centroid = weighted_centroid([(quiet, 3.0), (energetic, 1.0)])

    assert centroid["tempo"] == pytest.approx(0.35)
    assert centroid["brightness"] == pytest.approx(0.35)
    assert centroid["bass"] == pytest.approx(0.65)
    assert acoustic_similarity(quiet, quiet) == 1.0
    assert acoustic_similarity(quiet, centroid) > acoustic_similarity(
        energetic, centroid
    )
    assert acoustic_similarity({}, centroid) == 0.0


def test_score_track_rewards_acoustic_fit_for_a_new_artist():
    profile = _features(tempo=0.25, brightness=0.2, bass=0.8)
    close = {
        "id": "close",
        "artist": "New Artist",
        "source": "local",
        "acoustic_features": _features(tempo=0.28, brightness=0.22, bass=0.78),
    }
    far = {
        "id": "far",
        "artist": "Known Artist",
        "source": "local",
        "acoustic_features": _features(tempo=0.9, brightness=0.9, bass=0.1),
    }

    close_score = score_track(
        close,
        artist_affinity=0.0,
        novelty=True,
        acoustic_profile=profile,
    )
    far_score = score_track(
        far,
        artist_affinity=1.0,
        novelty=False,
        acoustic_profile=profile,
    )

    assert close_score > far_score


def test_playlist_origin_aggregation_prefers_manual_and_detects_legacy(db):
    user = create_user(db, username="playlist-origin-user")
    track = Track(title="shared", artist="Artist", duration=120, source="local")
    imported = Playlist(
        name="Imported",
        description="Импортировано из Spotify",
        origin="manual",
        is_public=False,
        owner_id=user.id,
    )
    manual = Playlist(
        name="Manual",
        origin="manual",
        is_public=False,
        owner_id=user.id,
    )
    db.add_all([track, imported, manual])
    db.commit()
    db.execute(
        playlist_tracks.insert(),
        [
            {"playlist_id": imported.id, "track_id": track.id, "position": 0},
            {"playlist_id": manual.id, "track_id": track.id, "position": 0},
        ],
    )
    db.commit()

    legacy_ids = {
        playlist_id
        for (playlist_id,) in db.query(Playlist.id)
        .filter(imported_playlist_clause())
        .all()
    }
    origin = (
        db.query(aggregate_playlist_origin())
        .select_from(Track)
        .join(playlist_tracks, playlist_tracks.c.track_id == Track.id)
        .join(Playlist, Playlist.id == playlist_tracks.c.playlist_id)
        .filter(Track.id == track.id)
        .scalar()
    )

    assert imported.id in legacy_ids
    assert origin == "manual"


def test_manual_and_imported_playlist_build_equal_acoustic_profile_weight(db):
    user = create_user(db, username="playlist-weight-user")
    manual_track = Track(
        title="manual",
        artist="ManualArtist",
        duration=120,
        source="local",
        acoustic_features=_features(tempo=0.1, brightness=0.1, bass=0.9),
    )
    imported_track = Track(
        title="imported",
        artist="ImportedArtist",
        duration=120,
        source="local",
        acoustic_features=_features(tempo=0.9, brightness=0.9, bass=0.1),
    )
    manual = Playlist(
        name="Manual", origin="manual", is_public=False, owner_id=user.id
    )
    imported = Playlist(
        name="Imported", origin="imported", is_public=False, owner_id=user.id
    )
    db.add_all([manual_track, imported_track, manual, imported])
    db.commit()
    db.execute(
        playlist_tracks.insert(),
        [
            {"playlist_id": manual.id, "track_id": manual_track.id, "position": 0},
            {
                "playlist_id": imported.id,
                "track_id": imported_track.id,
                "position": 0,
            },
        ],
    )
    db.commit()

    profile = _taste_profile(db, user.id)["acoustic_profile"]

    # A single imported track is now an intentional taste signal, close to a
    # like. Manual curation remains stronger for artist/catalogue trust, but
    # the acoustic centroid gives both tracks the same per-track weight.
    assert profile["tempo"] == pytest.approx(0.5)
    assert profile["brightness"] == pytest.approx(0.5)
    assert profile["bass"] == pytest.approx(0.5)


def test_old_soundcloud_reupload_uses_artist_from_title_in_profile(db):
    user = create_user(db, username="soundcloud-profile-user")
    playlist = Playlist(
        name="Imported SoundCloud",
        origin="imported",
        description="Импортировано из SoundCloud",
        is_public=False,
        owner_id=user.id,
    )
    track = Track(
        title="Kordhell - Murder In My Mind",
        artist="TrapNation",
        duration=180,
        source="soundcloud",
        external_id="legacy-reupload",
        stream_url="https://soundcloud.test/stream",
        acoustic_features=_features(tempo=0.8),
    )
    db.add_all([playlist, track])
    db.commit()
    db.execute(
        playlist_tracks.insert().values(
            playlist_id=playlist.id,
            track_id=track.id,
            position=0,
        )
    )
    db.commit()

    profile = _taste_profile(db, user.id)

    assert profile["artist_weight"]["kordhell"] == pytest.approx(3.0)
    assert "trapnation" not in profile["artist_weight"]
    assert ("Kordhell", "Murder In My Mind") in profile["seed_tracks"]
    assert profile["playlist_artists"] == []
    assert profile["trusted_artist_keys"] == []


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
