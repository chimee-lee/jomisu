"""
Fetch the real shape of Penang's two bridges from OpenStreetMap (Overpass API)
and print simplified points (island end -> mainland end) for api/geo.py.

Run in Cloud Shell:   python3 ~/bridge_points.py
Uses only the Python standard library. Free; no Google Cloud credits used.
"""
import json
import math
import urllib.parse
import urllib.request

# Public Overpass servers, tried in order. The main one is often busy (HTTP 502/504).
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
N_POINTS = 8  # points kept per bridge; enough to follow the curves

# Each bridge gets its own search box (south, west, north, east) so names can't mix up.
BRIDGES = {
    "Penang Bridge": {
        "names": "Pulau Pinang|Penang Bridge",
        "bbox": "5.33,100.28,5.39,100.42",
    },
    "Penang Second Bridge": {
        "names": "Sultan Abdul Halim|Second Penang Bridge|Penang Second Bridge|Kedua",
        "bbox": "5.20,100.27,5.31,100.45",
    },
}


def fetch_points(names, bbox):
    """Every (lat, lng) point of bridge roads whose name matches, inside the box."""
    query = (
        "[out:json][timeout:60];("
        f'way["bridge"]["name"~"{names}",i]({bbox});'
        f'way["bridge"]["name:en"~"{names}",i]({bbox});'
        ");out geom;"
    )
    body = urllib.parse.urlencode({"data": query}).encode()
    headers = {"User-Agent": "Jomisu/0.1 (https://github.com/chimee-lee/jomisu)"}
    last_err = None
    for url in OVERPASS_URLS:  # move on to the next server if one is busy or slow
        try:
            req = urllib.request.Request(url, data=body, headers=headers)
            with urllib.request.urlopen(req, timeout=45) as resp:
                data = json.load(resp)
            break
        except Exception as err:
            print(f"  {url.split('/')[2]} busy ({err}); trying next server...")
            last_err = err
    else:
        raise RuntimeError(f"all servers busy: {last_err}")
    return [(p["lat"], p["lon"]) for el in data["elements"] for p in el.get("geometry", [])]


def simplify(points, n):
    """Both bridges run west (island) to east (mainland): split by longitude into n slices
    and average each slice. This also merges the two carriageways into one centre line."""
    west = min(p[1] for p in points)
    east = max(p[1] for p in points)
    width = (east - west) / n
    slices = [[] for _ in range(n)]
    for lat, lng in points:
        i = min(int((lng - west) / width), n - 1)
        slices[i].append((lat, lng))
    return [
        (round(sum(p[0] for p in s) / len(s), 5), round(sum(p[1] for p in s) / len(s), 5))
        for s in slices if s
    ]


def length_km(line):
    """Total length of a line of (lat, lng) points, in km."""
    total = 0.0
    for (lat1, lng1), (lat2, lng2) in zip(line, line[1:]):
        a = (math.sin(math.radians(lat2 - lat1) / 2) ** 2
             + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
             * math.sin(math.radians(lng2 - lng1) / 2) ** 2)
        total += 2 * 6371 * math.asin(math.sqrt(a))
    return total


def map_link(line):
    """A geojson.io link that draws the line on a map, to check it visually."""
    geojson = {"type": "LineString", "coordinates": [[lng, lat] for lat, lng in line]}
    return "https://geojson.io/#data=data:application/json," + urllib.parse.quote(json.dumps(geojson))


for name, cfg in BRIDGES.items():
    print(f"\n=== {name} ===")
    try:
        pts = fetch_points(cfg["names"], cfg["bbox"])
    except Exception as err:  # network or server busy
        print(f"Could not fetch: {err}. Wait 2 minutes and run again.")
        continue
    if not pts:
        print("Not found in OpenStreetMap. Tell Claude.")
        continue
    line = simplify(pts, N_POINTS)
    print(f"Raw points: {len(pts)}  |  Simplified line length: {length_km(line):.1f} km")
    print('"points": [' + ", ".join(f"({lat}, {lng})" for lat, lng in line) + "],")
    print("Check on a map:", map_link(line))
