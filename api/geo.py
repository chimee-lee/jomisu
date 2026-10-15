"""
Places and geometry for Ask a Place.

A place is one of:
  - AREA:  centre point + radius in metres (Gurney, Batu Ferringhi, "near me", any OSM place)
  - ROUTE: line of points + corridor width in metres (bridges). Stories get a KM position.
Coordinates are (lat, lng).
"""
import math
import threading
import time

import requests

USER_AGENT = "Jomisu/0.1 (+https://github.com/chimee-lee/jomisu)"  # OSM requires an app name
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
NEAR_ME_RADIUS_M = 500
MIN_AREA_RADIUS_M = 500     # a single building still gets a 500 m search area
MAX_AREA_RADIUS_M = 15000   # stops country-sized searches

# ---- Safety-net list ----
# Bridge points run island -> mainland, so KM 0 = island end of the bridge.
# Bridge lines come from OpenStreetMap (bridge_points.py, 15 Oct 2026), checked on a map.
KNOWN_PLACES = [
    # Second Bridge is listed first so "second bridge" never matches "Penang Bridge"
    {
        "name": "Penang Second Bridge",
        "aliases": ["penang second bridge", "second bridge", "2nd bridge", "sultan abdul halim",
                    "jambatan kedua"],
        "kind": "route",
        "points": [(5.29117, 100.29528), (5.27656, 100.31903), (5.26106, 100.33847), (5.2544, 100.35713),
                   (5.24754, 100.37789), (5.23279, 100.3958), (5.22535, 100.41394), (5.2291, 100.43371)],
        "corridor_m": 500,
    },
    {
        "name": "Penang Bridge",
        "aliases": ["penang bridge", "first bridge", "1st bridge", "jambatan pulau pinang"],
        "kind": "route",
        "points": [(5.35889, 100.31703), (5.35669, 100.32894), (5.35523, 100.3384), (5.35371, 100.34823),
                   (5.3523, 100.35771), (5.35137, 100.36694), (5.35216, 100.37685), (5.35363, 100.38817)],
        "corridor_m": 500,
    },
    {"name": "Gurney", "aliases": ["gurney"], "kind": "area",
     "center": (5.4375, 100.3098), "radius_m": 1000},
    {"name": "Batu Ferringhi", "aliases": ["batu ferringhi", "batu feringgi"], "kind": "area",
     "center": (5.4725, 100.2460), "radius_m": 2500},
]


# ---- Geometry ----
def haversine_m(a, b):
    """Great-circle distance in metres between two (lat, lng) points."""
    lat1, lng1, lat2, lng2 = map(math.radians, (*a, *b))
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2)
    return 2 * 6371000 * math.asin(math.sqrt(h))


def _xy(p, ref):
    """Flatten (lat, lng) to metres around ref. Accurate enough over a few tens of km."""
    x = (p[1] - ref[1]) * 111320 * math.cos(math.radians(ref[0]))
    y = (p[0] - ref[0]) * 110540
    return x, y


def route_position(point, route):
    """Return (distance from route in m, KM along route) for the nearest spot on the line."""
    ref = route[0]
    px, py = _xy(point, ref)
    best_d, best_along, walked = float("inf"), 0.0, 0.0
    for a, b in zip(route, route[1:]):
        (ax, ay), (bx, by) = _xy(a, ref), _xy(b, ref)
        dx, dy = bx - ax, by - ay
        seg = math.hypot(dx, dy)
        # t = how far along this segment the closest point is (0 = start, 1 = end)
        t = 0.0 if seg == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg ** 2))
        d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
        if d < best_d:
            best_d, best_along = d, walked + t * seg
        walked += seg
    return best_d, best_along / 1000


def place_contains(place, lat, lng):
    """Return (inside?, km or None)."""
    if place["kind"] == "route":
        d, km = route_position((lat, lng), place["points"])
        return d <= place["corridor_m"], round(km, 1)
    return haversine_m(place["center"], (lat, lng)) <= place["radius_m"], None


# ---- Finding a place ----
def find_known_place(*texts):
    """Match the question or Gemini's place name against the safety-net list."""
    joined = " ".join(t.lower() for t in texts if t)
    for place in KNOWN_PLACES:
        if any(alias in joined for alias in place["aliases"]):
            return {**place, "source": "jomisu"}
    return None


_cache = {}
_lock = threading.Lock()
_last_call = [0.0]


def geocode(query):
    """Look up any place worldwide with OpenStreetMap. Cached; max 1 request/second."""
    key = query.strip().lower()
    if key in _cache:
        return _cache[key]
    with _lock:
        wait = 1.0 - (time.monotonic() - _last_call[0])
        if wait > 0:
            time.sleep(wait)
        resp = requests.get(NOMINATIM_URL, timeout=10, headers={"User-Agent": USER_AGENT},
                            params={"q": query, "format": "jsonv2", "limit": 1})
        _last_call[0] = time.monotonic()
    resp.raise_for_status()
    results = resp.json()
    place = _result_to_area(results[0]) if results else None
    _cache[key] = place
    return place


def _result_to_area(r):
    """Turn an OSM result's bounding box into a circle that covers it."""
    south, north, west, east = map(float, r["boundingbox"])
    radius = haversine_m((south, west), (north, east)) / 2
    return {
        "name": ", ".join(r["display_name"].split(", ")[:2]),
        "kind": "area",
        "center": (float(r["lat"]), float(r["lon"])),
        "radius_m": int(min(max(radius, MIN_AREA_RADIUS_M), MAX_AREA_RADIUS_M)),
        "source": "openstreetmap",
    }


def resolve_place(question, place_query, near_me, user_pos):
    """Decide which place to search. Returns a place dict or None."""
    if near_me and user_pos:
        return {"name": "Near you", "kind": "area", "center": user_pos,
                "radius_m": NEAR_ME_RADIUS_M, "source": "gps"}
    known = find_known_place(place_query, question)
    if known:
        return known
    return geocode(place_query) if place_query else None
