import requests

# Login as user 11 (maplex)
r = requests.post('http://localhost:8000/api/auth/login', json={'username': 'maplex', 'password': 'maplex13A'})
if r.status_code == 200:
    token = r.json()['access_token']
else:
    print(f'Login failed: {r.status_code} {r.text[:200]}')
    exit(1)

headers = {'Authorization': f'Bearer {token}'}
recs = requests.get('http://localhost:8000/api/recommendations/?limit=20', headers=headers)
if recs.status_code == 200:
    tracks = recs.json().get('tracks', [])
    print(f'Got {len(tracks)} tracks')
    for t in tracks:
        artist = t.get('artist', '?')
        title = t.get('title', '?')
        print(f'  {artist} - {title}')
else:
    print(f'Recs error: {recs.status_code} {recs.text[:300]}')
