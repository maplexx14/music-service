"""Нагрузочный прогон по ключевым эндпоинтам. stdlib, без зависимостей.

Использование: python loadtest.py [base_url]
"""
import json
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000").rstrip("/")
USER, PWD = "loadtest_u", "LoadTest12345"


def req(path, token=None, timeout=60, method="GET", data=None, ctype=None):
    url = BASE + path
    r = urllib.request.Request(url, method=method, data=data)
    if token:
        r.add_header("Authorization", "Bearer " + token)
    if ctype:
        r.add_header("Content-Type", ctype)
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            body = resp.read()
            return time.perf_counter() - t0, resp.status, len(body), body
    except urllib.error.HTTPError as e:
        return time.perf_counter() - t0, e.code, 0, e.read()[:200]
    except Exception as e:  # таймаут/обрыв соединения
        return time.perf_counter() - t0, type(e).__name__, 0, b""


def login():
    body = urllib.parse.urlencode({"username": USER, "password": PWD}).encode()
    _, st, _, raw = req("/api/auth/login", method="POST", data=body,
                        ctype="application/x-www-form-urlencoded")
    if st != 200:
        raise SystemExit(f"login failed: {st} {raw[:200]}")
    return json.loads(raw)["access_token"]


def run(name, path, token, n, conc, timeout=60):
    """path может содержать {i} — подставляется номер запроса (обход кэша)."""
    lat, codes = [], {}
    t0 = time.perf_counter()
    with ThreadPoolExecutor(conc) as ex:
        for d, st, _sz, _b in ex.map(lambda i: req(path.format(i=i), token, timeout), range(n)):
            lat.append(d)
            codes[st] = codes.get(st, 0) + 1
    wall = time.perf_counter() - t0
    lat.sort()
    p = lambda q: lat[min(len(lat) - 1, int(len(lat) * q))]
    ok = codes.get(200, 0)
    print(f"{name:34s} n={n:<4d} c={conc:<3d} rps={n / wall:7.1f} "
          f"p50={p(.5) * 1000:7.0f}ms p95={p(.95) * 1000:8.0f}ms max={lat[-1] * 1000:8.0f}ms "
          f"ok={ok}/{n} {'' if ok == n else codes}")
    return {"name": name, "n": n, "conc": conc, "rps": n / wall,
            "p50": p(.5), "p95": p(.95), "max": lat[-1], "codes": codes}


if __name__ == "__main__":
    token = login()
    _, _, _, raw = req("/api/tracks/?limit=5", token)
    ids = [t["id"] for t in json.loads(raw)]
    print(f"base={BASE} tracks={ids}\n")

    results = []
    for conc in (1, 10, 50):
        results.append(run("health", "/api/health", None, 200, conc, 30))
    print()
    for conc in (1, 10, 50):
        results.append(run("tracks list (limit=50)", "/api/tracks/?limit=50", token, 200, conc, 60))
    print()
    # cached: один и тот же q; cold: уникальный q на каждый запрос (кэш всегда мимо)
    for conc in (1, 10, 30):
        results.append(run("search cached q=love", "/api/search/?q=love&limit=20", token, 100, conc, 60))
    for conc in (1, 10, 30):
        results.append(run("search COLD uniq q", "/api/search/?q=zz{i}&limit=20", token, 100, conc, 60))
    print()
    for conc in (1, 10, 30):
        results.append(run("recs cached", "/api/recommendations/?limit=20", token, 60, conc, 120))
    print()
    for conc in (1, 5, 20):
        results.append(run("flow (limit=8)", "/api/recommendations/flow?limit=8", token, 20, conc, 180))
    print()
    if ids:
        results.append(run("track stream (local)", f"/api/tracks/{ids[0]}/stream", token, 30, 10, 120))
    with open("loadtest_results.json", "w") as f:
        json.dump(results, f, indent=1)
