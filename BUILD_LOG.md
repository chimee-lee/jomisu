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
