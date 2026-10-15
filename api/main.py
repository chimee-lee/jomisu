"""
Jomisu API (Cloud Run)
Phase 1: health check + test endpoint proving Cloud Run -> Gemini (Vertex AI) works.
Later phases add /ask (Ask a Place) and /group (same-incident detection).
"""
import os

from flask import Flask, jsonify, request
from flask_cors import CORS
from google import genai
from google.genai import types

# ---- Settings (changeable at deploy time, no code edits needed) ----
PROJECT_ID = os.environ.get("GOOGLE_CLOUD_PROJECT", "jomisu")
GEMINI_LOCATION = os.environ.get("GEMINI_LOCATION", "global")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
MAX_QUESTION_CHARS = 300  # stops very long inputs from wasting credits

# Only our own website may call this API from a browser.
ALLOWED_ORIGINS = ["https://jomisu.web.app", "https://jomisu.firebaseapp.com"]

app = Flask(__name__)
CORS(app, origins=ALLOWED_ORIGINS)

# One Gemini client, reused for every request.
# On Cloud Run it signs in automatically with the service's identity,
# so there is NO API key to store or leak.
client = genai.Client(vertexai=True, project=PROJECT_ID, location=GEMINI_LOCATION)


@app.get("/health")
def health():
    """Quick check that the service is running."""
    return jsonify(status="ok", model=GEMINI_MODEL)


@app.post("/ask-test")
def ask_test():
    """Send one question to Gemini and return its answer."""
    data = request.get_json(silent=True) or {}
    question = str(data.get("question", "")).strip()[:MAX_QUESTION_CHARS]
    if not question:
        return jsonify(error="question is required"), 400

    try:
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=question,
            config=types.GenerateContentConfig(temperature=0.2, max_output_tokens=1024),
        )
        return jsonify(answer=response.text)
    except Exception as err:  # report the problem instead of crashing
        app.logger.exception("Gemini call failed")
        return jsonify(error=str(err)), 502
