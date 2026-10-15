"""
Jomisu API (Cloud Run)
  GET  /health  - service check
  POST /ask     - Ask a Place: {question, lat?, lng?} -> Gemini summary of stories at that place
"""
from datetime import datetime, timezone

from flask import Flask, jsonify, request
from flask_cors import CORS
from google.cloud import firestore
from google.cloud.firestore_v1.base_query import FieldFilter

import ai
import geo

MAX_QUESTION_CHARS = 300
MAX_STORIES_SCANNED = 200   # newest active stories checked per question
MAX_STORIES_TO_GEMINI = 40  # keeps each Gemini call small and cheap
ALLOWED_ORIGINS = ["https://jomisu.web.app", "https://jomisu.firebaseapp.com"]

app = Flask(__name__)
CORS(app, origins=ALLOWED_ORIGINS)
db = firestore.Client(project=ai.PROJECT_ID)


@app.get("/health")
def health():
    return jsonify(status="ok", model=ai.GEMINI_MODEL)


@app.post("/ask")
def ask():
    data = request.get_json(silent=True) or {}
    question = str(data.get("question", "")).strip()[:MAX_QUESTION_CHARS]
    if not question:
        return jsonify(error="question_required"), 400
    user_pos = _read_position(data)

    try:
        intent = ai.extract_place(question)
        if intent.near_me and not user_pos:
            return jsonify(error="location_needed",
                           message="Turn on location to ask about places near you."), 400

        place = geo.resolve_place(question, intent.place_query, intent.near_me, user_pos)
        if place is None:
            return jsonify(error="place_not_found",
                           message="Couldn't find that place. Try a landmark or town name."), 404

        stories = _stories_in_place(place)
        if not stories:  # nothing to summarise -> skip Gemini, save credits
            return jsonify(place=_public_place(place), incidents=[], storyIds=[],
                           summary=f"No Jomisu stories at {place['name']} in the last 24 hours.")

        answer = ai.summarise(question, place["name"], stories)
        return jsonify(
            place=_public_place(place),
            summary=answer.summary,
            incidents=[i.model_dump() for i in answer.incidents],
            storyIds=[s["id"] for s in stories],
        )
    except Exception as err:
        app.logger.exception("Ask a Place failed")
        return jsonify(error="ask_failed", message=str(err)), 502


def _read_position(data):
    """Optional user GPS position from the request, as (lat, lng)."""
    try:
        return float(data["lat"]), float(data["lng"])
    except (KeyError, TypeError, ValueError):
        return None


def _stories_in_place(place):
    """Active (not expired) stories inside the place, as compact text for Gemini."""
    now = datetime.now(timezone.utc)
    query = (
        db.collection("stories")
        .where(filter=FieldFilter("expiresAt", ">", now))
        .order_by("expiresAt", direction=firestore.Query.DESCENDING)
        .select(["category", "caption", "ai", "lat", "lng", "createdAt"])  # skip the photo data
        .limit(MAX_STORIES_SCANNED)
    )
    found = []
    for doc in query.stream():
        s = doc.to_dict()
        if s.get("lat") is None or s.get("lng") is None:
            continue
        inside, km = geo.place_contains(place, s["lat"], s["lng"])
        if not inside:
            continue
        created = s.get("createdAt") or now
        ai_info = s.get("ai") or {}
        found.append({
            "id": doc.id,
            "minutes_ago": max(0, int((now - created).total_seconds() // 60)),
            "category": s.get("category"),
            "caption": s.get("caption") or "",
            "ai_summary": ai_info.get("summary"),
            "severity": ai_info.get("severity"),
            "place_detail": ai_info.get("placeDetail"),
            "km": km,
        })
    found.sort(key=lambda x: x["minutes_ago"])
    return found[:MAX_STORIES_TO_GEMINI]


def _public_place(place):
    """Place info the app can use to highlight the area on the map."""
    keys = ("name", "kind", "center", "radius_m", "points", "corridor_m", "source")
    return {k: place[k] for k in keys if k in place}