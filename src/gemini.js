// src/gemini.js
// Gemini story analysis via Firebase AI Logic (Gemini Developer API, free tier).
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

const ai = getAI(app, { backend: new GoogleAIBackend() });
const model = getGenerativeModel(ai, {
  model: "gemini-3.8-flash",
  generationConfig: { responseMimeType: "application/json", responseSchema: schema },
});

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
 * @param frames  array of images: one photo, or frames from a video
 * @param isVideo true if the frames came from a video
 */
export async function analyseStory({ frames, isVideo, caption }) {
  const parts = [
    PROMPT,
    `Media: ${isVideo ? `${frames.length} frames from a video` : "one photo"}\nCaption: ${caption || "(none)"}`,
  ];
  for (const f of frames) parts.push({ inlineData: await toInlineData(f) });
  const result = await model.generateContent(parts);
  return JSON.parse(result.response.text());
}
