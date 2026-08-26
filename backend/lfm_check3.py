import os, json, urllib.parse, urllib.request
from sqlalchemy import select
from app.database import SessionLocal
from app.models import Track
from app.genre_keywords import infer_genre_from_text
from app import beets_genre

KEY = os.getenv("LASTFM_API_KEY")
def top_tags(artist):
    url = "https://ws.audioscrobbler.com/2.0/?" + urllib.parse.urlencode(
        {"method": "artist.getTopTags", "artist": artist, "api_key": KEY, "format": "json"})
    req = urllib.request.Request(url, headers={"User-Agent": "music-service/1.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.loads(r.read())
    return [t["name"] for t in (data.get("toptags") or {}).get("tag", [])][:5]

db = SessionLocal()
artists = [a for (a,) in db.execute(select(Track.artist).distinct().limit(14)).all() if a]
hit = 0
for a in artists:
    try:
        tags = top_tags(a)
    except Exception as exc:
        print(f"{a[:26]:26} FAIL {exc}"); continue
    mapped = [m for m in (infer_genre_from_text(t) or beets_genre.to_internal(t) for t in tags) if m]
    ok = "OK " if mapped else "-- "
    hit += bool(mapped)
    print(f"{ok}{a[:26]:26} {tags}\n{'':29} -> {mapped[0] if mapped else 'НЕ СВЁЛСЯ'}")
print(f"\nжанр восстановлен у {hit}/{len(artists)} артистов (было 0 из названий)")
db.close()
