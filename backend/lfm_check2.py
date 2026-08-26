import os, json, urllib.parse, urllib.request, urllib.error
KEY = os.getenv("LASTFM_API_KEY")

def call(method, **params):
    q = {"method": method, "api_key": KEY, "format": "json", **params}
    url = "https://ws.audioscrobbler.com/2.0/?" + urllib.parse.urlencode(q)
    req = urllib.request.Request(url, headers={"User-Agent": "music-service/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read()[:300])
        except Exception:
            return exc.code, "<non-json>"

for m, p in [
    ("track.getSimilar", {"artist": "Powerwolf", "track": "Army of the Night"}),
    ("artist.getSimilar", {"artist": "Powerwolf"}),
    ("track.getTopTags", {"artist": "Powerwolf", "track": "Army of the Night"}),
    ("artist.getTopTags", {"artist": "Powerwolf"}),
]:
    status, body = call(m, **p)
    if status == 200:
        keys = list(body.keys())
        inner = body.get(m.split(".")[0] + "s") or body.get("similartracks") or body.get("similarartists") or body.get("toptags") or {}
        n = len((inner or {}).get("track") or (inner or {}).get("artist") or (inner or {}).get("tag") or [])
        print(f"{m:20} HTTP 200  keys={keys}  items={n}")
    else:
        print(f"{m:20} HTTP {status}  {body}")

print("\n--- похожие артисты через artist.getInfo (не getSimilar) ---")
st, body = call("artist.getInfo", artist="Powerwolf")
sim = (((body or {}).get("artist") or {}).get("similar") or {}).get("artist") or []
print("HTTP", st, "->", [a["name"] for a in sim])

print("\n--- beets_similar через pylast ---")
from app import beets_similar
print("available():", beets_similar.available())
print("similar_tracks:", beets_similar.similar_tracks("Powerwolf", "Army of the Night", limit=5))
