"""
Fetch the real shape of Penang's two bridges from OpenStreetMap (Overpass API) and save a
DETAILED centre line (island end -> mainland end) to src/bridges.js for the app.
The app uses it to draw map dots exactly on the bridge road and to label "KM 6".

Run in Cloud Shell:   python3 ~/jomisu/api/bridge_points.py
Uses only the Python standard library. Free; no Google Cloud credits used.
If a server is busy it tries the next one; if all fail, src/bridges.js is left unchanged.
"""
import json
import math
import os
import urllib.parse
import urllib.request

# Public Overpass servers, tried in order. The main one is often busy (HTTP 502/504).
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
SLICE_M = 250       # one centre-line point every ~250 m: follows every curve closely
MAX_OFF_LINE_M = 500  # ignore OSM bits further than this from the rough line (other small bridges)
OUT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "bridges.js")

# Each bridge: search names, its own search box (south, west, north, east) so names can't
# mix up, and the rough 8-point line from 15 Oct used to throw away unrelated roads.
BRIDGES = [
    {
        "label": "Second Bridge",
        "names": "Sultan Abdul Halim|Second Penang Bridge|Penang Second Bridge|Kedua",
        "bbox": "5.20,100.27,5.31,100.45",
        "rough": [(5.29117, 100.29528), (5.27656, 100.31903), (5.26106, 100.33847), (5.2544, 100.35713),
                  (5.24754, 100.37789), (5.23279, 100.3958), (5.22535, 100.41394), (5.2291, 100.43371)],
    },
    {
        "label": "Penang Bridge",
        "names": "Pulau Pinang|Penang Bridge",
        "bbox": "5.33,100.28,5.39,100.42",
        "rough": [(5.35889, 100.31703), (5.35669, 100.32894), (5.35523, 100.3384), (5.35371, 100.34823),
                  (5.3523, 100.35771), (5.35137, 100.36694), (5.35216, 100.37685), (5.35363, 100.38817)],
    },
]


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
    # Densify: OSM puts few nodes on straight stretches, so add a point every ~50 m
    # along each road piece. That way no slice below ends up empty.
    pts = []
    for el in data["elements"]:
        geom = [(p["lat"], p["lon"]) for p in el.get("geometry", [])]
        for a, b in zip(geom, geom[1:]):
            steps = max(1, int(dist_m(a, b) // 50))
            pts += [(a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps) for i in range(steps)]
        if geom:
            pts.append(geom[-1])
    return pts


def dist_m(a, b):
    """Great-circle distance in metres between two (lat, lng) points."""
    lat1, lng1, lat2, lng2 = map(math.radians, (*a, *b))
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2)
    return 2 * 6371000 * math.asin(math.sqrt(h))


def dist_to_line_m(p, line):
    """Shortest distance (m) from point p to a line of points (flattened to metres)."""
    kx, ky = 111320 * math.cos(math.radians(p[0])), 110540
    best = float("inf")
    for a, b in zip(line, line[1:]):
        ax, ay = (a[1] - p[1]) * kx, (a[0] - p[0]) * ky
        bx, by = (b[1] - p[1]) * kx, (b[0] - p[0]) * ky
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        t = 0.0 if seg2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / seg2))
        best = min(best, math.hypot(ax + t * dx, ay + t * dy))
    return best


def centre_line(points, rough):
    """Both bridges run west (island) to east (mainland): cut into ~250 m slices by longitude
    and average each slice. Averaging also merges the two carriageways into one centre line."""
    points = [p for p in points if dist_to_line_m(p, rough) <= MAX_OFF_LINE_M]
    west = min(p[1] for p in points)
    east = max(p[1] for p in points)
    n = max(8, int(dist_m((points[0][0], west), (points[0][0], east)) // SLICE_M))
    width = (east - west) / n
    slices = [[] for _ in range(n)]
    for lat, lng in points:
        slices[min(int((lng - west) / width), n - 1)].append((lat, lng))
    return [
        (round(sum(p[0] for p in s) / len(s), 6), round(sum(p[1] for p in s) / len(s), 6))
        for s in slices if s
    ]


def length_km(line):
    return sum(dist_m(a, b) for a, b in zip(line, line[1:])) / 1000


def map_link(line):
    """A geojson.io link that draws the line on a map, to check it visually."""
    geojson = {"type": "LineString", "coordinates": [[lng, lat] for lat, lng in line]}
    return "https://geojson.io/#data=data:application/json," + urllib.parse.quote(json.dumps(geojson))


def main():
    results = []
    for b in BRIDGES:
        print(f"\n=== {b['label']} ===")
        try:
            pts = fetch_points(b["names"], b["bbox"])
        except Exception as err:  # network or servers busy
            print(f"Could not fetch: {err}. Wait 2 minutes and run again.")
            return
        if not pts:
            print("Not found in OpenStreetMap. Tell Claude.")
            return
        line = centre_line(pts, b["rough"])
        print(f"Raw points: {len(pts)}  |  Centre line: {len(line)} points, {length_km(line):.1f} km")
        print("Check on a map:", map_link(line)[:120] + "...")
        results.append((b["label"], line))

    # Write the JavaScript file the app imports.
    js = ["// AUTO-GENERATED by api/bridge_points.py from OpenStreetMap. Do not edit by hand.",
          "// Centre lines of Penang's two bridges (island end first, so KM 0 = island end).",
          "export const BRIDGE_LINES = ["]
    for label, line in results:
        pts = ", ".join(f"[{lat}, {lng}]" for lat, lng in line)
        js.append(f'  {{ label: "{label}", points: [{pts}] }},')
    js.append("];\n")
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        f.write("\n".join(js))
    print(f"\nSaved {os.path.normpath(OUT_FILE)}  ✅")


if __name__ == "__main__":
    main()
