# Jomisu Build Log

## Step 01: Setup and hello page (8 Oct 2026)
- Built: Vite + React app, Firebase project, Firebase Hosting deploy (all in Google Cloud Shell)
- Files: src/App.jsx, src/index.css, vite.config.js, firebase.json, .firebaserc
- Run locally: npm run dev -- --host --port 8080
- Deploy: npm run build, then npx firebase-tools deploy --only hosting
- Live URL: https://jomisu.web.app
