import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import {
  addDoc, arrayRemove, arrayUnion, collection, doc, getDoc, limit, onSnapshot, orderBy,
  query, serverTimestamp, setDoc, Timestamp, where,
} from "firebase/firestore";
import { auth, db, googleProvider } from "./firebase";
import { CATEGORIES, iconFor } from "./categories";
import { compressImage } from "./media";
import { analyseStory } from "./gemini";
import { extractVideoFrames } from "./video";
import { bridgeLabel, cachedArea, distanceKm, formatKm, lookupArea, roundCoord, timeAgo } from "./geo";
import "./StoryViewer.css";

const DEFAULT_CENTER = [5.39, 100.33]; // used only until the user's GPS is found
const PENANG_BRIDGE = [5.3565, 100.352];

// Cloud Run backend (api/ folder). Ask a Place questions go here; Gemini runs on Vertex AI.
const API_URL = "https://jomisu-api-236629246156.asia-southeast1.run.app";

// Confirmation levels: yellow -> orange -> red as more stories report the same incident.
// Used for map dots, story badges and Ask a Place incidents.
const CONFIDENCE_COLOR = { Unconfirmed: "#eab308", Likely: "#f97316", Confirmed: "#dc2626" };
const STATUS_COLOR = CONFIDENCE_COLOR;

// ---------- Incidents: one map dot per incident ----------
// Stories with the same incidentId are one incident (set by Gemini grouping / the demo seed).
// Stories without one fall back to a simple rule: within 300 m and 3 hours of each other.
const FALLBACK_RADIUS_KM = 0.3;
const FALLBACK_WINDOW_MS = 3 * 60 * 60 * 1000;

// Level from the number of posts: 1 = Unconfirmed, 2 = Likely, 3+ = Confirmed.
const levelFor = (count) => (count >= 3 ? "Confirmed" : count === 2 ? "Likely" : "Unconfirmed");

// stories (newest first) -> [{ id, stories (newest first), lat, lng, level }]
function groupIncidents(stories) {
  const groups = [];
  const byIncident = {};
  for (const s of stories) {
    let g = s.incidentId ? byIncident[s.incidentId] : null;
    if (!g && !s.incidentId) {
      // Fallback: join a nearby, recent group that has no incidentId either.
      g = groups.find(
        (x) => !x.incidentId
          && distanceKm(x, s) <= FALLBACK_RADIUS_KM
          && x.stories[0].createdMs - s.createdMs <= FALLBACK_WINDOW_MS
      );
    }
    if (!g) {
      // First (= newest) story of the group: the dot sits at its spot.
      g = { id: s.incidentId || s.id, incidentId: s.incidentId || null, stories: [], lat: s.lat, lng: s.lng };
      groups.push(g);
      if (s.incidentId) byIncident[s.incidentId] = g;
    }
    g.stories.push(s);
  }
  groups.forEach((g) => { g.level = levelFor(g.stories.length); });
  return groups;
}

