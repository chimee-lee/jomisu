// seed/seed.mjs
// Adds the Penang demo stories to Firestore. Each photo is tagged by Gemini, so every
// "AI" label on a demo pin really came from Gemini (nothing is typed in by hand).
//
// Run from ~/jomisu with GEMINI_API_KEY set (see the build log).
// Safe to run again: each demo story has a fixed id (demo-1, demo-3, ...) and is overwritten.
//
// Costs nothing:
//  - Firestore writes stay inside the free daily quota.
//  - Gemini uses an AI Studio API key on the free tier (the key must belong to a project
//    WITHOUT billing linked, otherwise Google bills the calls).
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { GoogleGenAI, Type } from "@google/genai";
import sharp from "sharp";
import { CATEGORIES as CATEGORY_LIST } from "../src/categories.js";

const SEED_DIR = fileURLToPath(new URL(".", import.meta.url));
const CATEGORIES = CATEGORY_LIST.map((c) => c.id);

// Demo stories never expire during judging (evaluation ends 6 Nov; finale 4 Dec).
const DEMO_EXPIRES = Timestamp.fromDate(new Date("2027-01-31T00:00:00+08:00"));

// Where each photo is placed, keyed by the number in its file name ("Demo 1 ...png" -> 1).
// Captions mix English and Malay to show Gemini's language detection.
const PLACES = {
  1: { name: "Penang Bridge", lat: 5.3565, lng: 100.352, caption: "Jam teruk atas jambatan, arah ke Butterworth. Km 4." },
  3: { name: "Bayan Lepas FIZ", lat: 5.299, lng: 100.273, caption: "Road closed at FIZ Phase 1, follow the detour." },
  4: { name: "Gurney Drive", lat: 5.437, lng: 100.311, caption: "Hujan lebat dan angin kuat at Gurney, drive slowly!" },
  5: { name: "Queensbay Mall", lat: 5.3335, lng: 100.3065, caption: "Huge crowd at the atrium event, parking almost full." },
  6: { name: "Komtar", lat: 5.4145, lng: 100.3295, caption: "Elderly lady needed help near Komtar, someone is calling for help." },
  7: { name: "Jelutong Expressway", lat: 5.3885, lng: 100.3205, caption: "Open burning beside Jelutong Expressway, smoke everywhere." },
  8: { name: "Batu Ferringhi", lat: 5.469, lng: 100.265, caption: "Tanah runtuh at Batu Ferringhi road, one lane blocked." },
};

// Same rules as the app (src/gemini.js), so demo tags match what users get.
const PROMPT = `You analyse one community report about something happening at a place.
The media is one photo.
Rules:
- Choose "category" from what is VISIBLE in the media only. Do not use the caption to choose it.
- If the media fits none of the listed categories, use "Others" and set "otherLabel" to a short name of what it shows (2 to 5 words). Otherwise omit otherLabel.
- "summary": one cautious sentence in English, based on what is visible. Use wording such as "reported" or "appears to be". Never state unverified facts as certain.
- Never identify, name or accuse a person.
- If unsure, use severity "unknown" and a low confidence.
- Use the caption only for "placeDetail" (only if it states a place, Km marker or lane; otherwise omit) and for "language" (the caption's language; "unknown" if there is no caption). The caption may be English, Malay, Chinese or mixed.`;

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    category: { type: Type.STRING, enum: CATEGORIES },
    otherLabel: { type: Type.STRING },
    summary: { type: Type.STRING },
    severity: { type: Type.STRING, enum: ["low", "medium", "high", "unknown"] },
    confidence: { type: Type.NUMBER },
    sensitiveContent: { type: Type.BOOLEAN },
    containsFacesOrPlates: { type: Type.BOOLEAN },
    language: { type: Type.STRING, enum: ["en", "ms", "zh", "mixed", "unknown"] },
    placeDetail: { type: Type.STRING },
  },
  required: ["category", "summary", "severity", "confidence", "sensitiveContent", "containsFacesOrPlates", "language"],
};

// Lighter model first (faster, rarely overloaded); the bigger one is the backup.
const MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ask Gemini for the tags; try each model twice before giving up.
async function tagWithGemini(ai, jpegBase64, caption) {
  let lastErr;
  for (const model of MODELS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await ai.models.generateContent({
          model,
          contents: [{
            role: "user",
            parts: [
              { text: PROMPT },
              { text: `Media: one photo\nCaption: ${caption}` },
              { inlineData: { mimeType: "image/jpeg", data: jpegBase64 } },
            ],
          }],
          config: { responseMimeType: "application/json", responseSchema: SCHEMA },
        });
        return { ...JSON.parse(res.text), model };
      } catch (err) {
        lastErr = err;
        console.warn(`  ${model} attempt ${attempt} failed: ${String(err.message).slice(0, 120)}`);
        await sleep(3000);
      }
    }
  }
  throw lastErr;
}

async function main() {
  if (!process.env.GEMINI_API_KEY) throw new Error("Set GEMINI_API_KEY first.");
  initializeApp({ credential: applicationDefault(), projectId: "jomisu" });
  const db = getFirestore();
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const files = readdirSync(SEED_DIR).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
  for (const file of files) {
    const n = Number(file.match(/demo\s*(\d+)/i)?.[1]);
    const place = PLACES[n];
    if (!place) { console.log(`Skipping ${file} (no place set for number ${n})`); continue; }

    // Same treatment as the app: max 800 px wide, JPEG quality 70 (also strips metadata).
    const jpeg = await sharp(SEED_DIR + file).resize({ width: 800, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
    const base64 = jpeg.toString("base64");

    console.log(`Tagging ${file} (${place.name}) ...`);
    const tag = await tagWithGemini(ai, base64, place.caption);

    await db.collection("stories").doc(`demo-${n}`).set({
      uid: "demo",
      authorName: "Jomisu Demo",
      demo: true, // the app shows a "Demo" badge for these
      category: tag.category,
      userCategory: tag.category,
      aiCategory: tag.category,
      categoryChoice: "demo",
      mediaType: "image",
      ai: {
        otherLabel: tag.otherLabel ?? null,
        summary: tag.summary,
        severity: tag.severity,
        confidence: tag.confidence,
        sensitiveContent: tag.sensitiveContent,
        containsFacesOrPlates: tag.containsFacesOrPlates,
        language: tag.language,
        placeDetail: tag.placeDetail ?? null,
        model: tag.model, // which Gemini model produced these tags
      },
      caption: place.caption,
      placeName: place.name,
      lat: place.lat,
      lng: place.lng,
      approximate: false,
      imageData: "data:image/jpeg;base64," + base64,
      status: "Unconfirmed",
      createdAt: Timestamp.now(),
      expiresAt: DEMO_EXPIRES,
    });
    console.log(`  saved demo-${n}: ${tag.category} / ${tag.severity} / "${tag.summary}"`);
  }
  console.log("Done.");
}

main().catch((err) => { console.error("Seed failed:", err.message); process.exit(1); });