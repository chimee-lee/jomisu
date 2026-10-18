"""
Seed demo stories for the Jomisu video: Penang Second Bridge (KM 6, KM 9) and Gurney.

- Adds 7 stories labelled Demo (demo: True) that never expire.
- Safe to re-run: each story has a fixed ID, so re-running only refreshes it.
  Re-run just before recording the video so "minutes ago" times look fresh.
- Stories that describe the same incident share an incidentId, and their status follows
  the step (c) rule: 1 story = Unconfirmed, 2 = Likely, 3+ = Confirmed.
- Pictures are simple drawn cards (no real people or number plates).

- Bridge stories are snapped onto the REAL bridge road from OpenStreetMap when you run this,
  so their dots sit on the bridge (not in the sea) at every zoom level.
- Non-bridge stories carry an areaName (e.g. "Gurney, George Town") for the Stories list.

Run in Cloud Shell (Firestore writes stay inside the free daily quota; no credits used):
    python3 -m venv ~/seedenv && ~/seedenv/bin/pip install -q google-cloud-firestore
    ~/seedenv/bin/python ~/jomisu/api/seed_demo.py
"""
import base64
import json
import math
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone

from google.cloud import firestore

PROJECT_ID = "jomisu"
NEVER = datetime(2099, 1, 1, tzinfo=timezone.utc)  # demo stories never expire
LEVELS = {1: "Unconfirmed", 2: "Likely"}  # 3 or more = Confirmed

# Background colour of each drawn card, by category.
CARD_COLOUR = {
    "Accident": "#c62828",
    "Vehicle Breakdowns": "#ef6c00",
    "Events": "#6a1b9a",
}

