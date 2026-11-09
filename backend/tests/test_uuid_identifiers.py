from uuid import UUID

import pytest
from sqlalchemy import select

from app.cooccurrence import pair_scores, similar_track_ids
from app.models import Track, playlist_tracks, recommendation_impressions, track_cooccurrence, user_play_events
from app.recommendation_telemetry import record_delivery
from app.routers.flow import _parse_exclude
from tests.conftest import auth_headers, create_user
from tests.identifiers import uuid_for


def _track(db, title="UUID track"):
    track = Track(title=title, artist="Artist", duration=180, file_path="/music/example.mp3")
    db.add(track)
    db.commit()
    db.refresh(track)
    return track


def test_uuid_ids_round_trip_through_api_and_relationships(client, db):
    user = create_user(db)
    track = _track(db)
    headers = auth_headers(client)
    response = client.post("/api/playlists/", json={"name": "UUID playlist"}, headers=headers)
    assert response.status_code == 201, response.text
    playlist = response.json()
    ids = [user.id, track.id, playlist["id"]]
    assert len(set(ids)) == 3
    assert all(isinstance(value, str) and UUID(value).version == 4 for value in ids)
    assert playlist["owner_id"] == user.id
    assert client.get(f"/api/tracks/{track.id.upper()}").json()["id"] == track.id

    added = client.post(f"/api/playlists/{playlist['id']}/tracks/{track.id}", headers=headers)
    assert added.status_code == 200, added.text
    membership = db.execute(select(playlist_tracks)).mappings().one()
    assert (membership["playlist_id"], membership["track_id"]) == (playlist["id"], track.id)
    assert client.post(f"/api/tracks/{track.id}/like", headers=headers).status_code == 200
    assert client.get("/api/tracks/me/liked/ids", headers=headers).json() == [track.id]
    listened = client.post(f"/api/tracks/{track.id}/listen", headers=headers,
                           json={"completion": 0.9, "client_hour": 15})
    assert listened.status_code == 200, listened.text
    event = db.execute(select(user_play_events)).mappings().one()
    assert UUID(event["id"]).version == 4
    assert (event["user_id"], event["track_id"], event["client_hour"]) == (user.id, track.id, 15)


@pytest.mark.parametrize("path", ["/api/tracks/{}", "/api/playlists/{}", "/api/users/{}", "/api/share/track/{}"])
@pytest.mark.parametrize("invalid_id", ["123", "not-a-uuid"])
def test_api_rejects_non_uuid_ids(client, db, path, invalid_id):
    create_user(db)
    response = client.get(path.format(invalid_id), headers=auth_headers(client))
    assert response.status_code == 422, response.text


def test_uuid_recommendations_keep_local_and_provider_identities_separate(db):
    user = create_user(db)
    first, second = _track(db, "first"), _track(db, "second")
    record_delivery(db, user_id=user.id, surface="flow", items=[
        first,
        {"id": "soundcloud:123", "db_id": second.id, "source": "soundcloud", "external_id": "123"},
        {"id": "ytmusic:video", "source": "ytmusic", "external_id": "video"},
    ])
    rows = db.execute(select(recommendation_impressions).order_by(
        recommendation_impressions.c.position)).mappings().all()
    assert [row["track_id"] for row in rows] == [first.id, second.id, None]
    assert [row["external_id"] for row in rows] == [None, "123", "video"]
    assert len({row["id"] for row in rows}) == 3
    assert all(UUID(row["id"]).version == 4 for row in rows)
    assert _parse_exclude(f"{first.id.upper()},soundcloud:123,ytmusic:video,123,invalid") == (
        {first.id}, ["video"], {"soundcloud:123", "ytmusic:video"},
    )


def test_cooccurrence_queries_bind_and_return_uuid_strings(db):
    first, second = _track(db, "first"), _track(db, "second")
    db.execute(track_cooccurrence.insert().values(track_id=first.id, other_track_id=second.id, score=0.75))
    db.commit()
    assert similar_track_ids(db, [first.id]) == [(second.id, 0.75)]
    assert pair_scores(db, [first.id, second.id]) == {
        (first.id, second.id): 1.0, (second.id, first.id): 1.0,
    }
    assert similar_track_ids(db, [uuid_for(999)]) == []