// Round map dot with the number of posts inside (blank for a single post).
function incidentIcon(group) {
  const n = group.stories.length;
  return L.divIcon({
    className: "", // drop Leaflet's default white square
    html: `<div class="inc-dot" style="background:${CONFIDENCE_COLOR[group.level]}">${n > 1 ? n : ""}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15], // centre of the dot sits exactly on the story's spot
  });
}

// ---------- Helpers ----------
// First emoji typed on the phone's native emoji keyboard, or null.
const EMOJI_RE = /^(\p{Extended_Pictographic}|\p{Regional_Indicator})/u;
function firstEmoji(text) {
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const { segment } of seg.segment(text)) return EMOJI_RE.test(segment) ? segment : null;
  return null;
}

// Create the user's Firestore profile on first sign-in; return it.
async function ensureUserDoc(user) {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return snap.data();
  const profile = {
    displayName: user.displayName || "Jomisu user",
    photoURL: user.photoURL || "",
    createdAt: serverTimestamp(),
  };
  await setDoc(ref, profile);
  return profile;
}

// ---------- Map screen ----------
function MapScreen({ active, stories, incidents, onPinTap, onLocated, focus }) {
  const mapDiv = useRef(null);
  const mapRef = useRef(null);
  const meRef = useRef(null);
  const pinsRef = useRef(null);
  const focusShapeRef = useRef(null); // outline of the place being asked about
  const fittedRef = useRef(null); // the focus we already zoomed to (zoom once per question)
  const [status, setStatus] = useState("Finding your location...");
  const [me, setMe] = useState(null);

  // Locate the user: fast/approximate first, then precise.
  function locateMe() {
    if (!navigator.geolocation) return setStatus("Location is not supported on this browser");
    setStatus("Finding you...");
    const onSuccess = (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      const map = mapRef.current;
      if (meRef.current) meRef.current.remove();
      meRef.current = L.circleMarker([latitude, longitude], {
        radius: 9, color: "#fff", weight: 3, fillColor: "#1e88e5", fillOpacity: 1,
      }).addTo(map);
      map.setView([latitude, longitude], 15);
      setMe({ lat: latitude, lng: longitude });
      onLocated({ lat: latitude, lng: longitude });
      setStatus(`You are here (accuracy about ${Math.round(accuracy)} m)`);
    };
    const onFail = (err) => {
      if (err.code === 1) setStatus("Location blocked. Tap aA > Website Settings > Location > Allow.");
      else if (err.code === 2) setStatus("Location unavailable. Check Location Services is on.");
      else setStatus("Location timed out. Tap 📍 to try again.");
    };
    navigator.geolocation.getCurrentPosition(
      onSuccess,
      (err) => {
        if (err.code === 1) return onFail(err);
        navigator.geolocation.getCurrentPosition(onSuccess, onFail, {
          enableHighAccuracy: true, timeout: 20000, maximumAge: 0,
        });
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
    );
  }

  // Create the map once, then open it at the user's own location.
  useEffect(() => {
    if (mapRef.current) return;
    const map = L.map(mapDiv.current, { zoomControl: false }).setView(DEFAULT_CENTER, 12);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
    pinsRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    locateMe();
  }, []); // eslint-disable-line

  // Redraw one dot per incident whenever the live story list changes.
  useEffect(() => {
    if (!pinsRef.current) return;
    pinsRef.current.clearLayers();
    incidents.forEach((g) => {
      L.marker([g.lat, g.lng], { icon: incidentIcon(g), zIndexOffset: g.stories.length * 100 })
        .on("click", () => onPinTap(g))
        .addTo(pinsRef.current);
    });
  }, [incidents, onPinTap]);

  // Leaflet needs a size refresh whenever the map tab becomes visible again.
  useEffect(() => {
    if (active && mapRef.current) setTimeout(() => mapRef.current.invalidateSize(), 100);
  }, [active]);

  // Ask a Place: outline the place (circle for areas, line for bridges) and zoom to show all of it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (focusShapeRef.current) {
      focusShapeRef.current.remove();
      focusShapeRef.current = null;
    }
    if (!focus) {
      fittedRef.current = null;
      return;
    }
    const style = { color: "#1e88e5", dashArray: "8 6", fillOpacity: 0.06 };
    const shape =
      focus.kind === "route"
        ? L.polyline(focus.points, { ...style, weight: 8, opacity: 0.5 })
        : L.circle(focus.center, { ...style, weight: 3, radius: focus.radius_m });
    shape.addTo(map);
    shape.bringToBack(); // keep story pins clickable on top of the outline
    focusShapeRef.current = shape;

    // Zoom only while the map is visible (a hidden map has no size), and only once per question.
    if (active && fittedRef.current !== focus) {
      fittedRef.current = focus;
      setTimeout(() => {
        map.invalidateSize();
        map.fitBounds(shape.getBounds(), { padding: [40, 40] });
      }, 150);
    }
  }, [focus, active]);

  const noneNearby = me && !stories.some((s) => distanceKm(me, s) <= 5);

  return (
    <div className="map-screen">
      <div ref={mapDiv} className="map" />
      {noneNearby && (
        <div className="banner">
          No stories nearby.{" "}
          <button onClick={() => mapRef.current.setView([5.38, 100.3], 11)}>
            View Penang demo stories
          </button>
        </div>
      )}
      <div className="status">{status}</div>
      <button className="locate" onClick={locateMe} aria-label="Show my location">📍</button>
    </div>
  );
}

// ---------- Reactions (saved in Firestore: stories/{id}.reactions = { emoji: [uids] }) ----------
const PRESETS = ["👍", "🔥", "😮", "🚨"];

function ReactionBar({ story, user, onNeedSignIn }) {
  const [adding, setAdding] = useState(false);
  const reactions = story.reactions || {};
  // Always show the 4 presets, plus any custom emoji people have added.
  const emojis = [...new Set([...PRESETS, ...Object.keys(reactions)])];

  // Add or remove this user's reaction. arrayUnion/arrayRemove avoid overwriting others' reactions.
  async function toggle(e) {
    if (!user) return onNeedSignIn();
    const has = (reactions[e] || []).includes(user.uid);
    try {
      await setDoc(
        doc(db, "stories", story.id),
        { reactions: { [e]: has ? arrayRemove(user.uid) : arrayUnion(user.uid) } },
        { merge: true }
      );
    } catch (err) {
      alert("Reaction failed: " + (err.code || err.message));
    }
  }

  // Custom emoji typed on the phone's native emoji keyboard.
  function onType(ev) {
    const e = firstEmoji(ev.target.value);
    ev.target.value = "";
    if (e) {
      setAdding(false);
      toggle(e);
    }
  }

  return (
    <div className="reactions">
      {emojis.map((e) => {
        const list = reactions[e] || [];
        const mine = user && list.includes(user.uid);
        return (
          <button key={e} className={mine ? "chip on" : "chip"} onClick={() => toggle(e)}>
            {e} {list.length}
          </button>
        );
      })}
      {adding ? (
        <input className="emoji-input" autoFocus placeholder="Use 😀 keyboard" onChange={onType} onBlur={() => setAdding(false)} />
      ) : (
        <button className="chip" onClick={() => setAdding(true)}>＋</button>
      )}
    </div>
  );
}

// ---------- Story pieces ----------
// Confirmation level badge, coloured like the map dot. Demo stories get an extra "Demo" tag.
function Badge({ status, demo }) {
  return (
    <>
      <span className="badge" style={{ background: STATUS_COLOR[status] || "#6b7280", color: "#fff" }}>
        {status || "Unconfirmed"}
      </span>
      {demo && <span className="badge" style={{ marginLeft: 4 }}>🧪 Demo</span>}
    </>
  );
}

// Severity colours for the small pill on cards.
const SEVERITY_COLOR = { low: "#2e7d32", medium: "#ef6c00", high: "#c62828", unknown: "#6b7280" };

function SeverityPill({ severity }) {
  return (
    <span
      style={{
        background: SEVERITY_COLOR[severity] || SEVERITY_COLOR.unknown, color: "#fff",
        borderRadius: 10, padding: "1px 8px", fontSize: 12, marginLeft: 6,
      }}
    >
      severity: {severity}
    </span>
  );
}

// "Others" stories show what the AI saw, e.g. "Others (Indoor office interior)".
const categoryLabel = (s) =>
  s.category === "Others" && s.ai?.otherLabel ? `Others (${s.ai.otherLabel})` : s.category;

// Story photo. Sensitive photos are blurred until tapped; video stories get a badge.
function StoryImage({ story, big }) {
  const [revealed, setRevealed] = useState(false);
  const hidden = !!story.ai?.sensitiveContent && !revealed;
  // Big (story viewer): show the WHOLE photo, scaled to fit, never cropped ("contain").
  const bigBox = big ? { height: "auto" } : {};
  const bigImg = big ? { width: "100%", height: "auto", maxHeight: "50vh", objectFit: "contain", display: "block" } : {};
  const blur = hidden ? { filter: "blur(22px)", transform: "scale(1.2)" } : {};
  return (
    <div
      className={big ? "thumb big" : "thumb"}
      style={{ position: "relative", overflow: "hidden", cursor: hidden ? "pointer" : "default", ...bigBox }}
      onClick={(e) => { if (hidden) { e.stopPropagation(); setRevealed(true); } }}
    >
      <img src={story.imageData} alt="" style={{ ...bigImg, ...blur }} />
      {hidden && (
        <div
          style={{
            position: "absolute", inset: 0, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.35)",
            color: "#fff", textAlign: "center", fontSize: big ? 15 : 10, padding: 4,
          }}
        >
          <span style={{ fontSize: big ? 28 : 18 }}>⚠️</span>
          Sensitive content. Tap to view
        </div>
      )}
      {story.mediaType === "video" && !hidden && (
        <span
          style={{
            position: "absolute", right: 4, bottom: 4, background: "rgba(0,0,0,.6)", color: "#fff",
            borderRadius: 6, padding: "1px 6px", fontSize: big ? 13 : 10,
          }}
        >
          ▶ video
        </span>
      )}
    </div>
  );
}

// Where a story is: "Second Bridge · KM 6", "Bayan Lepas", "Gurney, George Town"...
// Bridges are worked out on the phone; other areas come from OpenStreetMap (cached).
function usePlaceName(story) {
  const bridge = bridgeLabel(story.lat, story.lng);
  // undefined = not looked up yet; null = looked up, no name found
  const known = bridge || story.areaName || cachedArea(story.lat, story.lng);
  const [looked, setLooked] = useState(undefined);
  useEffect(() => {
    if (known !== undefined) return; // already have an answer
    let alive = true;
    lookupArea(story.lat, story.lng).then((name) => alive && setLooked(name));
    return () => { alive = false; };
  }, [story.lat, story.lng, known]);
  return known !== undefined ? known : looked;
}

// "📍 Bayan Lepas · 6.8 km away"
function PlaceLine({ story, userPos }) {
  const place = usePlaceName(story);
  const km = userPos ? distanceKm(userPos, story) : null;
  const name = place === undefined ? "Finding area..." : place;
  if (!name && km === null) return null;
  return (
    <span className="place-line">
      📍 {[name, km !== null && `${formatKm(km)} away`].filter(Boolean).join(" · ")}
    </span>
  );
}

// One story in the Stories list. Tapping it opens the story viewer (reactions still work).
function StoryCard({ story, userPos, user, onNeedSignIn, onOpen }) {
  return (
    <div className="card tappable" onClick={onOpen} role="button">
      <StoryImage story={story} />
      <div>
        <b>{iconFor(story.category)} {categoryLabel(story)}</b> <Badge status={story.status} demo={story.demo} />
        {story.ai && <SeverityPill severity={story.ai.severity} />}
        {story.ai?.summary && <p style={{ margin: "4px 0" }}>✨ {story.ai.summary}</p>}
        <p className="muted">
          {story.caption || "No caption"}<br />
          <PlaceLine story={story} userPos={userPos} /><br />
          {story.demo ? "Demo story" : timeAgo(story.createdMs)} · {story.authorName}
          {story.approximate && " · approximate location"}
        </p>
        {/* Stop taps on reactions from also opening the story */}
        <div onClick={(e) => e.stopPropagation()}>
          <ReactionBar story={story} user={user} onNeedSignIn={onNeedSignIn} />
        </div>
      </div>
    </div>
  );
}

// Full details of one story (one slide in the viewer).
function StoryDetail({ story, userPos }) {
  // The user kept their own category although the AI suggested a different one.
  const aiDisagreed = story.categoryChoice === "mine" && story.aiCategory && story.aiCategory !== story.category;
  return (
    <div className="viewer-slide">
      <StoryImage story={story} big />
      <h3>{iconFor(story.category)} {categoryLabel(story)}</h3>
      <p>
        <Badge status={story.status} demo={story.demo} />
        {story.ai && <SeverityPill severity={story.ai.severity} />}
      </p>
      {story.ai?.summary && <p>✨ {story.ai.summary}</p>}
      <p className="muted"><PlaceLine story={story} userPos={userPos} /></p>
      {story.ai?.placeDetail && <p className="muted">Place detail: {story.ai.placeDetail}</p>}
      {aiDisagreed && <p className="muted">AI suggested: {iconFor(story.aiCategory)} {story.aiCategory}</p>}
      <p>{story.caption || "No caption"}</p>
      <p className="muted">
        {story.demo ? "Demo story" : timeAgo(story.createdMs)} · {story.authorName}
        {story.approximate && " · approximate location"}
      </p>
    </div>
  );
}

// Story viewer: all stories of one incident, swipe left/right (newest first).
// Uses the browser's own scroll-snap for swiping, so it feels native on phones.
function StoryViewer({ stories, startIndex, level, userPos, onClose }) {
  const trackRef = useRef(null);
  const [index, setIndex] = useState(startIndex);
  const n = stories.length;

  // Open at the story that was tapped.
  useLayoutEffect(() => {
    const t = trackRef.current;
    if (t) t.scrollLeft = startIndex * t.clientWidth;
  }, []); // eslint-disable-line

  // Work out which slide is showing after a swipe.
  function onScroll() {
    const t = trackRef.current;
    setIndex(Math.round(t.scrollLeft / t.clientWidth));
  }
  function go(i) {
    const t = trackRef.current;
    t.scrollTo({ left: i * t.clientWidth, behavior: "smooth" });
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal tall viewer" onClick={(e) => e.stopPropagation()}>
        {n > 1 && (
          <div className="viewer-head">
            <span className="badge" style={{ background: CONFIDENCE_COLOR[level], color: "#fff" }}>
              {level} · {n} posts
            </span>
            <span className="muted">{index + 1} / {n} · swipe for more</span>
          </div>
        )}

        <div className="viewer-track" ref={trackRef} onScroll={onScroll}>
          {stories.map((s) => <StoryDetail key={s.id} story={s} userPos={userPos} />)}
        </div>

        {n > 1 && (
          <div className="viewer-nav">
            <button className="chip" disabled={index === 0} onClick={() => go(index - 1)}>‹ Newer</button>
            <span className="viewer-dots">
              {stories.map((s, i) => <i key={s.id} className={i === index ? "on" : ""} />)}
            </span>
            <button className="chip" disabled={index === n - 1} onClick={() => go(index + 1)}>Older ›</button>
          </div>
        )}
        <button className="link" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

// ---------- Post a story ----------
function PostModal({ user, profile, initialPos, onClose, onPosted }) {
  // Media: { isVideo, still, frames }. `still` is the one image we save; `frames` go to Gemini.
  const [media, setMedia] = useState(null);
  const [preview, setPreview] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [mediaError, setMediaError] = useState("");
  const [category, setCategory] = useState(""); // the user's own pick
  const [caption, setCaption] = useState("");
  const [approx, setApprox] = useState(false);
  const [pos, setPos] = useState(initialPos);
  const [geoMsg, setGeoMsg] = useState(initialPos ? "Location ready" : "Getting your location...");
  const [busy, setBusy] = useState(false);

  // Gemini analysis state
  const [ai, setAi] = useState(null);
  const [analysing, setAnalysing] = useState(false);
  const [aiError, setAiError] = useState("");
  const [choice, setChoice] = useState("mine"); // "mine" or "ai" (only matters on a mismatch)

  // Get a fresh GPS fix when the form opens (runs silently in the background).
  useEffect(() => {
    navigator.geolocation.getCurrentPosition(
      (p) => { setPos({ lat: p.coords.latitude, lng: p.coords.longitude }); setGeoMsg("Location ready"); },
      () => setGeoMsg(initialPos ? "Using your last known location" : "Location unavailable. Allow location access and reopen."),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
    );
  }, []); // eslint-disable-line

  const iconOf = (id) => CATEGORIES.find((c) => c.id === id)?.icon || "📍";
  const labelOf = (r) => `${iconOf(r.category)} ${r.category}${r.category === "Others" && r.otherLabel ? ` (${r.otherLabel})` : ""}`;

  function resetAi() {
    setAi(null);
    setAiError("");
    setChoice("mine");
  }

  // Photo: compress it. Video: sample frames from its first 5 seconds (nothing is uploaded).
  async function onPick(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    resetAi();
    setMedia(null);
    setMediaError("");
    setPreparing(true);
    try {
      if (f.type.startsWith("video/")) {
        const frames = await extractVideoFrames(f);
        setMedia({ isVideo: true, still: frames[0], frames });
        setPreview(frames[0]);
      } else {
        const still = await compressImage(f);
        setMedia({ isVideo: false, still, frames: [still] });
        setPreview(URL.createObjectURL(f));
      }
    } catch (err) {
      console.error("Could not read media:", err);
      setMediaError("Could not read this file. Please try another photo or video.");
    } finally {
      setPreparing(false);
    }
  }

  // Ask Gemini what the media shows. The user's category is NOT sent, so the AI is unbiased.
  async function analyse() {
    setAnalysing(true);
    setAiError("");
    try {
      const result = await analyseStory({ frames: media.frames, isVideo: media.isVideo, caption: caption.trim() });
      setAi(result);
      setChoice("mine");
    } catch (err) {
      console.error("Gemini analysis failed:", err);
      setAiError(err?.message || err?.code || "unknown error");
    } finally {
      setAnalysing(false);
    }
  }

  // Mismatch is computed here, so changing the category chip after analysing needs no re-analysis.
  const mismatch = !!ai && ai.category !== category;
  const finalCategory = mismatch && choice === "ai" ? ai.category : category;
  const categoryChoice = !ai ? "no-ai" : !mismatch ? "agreed" : choice;

  async function submit() {
    setBusy(true);
    try {
      const used = approx ? { lat: roundCoord(pos.lat), lng: roundCoord(pos.lng) } : pos;
      await addDoc(collection(db, "stories"), {
        uid: user.uid,
        authorName: profile?.displayName || user.displayName || "Jomisu user",
        category: finalCategory, // what pins and cards show
        userCategory: category, // what the user picked
        aiCategory: ai ? ai.category : null, // what Gemini suggested
        categoryChoice, // "agreed" | "ai" | "mine" | "no-ai"
        mediaType: media.isVideo ? "video" : "image",
        ai: ai
          ? {
              otherLabel: ai.otherLabel ?? null,
              summary: ai.summary,
              severity: ai.severity,
              confidence: ai.confidence,
              sensitiveContent: ai.sensitiveContent,
              containsFacesOrPlates: ai.containsFacesOrPlates,
              language: ai.language,
              placeDetail: ai.placeDetail ?? null,
            }
          : null,
        caption: caption.trim().slice(0, 280),
        lat: used.lat,
        lng: used.lng,
        approximate: approx,
        imageData: media.still, // one small JPEG (the photo, or the first frame of a video)
        status: "Unconfirmed", // becomes Confirmed/Conflicting once clustering is added
        createdAt: serverTimestamp(),
        expiresAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000), // 24-hour story
      });
      onPosted();
    } catch (err) {
      alert("Post failed: " + (err.code || err.message));
      setBusy(false);
    }
  }

  const ready = media && category && pos && !busy && !analysing && !preparing;

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal tall" onClick={(e) => e.stopPropagation()}>
        <h3>Post a story</h3>
        {preview && <img className="preview" src={preview} alt="preview" />}
        {media?.isVideo && <p className="muted">🎬 Video: only the first 5 seconds are used, and one still frame is saved.</p>}
        <label className="primary pick">
          {preparing ? "Reading your file..." : media ? "Change photo or video" : "📷 Take or choose a photo or video"}
          <input type="file" accept="image/*,video/*" hidden onChange={onPick} />
        </label>
        {mediaError && <p style={{ color: "#b91c1c" }}>{mediaError}</p>}

        <p className="muted">Category</p>
        <div className="cat-grid">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              className={category === c.id ? "chip sel" : "chip"}
              onClick={() => { setCategory(c.id); setChoice("mine"); }}
            >
              {c.icon} {c.id}
            </button>
          ))}
        </div>

        <textarea
          className="field" rows={2} maxLength={280} placeholder="What's happening? (optional)"
          value={caption}
          onChange={(e) => { setCaption(e.target.value); if (ai) resetAi(); }}
        />

        <label className="toggle">
          <input type="checkbox" checked={approx} onChange={(e) => setApprox(e.target.checked)} />
          Use approximate location (about 500 m)
        </label>
        {/* Location status is shown only while there is no GPS fix yet (or it failed). */}
        {!pos && <p className="muted">📍{geoMsg}</p>}

        {/* AI result card: shown after "Analyse with AI", before posting */}
        {ai && (
          <div style={{ border: "1px solid #d0d7de", borderRadius: 12, padding: 12, margin: "12px 0", background: "#f8fafc" }}>
            <b>✨ AI analysis</b>
            <p style={{ margin: "6px 0" }}>{ai.summary}</p>
            <p className="muted" style={{ margin: "4px 0" }}>
              {labelOf(ai)} · severity: {ai.severity} · confidence: {Math.round(ai.confidence * 100)}%
            </p>
            {ai.placeDetail && <p className="muted" style={{ margin: "4px 0" }}>Place detail: {ai.placeDetail}</p>}
            {ai.sensitiveContent && <p style={{ margin: "4px 0" }}>⚠️ Possibly sensitive content</p>}
            {ai.containsFacesOrPlates && (
              <p style={{ margin: "4px 0" }}>👤 Faces or number plates may be visible (automatic blur comes in a later step)</p>
            )}
            {mismatch ? (
              <>
                <p style={{ margin: "8px 0 4px" }}>
                  <b>AI suggests {labelOf(ai)}</b> instead of {iconOf(category)} {category}.
                </p>
                <button className={choice === "ai" ? "chip sel" : "chip"} onClick={() => setChoice("ai")}>Use AI's</button>{" "}
                <button className={choice === "mine" ? "chip sel" : "chip"} onClick={() => setChoice("mine")}>Keep mine</button>
              </>
            ) : (
              <p style={{ margin: "8px 0 0" }}>✓ AI agrees with your category.</p>
            )}
          </div>
        )}
        {aiError && (
          <p style={{ color: "#b91c1c" }}>AI analysis failed: {aiError}. You can retry or post without AI tags.</p>
        )}

        <p className="muted">Use staged photos or videos only. Automatic blur of faces and plates is added in a later step.</p>

        {ai ? (
          <button className="primary" disabled={!ready} onClick={submit}>{busy ? "Posting..." : "Post story"}</button>
        ) : (
          <button className="primary" disabled={!ready} onClick={analyse}>{analysing ? "Analysing..." : "✨ Analyse with AI"}</button>
        )}
        {!ai && <button className="link" disabled={!ready} onClick={submit}>{busy ? "Posting..." : "Post now without AI"}</button>}
        <button className="link" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

// ---------- Other overlays and screens ----------
function SignInModal({ onClose, onSignIn }) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Sign in to post</h3>
        <p className="muted">You can browse without an account. Signing in lets you post stories and react.</p>
        <button className="primary" onClick={onSignIn}>Sign in with Google</button>
        <button className="link" onClick={onClose}>Not now</button>
      </div>
    </div>
  );
}

// Send a question to the Cloud Run /ask endpoint. Returns { place, summary, incidents, storyIds }.
async function askPlace(question, userPos) {
  const res = await fetch(`${API_URL}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, ...(userPos || {}) }), // GPS is only used for "near me"
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `Server error ${res.status}`);
  return data;
}

