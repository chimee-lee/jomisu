# Jomisu: what's happening here, right now?

Jomisu ("what is happening?" in Hokkien) is a real-time, location-based app for the Google Cloud AI Builder Cup 2026. People post 24-hour photo stories about what they see, and the app shows them on a map so others can understand a place before they go.

Live prototype: https://jomisu.web.app

## What works today
- Map-first home screen, opening at the user's own location (Leaflet + OpenStreetMap)
- Google sign-in (Firebase Authentication); browsing needs no account
- Post a photo story: 10 categories, caption, exact or approximate location
- Photos compressed to 800 px in the browser; stories expire after 24 hours
- Live pins, story cards and emoji reactions stored in Firestore
- Gemini auto-tagging and "Ask a Place": in progress (see BUILD_LOG.md)

## Tech stack (all Google Cloud / Firebase)
- Firebase Hosting (deployment), Firebase Authentication, Cloud Firestore
- Gemini through Firebase AI Logic (in progress)
- React + Vite front end, Leaflet map

## Run locally
    npm install
    npm run dev

Deploy: npm run build, then firebase deploy --only hosting.
Firestore security rules: see firestore.rules.

## Notes
- Demo uses staged photos only. Do not upload real people or number plates.
- No API secrets are stored in this repo; the Firebase web config is public by design.
- Build history: BUILD_LOG.md