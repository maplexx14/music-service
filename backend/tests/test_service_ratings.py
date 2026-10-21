"""«Оценить сервис»: PUT /feedback/rating от юзера, сводка в админке."""

from tests.conftest import auth_headers, create_user


def test_rating_replaces_previous_and_admin_sees_summary(client, db):
    create_user(db, "listener")
    create_user(db, "other")
    create_user(db, "boss", is_admin=True)
    listener = auth_headers(client, "listener")

    assert client.get("/api/feedback/rating", headers=listener).json() is None

    resp = client.put("/api/feedback/rating", json={"score": 2}, headers=listener)
    assert resp.status_code == 200, resp.text
    resp = client.put(
        "/api/feedback/rating",
        json={"score": 4, "comment": "  Волна стала лучше  "},
        headers=listener,
    )
    assert resp.status_code == 200, resp.text
    mine = client.get("/api/feedback/rating", headers=listener).json()
    assert mine["score"] == 4
    assert mine["comment"] == "Волна стала лучше"

    client.put("/api/feedback/rating", json={"score": 5}, headers=auth_headers(client, "other"))

    summary = client.get("/api/feedback/ratings", headers=auth_headers(client, "boss")).json()
    assert summary["total"] == 2
    assert summary["average"] == 4.5
    assert summary["distribution"] == {"1": 0, "2": 0, "3": 0, "4": 1, "5": 1}
    assert {item["user"]["username"] for item in summary["items"]} == {"listener", "other"}


def test_score_out_of_range_rejected(client, db):
    create_user(db, "listener")
    headers = auth_headers(client, "listener")
    assert client.put("/api/feedback/rating", json={"score": 0}, headers=headers).status_code == 422
    assert client.put("/api/feedback/rating", json={"score": 6}, headers=headers).status_code == 422


def test_non_admin_cannot_list_ratings(client, db):
    create_user(db, "listener")
    resp = client.get("/api/feedback/ratings", headers=auth_headers(client, "listener"))
    assert resp.status_code == 403