# Second Bridge points were computed from the real OSM line (KM 0 = island end).
# Gurney points are inside the 1 km Gurney search area.
STORIES = [
    # ---- Second Bridge, KM 6: one accident, 3 posts -> Confirmed (red) ----
    {
        "id": "demo-sb-km6-a", "incident": "demo-inc-sb-km6", "mins_ago": 18,
        "category": "Accident", "severity": "high", "author": "Aisyah (Demo)",
        "lat": 5.26065, "lng": 100.33984, "emoji": "🚗💥🚙", "title": "2-car crash, KM 6",
        "caption": "Two cars crashed at KM 6 towards Batu Kawan, right lane blocked.",
        "summary": "Two cars collided on the bridge, blocking the right lane towards the mainland.",
        "place": "Second Bridge KM 6, towards Batu Kawan",
    },
    {
        "id": "demo-sb-km6-b", "incident": "demo-inc-sb-km6", "mins_ago": 14,
        "category": "Accident", "severity": "high", "author": "Ravi (Demo)",
        "lat": 5.26036, "lng": 100.34022, "emoji": "🚓🚗💥", "title": "Police at KM 6",
        "caption": "Police just arrived. Traffic crawling, avoid if you can!",
        "summary": "Police vehicles attending a crash scene; traffic moving very slowly.",
        "place": "Second Bridge KM 6",
    },
    {
        # Category differs on purpose: Gemini still groups it with the crash.
        "id": "demo-sb-km6-c", "incident": "demo-inc-sb-km6", "mins_ago": 9,
        "category": "Blocked Lane", "severity": "medium", "author": "Mei Ling (Demo)",
        "lat": 5.26082, "lng": 100.33942, "emoji": "🚧🚗🚗🚗", "title": "Lane closed at KM 6",
        "caption": "Stuck behind the accident, only one lane open.",
        "summary": "Long queue of cars with one lane closed ahead because of a crash.",
        "place": "Second Bridge near KM 6",
    },
    # ---- Second Bridge, KM 9: separate breakdown, 1 post -> Unconfirmed (yellow) ----
    {
        "id": "demo-sb-km9", "incident": "demo-inc-sb-km9", "mins_ago": 25,
        "category": "Vehicle Breakdowns", "severity": "low", "author": "Daniel (Demo)",
        "lat": 5.25174, "lng": 100.3654, "emoji": "🚛⚠️", "title": "Lorry broke down, KM 9",
        "caption": "Lorry broke down on the left shoulder at KM 9.",
        "summary": "A lorry stopped on the left shoulder with hazard lights on.",
        "place": "Second Bridge KM 9, left shoulder",
    },
    # ---- Gurney: mall event, 1 post -> Unconfirmed (yellow) ----
    {
        "id": "demo-gurney-event", "incident": "demo-inc-gurney-event", "mins_ago": 40,
        "category": "Events", "severity": "low", "author": "Sarah (Demo)",
        "lat": 5.43710, "lng": 100.30930, "emoji": "🎤🎉👥", "title": "Concert at Gurney Plaza",
        "caption": "Big crowd for a concert at Gurney Plaza, carpark almost full.",
        "summary": "A large crowd gathered for a stage event at a shopping mall.",
        "place": "Gurney Plaza", "area": "Gurney, George Town",
    },
    # ---- Gurney: accident on Gurney Drive, 2 posts -> Likely (orange) ----
    {
        "id": "demo-gurney-crash-a", "incident": "demo-inc-gurney-crash", "mins_ago": 12,
        "category": "Accident", "severity": "medium", "author": "Hafiz (Demo)",
        "lat": 5.43910, "lng": 100.31180, "emoji": "🚗💥🛵", "title": "Crash on Gurney Drive",
        "caption": "Car and motorbike accident in front of the hotel on Gurney Drive.",
        "summary": "A car and a motorcycle collided on a seafront road; one lane blocked.",
        "place": "Gurney Drive, in front of the hotel", "area": "Gurney Drive, George Town",
    },
    {
        "id": "demo-gurney-crash-b", "incident": "demo-inc-gurney-crash", "mins_ago": 6,
        "category": "Blocked Lane", "severity": "medium", "author": "Jason (Demo)",
        "lat": 5.43930, "lng": 100.31210, "emoji": "🚧🚗🚗", "title": "Jam on Gurney Drive",
        "caption": "Very heavy jam, there's an accident ahead near the hotel.",
        "summary": "Heavy traffic queue caused by an accident further ahead.",
        "place": "Gurney Drive", "area": "Gurney Drive, George Town",
    },
]

# ---- Snap bridge stories onto the real bridge road (OpenStreetMap) ----
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
SECOND_BRIDGE_QUERY = (
    '[out:json][timeout:60];('
    'way["bridge"]["name"~"Sultan Abdul Halim|Second Penang Bridge|Penang Second Bridge|Kedua",i]'
    '(5.20,100.27,5.31,100.45););out geom;'
)
MAX_SNAP_M = 600  # only move a story if the bridge road is this close (safety check)


def fetch_bridge_ways(query):
    """Every bridge road (list of (lat, lng) points) from OpenStreetMap; [] if all servers busy."""
    body = urllib.parse.urlencode({"data": query}).encode()
    headers = {"User-Agent": "Jomisu/0.1 (https://github.com/chimee-lee/jomisu)"}
    for url in OVERPASS_URLS:  # move on to the next server if one is busy
        try:
            req = urllib.request.Request(url, data=body, headers=headers)
            with urllib.request.urlopen(req, timeout=45) as resp:
                data = json.load(resp)
            return [[(p["lat"], p["lon"]) for p in el["geometry"]]
                    for el in data["elements"] if el.get("geometry")]
        except Exception as err:
            print(f"  {url.split('/')[2]} busy ({err}); trying next server...")
    return []


