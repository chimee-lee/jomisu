import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { auth, db, googleProvider } from "./firebase";

// ---------- Demo data (staged, labelled as demo) ----------
const DEMO_PIN = {
  lat: 5.3565,
  lng: 100.352,
  title: "Accident near Km 7, Penang Bridge",
  tag: "🚗 Accident",
  status: "Unconfirmed",
  reports: 1,
};
const DEFAULT_CENTER = [5.39, 100.33];

// ---------- Helpers ----------
// Returns the first emoji typed (from the phone's native emoji keyboard), or null.
const EMOJI_RE = /^(\p{Extended_Pictographic}|\p{Regional_Indicator})/u;
function firstEmoji(text) {
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const { segment } of seg.segment(text)) {
    return EMOJI_RE.test(segment) ? segment : null;
  }
  return null;
}

// Create the user's Firestore profile on first sign-in; return the profile.
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
function MapScreen({ active, onPinTap }) {
  const mapDiv = useRef(null);
  const mapRef = useRef(null);
  const meRef = useRef(null);
  const [status, setStatus] = useState("Tap 📍 to show your location");

  useEffect(() => {
    if (mapRef.current) return;
    const map = L.map(mapDiv.current, { zoomControl: false }).setView(DEFAULT_CENTER, 12);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    L.circleMarker([DEMO_PIN.lat, DEMO_PIN.lng], {
      radius: 12, color: "#fff", weight: 3, fillColor: "#e53935", fillOpacity: 1,
    })
      .addTo(map)
      .on("click", () => onPinTap(DEMO_PIN)); // opens the pin popup

    mapRef.current = map;
  }, [onPinTap]);

  // Leaflet needs a size refresh whenever the map tab becomes visible again.
  useEffect(() => {
    if (active && mapRef.current) setTimeout(() => mapRef.current.invalidateSize(), 100);
  }, [active]);

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
      setStatus(`You are here (accuracy about ${Math.round(accuracy)} m)`);
    };
    const onFail = (err) => {
      if (err.code === 1) setStatus("Location blocked. Tap aA > Website Settings > Location > Allow.");
      else if (err.code === 2) setStatus("Location unavailable. Check Location Services is on.");
      else setStatus("Location timed out. Please try again.");
    };
    // Try fast/approximate first, then precise
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

  return (
    <div className="map-screen">
      <div ref={mapDiv} className="map" />
      <div className="status">{status}</div>
      <button className="locate" onClick={locateMe} aria-label="Show my location">📍</button>
    </div>
  );
}

// ---------- Reactions (preset emojis + any emoji from the native keyboard) ----------
function ReactionBar() {
  const [counts, setCounts] = useState({ "👍": 12, "🔥": 4, "😮": 3, "🚨": 6 });
  const [mine, setMine] = useState({});
  const [adding, setAdding] = useState(false);

  function toggle(e) {
    const on = !mine[e];
    setMine({ ...mine, [e]: on });
    setCounts({ ...counts, [e]: (counts[e] || 0) + (on ? 1 : -1) });
  }
  function onType(ev) {
    const e = firstEmoji(ev.target.value);
    ev.target.value = "";
    if (e) {
      setCounts({ ...counts, [e]: (counts[e] || 0) + 1 });
      setMine({ ...mine, [e]: true });
      setAdding(false);
    }
  }
  return (
    <div className="reactions">
      {Object.entries(counts).map(([e, n]) => (
        <button key={e} className={mine[e] ? "chip on" : "chip"} onClick={() => toggle(e)}>
          {e} {n}
        </button>
      ))}
      {adding ? (
        <input className="emoji-input" autoFocus placeholder="Use 😀 keyboard" onChange={onType} onBlur={() => setAdding(false)} />
      ) : (
        <button className="chip" onClick={() => setAdding(true)}>＋</button>
      )}
    </div>
  );
}

function StoryCard() {
  return (
    <div className="card">
      <div className="thumb">📸</div>
      <div>
        <b>{DEMO_PIN.tag}</b> <span className="badge">{DEMO_PIN.status}</span>
        <p className="muted">{DEMO_PIN.title} · demo data</p>
        <ReactionBar />
      </div>
    </div>
  );
}

// ---------- Overlays ----------
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

function PinModal({ pin, onClose }) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="thumb big">📸</div>
        <h3>{pin.title}</h3>
        <p>
          <b>{pin.tag}</b> <span className="badge">{pin.status}</span>
        </p>
        <p className="muted">{pin.reports} report · staged demo data</p>
        <button className="link" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

// Ask a Place card: layout only for now; Gemini fills it in Step 5.
function AskCard({ query, onClose }) {
  return (
    <div className="ask">
      <button className="x" onClick={onClose} aria-label="Close">✕</button>
      <p className="muted">🔍 "{query}"</p>
      <b>🤖 Gemini Place Intelligence Summary</b>
      <p>Layout preview. The real answer from Gemini arrives in Step 5.</p>
      <p className="muted">🕒 Updated — · Confidence: — (verified by N posts)</p>
    </div>
  );
}

// ---------- Profile (name editable, saved to Firestore) ----------
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
export default function App() {
  const [tab, setTab] = useState("maps"); // Maps is the home screen
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [showSignIn, setShowSignIn] = useState(false);
  const [pin, setPin] = useState(null);
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");

  // Keep user + Firestore profile in sync with Firebase Auth.
  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setProfile(u ? await ensureUserDoc(u) : null);
    });
  }, []);

  async function handleSignIn() {
    try {
      await signInWithPopup(auth, googleProvider);
      setShowSignIn(false);
    } catch (err) {
      alert("Sign-in failed: " + err.code);
    }
  }
  async function saveName(displayName) {
    await setDoc(doc(db, "users", user.uid), { displayName }, { merge: true });
    setProfile({ ...profile, displayName });
  }
  function onCamera() {
    if (!user) return setShowSignIn(true);
    alert("Camera/upload comes in Step 4."); // placeholder
  }
  function onSearch(e) {
    e.preventDefault();
    if (query.trim()) setAsked(query.trim());
  }

  const showTopBar = ["feed", "maps", "stories"].includes(tab);

  return (
    <div className="app">
      {showTopBar && (
        <form className="topbar" onSubmit={onSearch}>
          <input className="search" value={query} onChange={(e) => setQuery(e.target.value)}
                 placeholder="Ask a place, e.g. What happened on Penang Bridge?" />
          <button type="button" className="cam" onClick={onCamera} aria-label="Post a story">📷</button>
        </form>
      )}

      <div className="screen">
        <div style={{ display: tab === "maps" ? "block" : "none", height: "100%" }}>
          <MapScreen active={tab === "maps"} onPinTap={setPin} />
        </div>
        {tab === "feed" && <Placeholder title="Feed" text="Credible news from the last 24 hours: coming soon." />}
        {tab === "stories" && (
          <div className="page">
            <h2>Stories</h2>
            <StoryCard />
          </div>
        )}
        {tab === "chat" && <Placeholder title="Chat" text="Coming soon." />}
        {tab === "profile" && (
          <Profile user={user} profile={profile} onSignIn={handleSignIn} onSaveName={saveName} />
        )}
        {showTopBar && asked && <AskCard query={asked} onClose={() => setAsked("")} />}
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
      {pin && <PinModal pin={pin} onClose={() => setPin(null)} />}
    </div>
  );
}