import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Approximate demo location near Penang Bridge (staged, we can adjust later)
const DEMO_PIN = { lat: 5.3565, lng: 100.352 };
const DEFAULT_CENTER = [5.39, 100.33];

function MapScreen() {
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
      radius: 11,
      color: "#fff",
      weight: 3,
      fillColor: "#e53935",
      fillOpacity: 1,
    })
      .addTo(map)
      .bindPopup("<b>Demo pin</b><br>Accident near Km 7 (staged demo data)");

    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 200);
  }, []);

  function locateMe() {
    if (!navigator.geolocation) {
      setStatus("Location is not supported on this browser");
      return;
    }
    setStatus("Finding you...");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        const map = mapRef.current;
        if (meRef.current) meRef.current.remove();
        meRef.current = L.circleMarker([latitude, longitude], {
          radius: 9,
          color: "#fff",
          weight: 3,
          fillColor: "#1e88e5",
          fillOpacity: 1,
        }).addTo(map);
        map.setView([latitude, longitude], 15);
        setStatus(`You are here (accuracy about ${Math.round(accuracy)} m)`);
      },
      () => setStatus("Could not get your location. Please allow location access."),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  return (
    <div className="map-screen">
      <div ref={mapDiv} className="map" />
      <div className="top-bar">
        <input className="search" placeholder="Search a place or caption..." />
      </div>
      <div className="status">{status}</div>
      <button className="locate" onClick={locateMe} aria-label="Show my location">
        📍
      </button>
    </div>
  );
}

function Placeholder({ title, text }) {
  return (
    <div className="placeholder">
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}

const TABS = [
  { id: "snap", icon: "📸", label: "Snap" },
  { id: "map", icon: "🗺️", label: "Map" },
  { id: "stories", icon: "💬", label: "Stories" },
  { id: "feed", icon: "📰", label: "Feed" },
];

export default function App() {
  const [tab, setTab] = useState("map");
  return (
    <div className="app">
      <div className="screen">
        <div style={{ display: tab === "map" ? "block" : "none", height: "100%" }}>
          <MapScreen />
        </div>
        {tab === "snap" && <Placeholder title="Snap" text="Post a story: coming in Step 4." />}
        {tab === "stories" && <Placeholder title="Stories" text="Nearby stories: coming soon." />}
        {tab === "feed" && <Placeholder title="Feed" text="Credible news from the last 24 hours: coming soon." />}
      </div>
      <nav className="nav">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "active" : ""}
            onClick={() => {
              setTab(t.id);
            }}
          >
            <span className="icon">{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}