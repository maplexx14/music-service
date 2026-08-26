import os, json, urllib.parse, urllib.request, urllib.error

KEY = os.getenv("LASTFM_API_KEY") or ""
print(f"LASTFM_API_KEY in process: {KEY[:8]}…{KEY[-4:]} (len {len(KEY)})" if KEY else "LASTFM_API_KEY: NOT SET")

def call(method, key, **params):
    q = {"method": method, "api_key": key, "format": "json", **params}
    url = "https://ws.audioscrobbler.com/2.0/?" + urllib.parse.urlencode(q)
    req = urllib.request.Request(url, headers={"User-Agent": "music-service/1.0 (+local dev)"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as exc:
        raw = exc.read()[:400].decode("utf-8", "replace")
        try:
            return exc.code, json.loads(raw)
        except Exception:
            return exc.code, {"_raw_body": raw}
    except Exception as exc:
        return None, {"_transport_error": f"{type(exc).__name__}: {exc}"}

print("\n--- 1. наш ключ, artist.getTopTags(Powerwolf) ---")
print(call("artist.getTopTags", KEY, artist="Powerwolf"))

print("\n--- 2. наш ключ, эндпоинт без ключа-специфики: artist.getInfo ---")
print(call("artist.getInfo", KEY, artist="Powerwolf"))

print("\n--- 3. ЗАВЕДОМО МУСОРНЫЙ ключ (различаем 'ключ плохой' vs 'нас блокируют') ---")
print(call("artist.getTopTags", "0"*32, artist="Powerwolf"))

print("\n--- 4. вообще без ключа ---")
print(call("artist.getTopTags", "", artist="Powerwolf"))

print("\n--- 5. достижимость хоста без API (просто HTTPS) ---")
try:
    req = urllib.request.Request("https://ws.audioscrobbler.com/", headers={"User-Agent": "curl/8"})
    with urllib.request.urlopen(req, timeout=15) as r:
        print("GET / ->", r.status, len(r.read()), "bytes")
except urllib.error.HTTPError as exc:
    print("GET / -> HTTP", exc.code, exc.read()[:200].decode("utf-8", "replace"))
except Exception as exc:
    print("GET / ->", type(exc).__name__, exc)
