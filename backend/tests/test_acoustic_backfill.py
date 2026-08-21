from types import SimpleNamespace

from scripts import backfill_acoustic_features


class _Query:
    def __init__(self, session):
        self.session = session

    def filter(self, *_args):
        return self

    def order_by(self, *_args):
        return self

    def limit(self, size):
        self.session.requested_sizes.append(size)
        return self

    def all(self):
        if not self.session.batches:
            return []
        return self.session.batches.pop(0)

    def yield_per(self, _size):
        raise AssertionError("backfill must not use a cursor across commits")


class _Session:
    def __init__(self, batches):
        self.batches = list(batches)
        self.requested_sizes = []
        self.query_count = 0
        self.commit_count = 0
        self.closed = False

    def query(self, _model):
        self.query_count += 1
        return _Query(self)

    def commit(self):
        self.commit_count += 1

    def close(self):
        self.closed = True


def test_backfill_commits_between_independent_keyset_batches(monkeypatch):
    tracks = [SimpleNamespace(id=index) for index in range(1, 6)]
    session = _Session([tracks[:2], tracks[2:4], tracks[4:], []])
    analyzed_ids = []

    monkeypatch.setattr(backfill_acoustic_features, "SessionLocal", lambda: session)
    monkeypatch.setattr(
        backfill_acoustic_features,
        "analyze_track",
        lambda track: analyzed_ids.append(track.id) or True,
    )
    monkeypatch.setattr(
        "sys.argv",
        ["backfill_acoustic_features", "--commit-every", "2"],
    )

    backfill_acoustic_features.main()

    assert analyzed_ids == [1, 2, 3, 4, 5]
    assert session.query_count == 4
    assert session.requested_sizes == [2, 2, 2, 2]
    assert session.commit_count == 3
    assert session.closed


def test_backfill_limit_caps_the_last_batch(monkeypatch):
    tracks = [SimpleNamespace(id=index) for index in range(1, 4)]
    session = _Session([tracks[:2], tracks[2:]])

    monkeypatch.setattr(backfill_acoustic_features, "SessionLocal", lambda: session)
    monkeypatch.setattr(backfill_acoustic_features, "analyze_track", lambda _track: True)
    monkeypatch.setattr(
        "sys.argv",
        [
            "backfill_acoustic_features",
            "--commit-every",
            "2",
            "--limit",
            "3",
        ],
    )

    backfill_acoustic_features.main()

    assert session.requested_sizes == [2, 1]
    assert session.query_count == 2
    assert session.commit_count == 2
    assert session.closed
