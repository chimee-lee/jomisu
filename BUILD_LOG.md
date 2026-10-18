# Jomisu Build Log

## Step 01: Setup and hello page (8 Oct 2026)
- Built: Vite + React app, Firebase project, Firebase Hosting deploy (all in Google Cloud Shell)
- Files: src/App.jsx, src/index.css, vite.config.js, firebase.json, .firebaserc
- Run locally: npm run dev -- --host --port 8080
- Deploy: npm run build, then npx firebase-tools deploy --only hosting
- Live URL: https://jomisu.web.app

## Step 02: Map and navigation (9 Oct 2026)
- Built: Leaflet + OpenStreetMap map, locate-me button with fallback errors, bottom navigation
- Files: src/App.jsx, src/index.css

## Step 03: New navigation, Google sign-in, Firestore (12 Oct 2026)
- Built: tabs Feed/Maps/Stories/Chat/Profile (Maps is home), top search bar + camera icon, Google sign-in via Firebase Auth, user profile in Firestore (users/{uid}), Ask a Place card layout, pin popup
- Files: src/firebase.js, src/App.jsx, src/index.css

## Step 04: Post photo stories (12 Oct 2026)
- Built: post form (photo, 10 categories, caption, GPS or approximate location), photo compressed to 800 px and stored in Firestore, live pins and Stories list, 24-hour expiry (expiresAt), emoji reactions saved in Firestore, current tab kept in URL hash
- Files: src/categories.js, src/media.js, src/geo.js, src/App.jsx, src/index.css
- Deploy: npm run build, then firebase deploy --only hosting

## Step 05: Gemini auto-tagging (13 Oct 2026)
- Built: "Analyse with AI" preview before posting via Firebase AI Logic (category, summary, severity, confidence, sensitive-content and faces/plates flags, language, place detail); "Use AI's" / "Keep mine" on a category mismatch; "Others" category; videos (first 5 s analysed, one still frame saved); post without AI also allowed
- Files: src/gemini.js, src/video.js, src/categories.js, src/App.jsx

## Step 06: AI tags on cards, sensitive blur (13-14 Oct 2026)
- Built: category + severity + one-line AI summary on story cards and pins; sensitive photos blurred with "tap to view"
- Files: src/App.jsx

## Step 07: Ask a Place on Cloud Run (15 Oct 2026)
- Built: Cloud Run service jomisu-api (Python/Flask, asia-southeast1) with /ask; Gemini on Vertex AI extracts the place and summarises the stories inside it, grouped into incidents (Unconfirmed / Likely / Confirmed); places = OpenStreetMap geocoding plus a safety-net list with the real lines of both Penang bridges (KM positions); map outlines and zooms to the whole place
- Files: api/main.py, api/ai.py, api/geo.py, api/bridge_points.py, src/App.jsx
- Deploy: gcloud run deploy jomisu-api --source api --region asia-southeast1 ...

## Step 08: Demo data, incidents and judge experience (15-18 Oct 2026)
- Built: labelled Penang demo stories (Second Bridge KM 6 / KM 9, Gurney) snapped onto the real bridge road; one map dot per incident with a post count and yellow/orange/red level; swipe viewer for all stories of an incident; whole photos (never cropped); tappable Stories list with place names (bridge KM or OpenStreetMap area); first-visit welcome card confirming location with a jump to the Penang demo, plus an always-visible Demo button
- Files: api/seed_demo.py, api/bridge_points.py, src/App.jsx, src/geo.js, src/bridges.js, src/StoryViewer.css
