// src/gemini.js
// Gemini story analysis, in two layers so posting keeps working when one AI service is busy:
//   1. Cloud Run /analyse -> Gemini on Vertex AI (paid quota from the project; most reliable)
//   2. Backup: Firebase AI Logic (Gemini Developer API, free tier, which gets busy at peak times)
// Each layer tries the main model first, then a lighter model.
import { CATEGORIES as CATEGORY_LIST } from "./categories";
import { getAI, getGenerativeModel, GoogleAIBackend, Schema } from "firebase/ai";
import { app } from "./firebase";

// Category names come from categories.js so they always match the post form.
export const CATEGORIES = CATEGORY_LIST.map((c) => c.id);

// Schema = the exact JSON shape Gemini must return.
// In Firebase AI Logic every field is required unless listed in optionalProperties.
const schema = Schema.object({
  properties: {
    category: Schema.enumString({ enum: CATEGORIES }),
    otherLabel: Schema.string(), // only when category is "Others": what the media shows
    summary: Schema.string(), // one cautious sentence
    severity: Schema.enumString({ enum: ["low", "medium", "high", "unknown"] }),
    confidence: Schema.number(), // 0 to 1
    sensitiveContent: Schema.boolean(), // graphic/disturbing -> blur + warning later
    containsFacesOrPlates: Schema.boolean(), // used by the later blur step
    language: Schema.enumString({ enum: ["en", "ms", "zh", "mixed", "unknown"] }), // language of the caption
    placeDetail: Schema.string(), // e.g. "Km 7, left lane"
  },
  optionalProperties: ["otherLabel", "placeDetail"],
});

// ---------- Models ----------
const PRIMARY_MODEL = "gemini-3.8-flash"; // best quality
const FALLBACK_MODEL = "gemini-3.5-flash-lite"; // lighter, used when the primary is busy or slow
const PRIMARY_TIMEOUT_MS = 20000; // a healthy reply takes seconds; 20 s means it's overloaded
const FALLBACK_TIMEOUT_MS = 30000;

// Cloud Run backend (same service as Ask a Place).
const API_URL = "https://jomisu-api-236629246156.asia-southeast1.run.app";
const CLOUD_RUN_TIMEOUT_MS = 45000; // covers a cold start plus a busy main model

const ai = getAI(app, { backend: new GoogleAIBackend() });

function makeModel(name, lowThinking, timeoutMs) {
  return getGenerativeModel(
    ai,
    {
      model: name,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: schema,
        // Low thinking: much faster for a simple photo-classification job.
        ...(lowThinking ? { thinkingConfig: { thinkingLevel: "LOW" } } : {}),
      },
    },
    { timeout: timeoutMs }
  );
}

const primary = makeModel(PRIMARY_MODEL, true, PRIMARY_TIMEOUT_MS);
const fallback = makeModel(FALLBACK_MODEL, false, FALLBACK_TIMEOUT_MS);

// Retry plan: primary first, then the fallback after a short pause.
// Testing aid: open the app with ?ailite in the URL to go straight to the fallback model.
function retryPlan() {
  const forceLite = typeof location !== "undefined" && new URLSearchParams(location.search).has("ailite");
  if (forceLite) return [{ model: fallback, waitMs: 0 }];
  return [
    { model: primary, waitMs: 0 },
    { model: fallback, waitMs: 1000, status: "AI is busy, trying a lighter AI model…" },
  ];
}

// Temporary server-side problems worth trying another model for: overload, rate limit, timeout.
const isTimeout = (err) => /abort|timed? ?out/i.test(String(err?.message || err));
function isRetryable(err) {
  const msg = String(err?.message || err);
  return isTimeout(err) || /high demand|overloaded|unavailable|resource.?exhausted|\[(429|500|503)\b/i.test(msg);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROMPT = `You analyse one community report about something happening at a place.
The media is either one photo, or several frames sampled in order from the first 5 seconds of a short video.
Rules:
- Choose "category" from what is VISIBLE in the media only. Do not use the caption to choose it.
- If the media fits none of the listed categories, use "Others" and set "otherLabel" to a short name of what it shows (2 to 5 words). Otherwise omit otherLabel.
- "summary": one cautious sentence in English, based on what is visible. Use wording such as "reported" or "appears to be". Never state unverified facts as certain.
- Never identify, name or accuse a person.
- If unsure, use severity "unknown" and a low confidence.
- Use the caption only for "placeDetail" (only if it states a place, Km marker or lane; otherwise omit) and for "language" (the caption's language; "unknown" if there is no caption). The caption may be English, Malay, Chinese or mixed.`;

// Accepts a data-URL string (what compressImage and video frames give) or a Blob.
async function toInlineData(img) {
  if (typeof img === "string") {
    const [meta, data] = img.split(",");
    const mimeType = meta.match(/data:(.*?);/)?.[1] || "image/jpeg";
    return { data, mimeType };
  }
  const bytes = new Uint8Array(await img.arrayBuffer());
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return { data: btoa(binary), mimeType: img.type || "image/jpeg" };
}

/**
 * Analyse a story before posting.
 * @param frames   array of images: one photo, or frames from a video
 * @param isVideo  true if the frames came from a video
 * @param caption  the user's caption (optional)
 * @param onStatus optional callback that shows retry progress text in the UI
 */
export async function analyseStory({ frames, isVideo, caption, onStatus }) {
  // Layer 1: Cloud Run + Vertex AI.
  try {
    return await analyseViaCloudRun({ frames, isVideo, caption });
  } catch (err) {
    console.warn("Cloud Run analysis failed, using the backup AI:", err?.message);
    onStatus?.("Trying the backup AI…");
  }
  // Layer 2: Firebase AI Logic (below).
  return analyseViaFirebase({ frames, isVideo, caption, onStatus });
}

// Images as data-URL strings (what compressImage and video frames give).
async function toDataUrl(img) {
  if (typeof img === "string") return img;
  const { data, mimeType } = await toInlineData(img);
  return `data:${mimeType};base64,${data}`;
}

// Layer 1: POST the frames to Cloud Run; it calls Gemini on Vertex AI with the same JSON schema.
async function analyseViaCloudRun({ frames, isVideo, caption }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLOUD_RUN_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_URL}/analyse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frames: await Promise.all(frames.map(toDataUrl)), isVideo, caption: caption || "" }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || `Server error ${res.status}`);
    console.info("Gemini (Vertex AI via Cloud Run) analysed the story");
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// Layer 2: Firebase AI Logic, straight from the browser.
async function analyseViaFirebase({ frames, isVideo, caption, onStatus }) {
  const parts = [
    PROMPT,
    `Media: ${isVideo ? `${frames.length} frames from a video` : "one photo"}\nCaption: ${caption || "(none)"}`,
  ];
  for (const f of frames) parts.push({ inlineData: await toInlineData(f) });

  let lastErr;
  for (const step of retryPlan()) {
    if (step.waitMs) {
      onStatus?.(step.status);
      await sleep(step.waitMs);
    }
    try {
      const t0 = Date.now();
      const result = await step.model.generateContent(parts);
      console.info(`Gemini replied in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      onStatus?.("");
      return JSON.parse(result.response.text());
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) throw err; // a real error (bad input, auth): don't retry
      console.warn("Gemini busy or slow, moving to next attempt:", err?.message);
    }
  }
  onStatus?.("");
  // Short, readable message instead of the raw URL error.
  throw new Error(
    isTimeout(lastErr)
      ? "The AI is responding slowly right now. Please retry in a minute"
      : "The AI service is busy right now. Please retry in a minute"
  );
}