function ConfidencePill({ level }) {
  return (
    <span
      style={{
        background: CONFIDENCE_COLOR[level] || "#6b7280", color: "#fff",
        borderRadius: 10, padding: "1px 8px", fontSize: 12, whiteSpace: "nowrap",
      }}
    >
      {level}
    </span>
  );
}

// Ask a Place card: Gemini summary, grouped incidents, then the matching stories.
// Mounted with a new key per question, so each question fetches exactly once.
function AskCard({ query, userPos, stories, onPlace, onOpenStory, onClose }) {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let cancelled = false; // ignore a late answer if the card was closed
    askPlace(query, userPos)
      .then((data) => {
        if (cancelled) return;
        setState({ data, at: new Date() });
        if (data.place) onPlace(data.place); // map outlines and zooms to the place
      })
      .catch((err) => !cancelled && setState({ error: err.message }));
    return () => { cancelled = true; };
  }, []); // eslint-disable-line

  const { loading, error, data, at } = state;
  // Story objects for the IDs Gemini used (only those still in the live list).
  const matched = (data?.storyIds || []).map((id) => stories.find((s) => s.id === id)).filter(Boolean);

  return (
    <div className="ask" style={{ maxHeight: "60vh", overflowY: "auto" }}>
      <button className="x" onClick={onClose} aria-label="Close">✕</button>
      <p className="muted">🔍 "{query}"</p>
      <b>🤖 Gemini Place Intelligence{data?.place ? ` · ${data.place.name}` : ""}</b>

      {loading && <p>Asking Gemini about this place...</p>}
      {error && <p style={{ color: "#b91c1c" }}>Couldn't answer: {error}</p>}

      {data && (
        <>
          <p style={{ margin: "6px 0" }}>{data.summary}</p>

          {data.incidents?.map((inc, i) => (
            <div key={i} style={{ borderTop: "1px solid #e5e7eb", padding: "6px 0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span>{iconFor(inc.category)} <b>{inc.title}</b></span>
                <ConfidencePill level={inc.confidence} />
              </div>
              <span className="muted">
                📍 {inc.location_hint} · {inc.story_ids.length} post{inc.story_ids.length === 1 ? "" : "s"}
              </span>
            </div>
          ))}

          <p className="muted" style={{ margin: "6px 0" }}>
            🕒 Updated {at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            {" · "}Based on {data.storyIds.length} live stor{data.storyIds.length === 1 ? "y" : "ies"}
          </p>

          {matched.length > 0 && (
            <>
              <b>Live community stories here</b>
              <div style={{ display: "flex", gap: 8, overflowX: "auto", padding: "6px 0" }}>
                {matched.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => onOpenStory(s)}
                    style={{ border: 0, background: "none", padding: 0, width: 84, flex: "0 0 auto", textAlign: "left" }}
                  >
                    <img
                      src={s.imageData}
                      alt=""
                      style={{
                        width: 84, height: 84, objectFit: "cover", borderRadius: 10,
                        filter: s.ai?.sensitiveContent ? "blur(10px)" : "none", // sensitive stays blurred
                      }}
                    />
                    <span style={{ fontSize: 11, display: "block" }}>{iconFor(s.category)} {s.category}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Profile({ user, profile, onSignIn, onSaveName }) {
  const [name, setName] = useState(profile?.displayName || "");
  useEffect(() => setName(profile?.displayName || ""), [profile]);

  if (!user) {
    return (
      <div className="page">
        <h2>Profile</h2>
        <p className="muted">Sign in to post stories and manage your profile.</p>
        <button className="primary" onClick={onSignIn}>Sign in with Google</button>
      </div>
    );
  }
  return (
    <div className="page">
      <h2>Profile</h2>
      <h3>Settings</h3>
      <label className="muted">Display name</label>
      <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
      <button className="primary" onClick={() => onSaveName(name)}>Save</button>
      <button className="link" onClick={() => signOut(auth)}>Sign out</button>
    </div>
  );
}

function Placeholder({ title, text }) {
  return (
    <div className="page">
      <h2>{title}</h2>
      <p className="muted">{text}</p>
    </div>
  );
}

const TABS = [
  { id: "feed", icon: "📰", label: "Feed" },
  { id: "maps", icon: "🗺️", label: "Maps" },
  { id: "stories", icon: "💬", label: "Stories" },
  { id: "chat", icon: "✉️", label: "Chat" },
  { id: "profile", icon: "👤", label: "Profile" },
];

// ---------- App ----------
// The current tab is kept in the URL hash (#maps, #stories...) so a refresh stays on it.
const VALID_TABS = ["feed", "maps", "stories", "chat", "profile"];
function tabFromHash() {
  const h = window.location.hash.replace("#", "");
  return VALID_TABS.includes(h) ? h : "maps"; // Maps stays the home screen
}
export default function App() {
    const [tab, setTabState] = useState(tabFromHash);
  function setTab(t) {
    setTabState(t);
    window.location.hash = t;
  }
  // Keep the tab in sync with the browser's Back button.
  useEffect(() => {
    const onHash = () => setTabState(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [showSignIn, setShowSignIn] = useState(false);
  const [showPost, setShowPost] = useState(false);
  const [viewer, setViewer] = useState(null); // { stories, startIndex, level } of the open incident
  const [userPos, setUserPos] = useState(null);
  const [stories, setStories] = useState([]);
  const [query_, setQuery] = useState("");
  const [asked, setAsked] = useState(null); // { text, id } of the current question
  const [askFocus, setAskFocus] = useState(null); // place returned by /ask, outlined on the map

  // Keep user + Firestore profile in sync with Firebase Auth.
  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      setUser(u);
      try {
        setProfile(u ? await ensureUserDoc(u) : null);
      } catch (err) {
        console.error("Profile load failed:", err);
        setProfile(null);
      }
    });
  }, []);

  // Live list of stories that have not expired (newest 50).
  useEffect(() => {
    const q = query(
      collection(db, "stories"),
      where("expiresAt", ">", Timestamp.now()),
      orderBy("expiresAt", "desc"),
      limit(50)
    );
    return onSnapshot(
      q,
      (snap) =>
        setStories(
          snap.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              ...data,
              createdMs: data.createdAt?.toMillis?.() ?? Date.now(),
              expiresMs: data.expiresAt.toMillis(),
            };
          })
        ),
      (err) => console.error("Stories listener failed:", err)
    );
  }, []);

  // Hide expired stories (newest first) and group them into incidents (one map dot each).
  // Every story's badge shows its incident's level. Recomputed only when stories change,
  // so the map isn't redrawn on every tap.
  const { liveStories, incidents, incidentOf } = useMemo(() => {
    const fresh = stories
      .filter((s) => s.expiresMs > Date.now())
      .sort((a, b) => b.createdMs - a.createdMs);
    const groups = groupIncidents(fresh);
    const of = {};
    groups.forEach((g) => {
      g.stories = g.stories.map((s) => ({ ...s, status: g.level }));
      g.stories.forEach((s) => { of[s.id] = g; });
    });
    const live = fresh.map((s) => ({ ...s, status: of[s.id].level }));
    return { liveStories: live, incidents: groups, incidentOf: of };
  }, [stories]);

  // Open the viewer on a whole incident (map dot), starting at its newest story.
  const openIncident = useCallback((g) => setViewer({ stories: g.stories, startIndex: 0, level: g.level }), []);
  // Open the viewer at one story (Stories list, Ask a Place), with the rest of its incident to swipe.
  function openStory(story) {
    const g = incidentOf[story.id];
    if (!g) return setViewer({ stories: [story], startIndex: 0, level: story.status });
    setViewer({ stories: g.stories, startIndex: Math.max(0, g.stories.findIndex((s) => s.id === story.id)), level: g.level });
  }

  async function handleSignIn() {
    try {
      await signInWithPopup(auth, googleProvider);
      setShowSignIn(false);
    } catch (err) {
      alert("Sign-in failed: " + err.code);
    }
  }
  async function saveName(displayName) {
    try {
      await setDoc(doc(db, "users", user.uid), { displayName }, { merge: true });
      setProfile({ ...profile, displayName });
      alert("Saved ✓");
    } catch (err) {
      alert("Save failed: " + err.code);
    }
  }
  function onCamera() {
    if (!user) return setShowSignIn(true);
    setShowPost(true);
  }
  // Ask a Place: a new id per submit, so asking the same question again re-fetches.
  function onSearch(e) {
    e.preventDefault();
    const text = query_.trim();
    if (!text) return;
    setAskFocus(null);
    setAsked({ text, id: Date.now() });
    setTab("maps"); // show the whole place and its dots on the map
  }
  function closeAsk() {
    setAsked(null);
    setAskFocus(null);
  }

  const showTopBar = ["feed", "maps", "stories"].includes(tab);

  return (
    <div className="app">
      {showTopBar && (
        <form className="topbar" onSubmit={onSearch}>
          <input className="search" value={query_} onChange={(e) => setQuery(e.target.value)}
                 placeholder="Ask a place, e.g. What happened on Penang Bridge?" />
          <button type="button" className="cam" onClick={onCamera} aria-label="Post a story">📷</button>
        </form>
      )}

      <div className="screen">
        <div style={{ display: tab === "maps" ? "block" : "none", height: "100%" }}>
          <MapScreen active={tab === "maps"} stories={liveStories} incidents={incidents}
                     onPinTap={openIncident} onLocated={setUserPos} focus={askFocus} />
        </div>
        {tab === "feed" && <Placeholder title="Feed" text="Credible news from the last 24 hours: coming soon." />}
        {tab === "stories" && (
          <div className="page">
            <h2>Stories</h2>
            {liveStories.length === 0 && <p className="muted">No live stories yet. Tap 📷 to post the first one.</p>}
            {liveStories.map((s) => (
              <StoryCard key={s.id} story={s} userPos={userPos} user={user}
                         onNeedSignIn={() => setShowSignIn(true)} onOpen={() => openStory(s)} />
            ))}
          </div>
        )}
        {tab === "chat" && <Placeholder title="Chat" text="Coming soon." />}
        {tab === "profile" && (
          <Profile user={user} profile={profile} onSignIn={handleSignIn} onSaveName={saveName} />
        )}
        {showTopBar && asked && (
          <AskCard key={asked.id} query={asked.text} userPos={userPos} stories={liveStories}
                   onPlace={setAskFocus} onOpenStory={openStory} onClose={closeAsk} />
        )}
      </div>

      <nav className="nav">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            <span className="icon">{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>

      {showSignIn && <SignInModal onClose={() => setShowSignIn(false)} onSignIn={handleSignIn} />}
      {showPost && (
        <PostModal user={user} profile={profile} initialPos={userPos}
                   onClose={() => setShowPost(false)}
                   onPosted={() => { setShowPost(false); setTab("maps"); }} />
      )}
      {viewer && (
        <StoryViewer key={viewer.stories[viewer.startIndex]?.id} stories={viewer.stories}
                     startIndex={viewer.startIndex} level={viewer.level} userPos={userPos}
                     onClose={() => setViewer(null)} />
      )}
    </div>
  );
}