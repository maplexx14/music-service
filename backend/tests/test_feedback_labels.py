from app.feedback_labels import OutcomeTracker


def _label(*events):
    tracker = OutcomeTracker()
    for event in events:
        tracker.add(*event) if isinstance(event, tuple) else tracker.add(event)
    return tracker.label


def test_completion_thresholds():
    assert _label(("listen", 0.95)) == "good"
    assert _label(("listen", 0.5)) is None
    assert _label(("listen", 0.1)) == "bad"
    # play без listen ничего не говорит об исходе.
    assert _label(("play", 0.3)) is None


def test_skip_followed_by_listen_stays_negative():
    # Фронт шлёт listen при каждом уходе с трека, в том числе после скипа.
    assert _label(("skip", 0.05), ("listen", 0.05)) == "bad"
    assert _label(("skip", 0.2), ("listen", 0.4)) == "bad"


def test_explicit_rating_beats_behaviour():
    assert _label(("listen", 0.95), ("dislike",)) == "bad"
    assert _label(("skip", 0.1), ("like",)) == "good"


def test_withdrawn_rating_falls_back_to_behaviour():
    assert _label(("like",), ("unlike",), ("listen", 0.5)) is None
    assert _label(("like",), ("unlike",), ("listen", 0.9)) == "good"
    assert _label(("dislike",), ("undislike",), ("listen", 0.9)) == "good"
    # Снятие лайка не отменяет более поздний дизлайк.
    assert _label(("like",), ("dislike",), ("unlike",)) == "bad"