def snap_to_ways(lat, lng, ways):
    """Closest point on any bridge road to (lat, lng), and how far away it was (m).
    Flattens to metres around the point, then projects onto every road segment."""
    kx = 111320 * math.cos(math.radians(lat))  # metres per degree of longitude here
    ky = 110540                                 # metres per degree of latitude
    best = (float("inf"), lat, lng)
    for way in ways:
        for (alat, alng), (blat, blng) in zip(way, way[1:]):
            ax, ay = (alng - lng) * kx, (alat - lat) * ky
            bx, by = (blng - lng) * kx, (blat - lat) * ky
            dx, dy = bx - ax, by - ay
            seg2 = dx * dx + dy * dy
            # t = how far along this segment the closest point is (0 = start, 1 = end)
            t = 0.0 if seg2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / seg2))
            x, y = ax + t * dx, ay + t * dy
            d = math.hypot(x, y)
            if d < best[0]:
                best = (d, lat + y / ky, lng + x / kx)
    return best


def card_image(emoji, title, colour):
    """A small drawn picture (SVG) as a data URL, used as the story photo."""
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="{colour}"/><stop offset="1" stop-color="#1f2937"/></linearGradient></defs>
<rect width="600" height="600" fill="url(#g)"/>
<text x="300" y="300" font-size="150" text-anchor="middle" dominant-baseline="middle">{emoji}</text>
<text x="300" y="470" font-size="40" fill="#fff" text-anchor="middle" font-family="sans-serif"
 font-weight="bold">{title}</text>
<rect x="20" y="20" width="130" height="50" rx="12" fill="#fff" opacity=".9"/>
<text x="85" y="55" font-size="28" text-anchor="middle" font-family="sans-serif"
 font-weight="bold" fill="#111">DEMO</text></svg>"""
    return "data:image/svg+xml;base64," + base64.b64encode(svg.encode("utf-8")).decode()


def main():
    db = firestore.Client(project=PROJECT_ID)
    now = datetime.now(timezone.utc)
    size = Counter(s["incident"] for s in STORIES)  # posts per incident

    print("Fetching the real Second Bridge road from OpenStreetMap...")
    ways = fetch_bridge_ways(SECOND_BRIDGE_QUERY)
    if ways:
        print(f"  got {len(ways)} road pieces\n")
    else:
        print("  !! Could not fetch. Stories keep their old spots. Wait 2 min and re-run.\n")

    batch = db.batch()  # write all stories in one go
    for s in STORIES:
        level = LEVELS.get(size[s["incident"]], "Confirmed")
        if ways and s["id"].startswith("demo-sb-"):
            moved, lat, lng = snap_to_ways(s["lat"], s["lng"], ways)
            if moved <= MAX_SNAP_M:
                s["lat"], s["lng"] = round(lat, 6), round(lng, 6)
                print(f"  snapped {s['id']} onto the bridge (moved {moved:.0f} m)")
        batch.set(db.collection("stories").document(s["id"]), {
            "uid": "demo",
            "authorName": s["author"],
            "category": s["category"],
            "userCategory": s["category"],
            "aiCategory": s["category"],
            "categoryChoice": "agreed",
            "mediaType": "image",
            "ai": {
                "otherLabel": None,
                "summary": s["summary"],
                "severity": s["severity"],
                "confidence": 0.9,
                "sensitiveContent": False,
                "containsFacesOrPlates": False,
                "language": "en",
                "placeDetail": s["place"],
            },
            "caption": s["caption"],
            "lat": s["lat"],
            "lng": s["lng"],
            "approximate": False,
            "areaName": s.get("area"),  # shown in the Stories list (bridges get "KM" labels instead)
            "imageData": card_image(s["emoji"], s["title"], CARD_COLOUR.get(s["category"], "#455a64")),
            "status": level,
            "incidentId": s["incident"],
            "demo": True,
            "createdAt": now - timedelta(minutes=s["mins_ago"]),
            "expiresAt": NEVER,
        })
        print(f"{s['id']:<22} {s['category']:<19} {level}")
    batch.commit()
    print(f"\nDone: {len(STORIES)} demo stories saved.")


if __name__ == "__main__":
    main()
