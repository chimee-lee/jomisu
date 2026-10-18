// ---------- Distance and time helpers ----------

// Distance in km between two {lat, lng} points (haversine formula).
export function distanceKm(a, b) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Rounds a coordinate to a ~550 m grid for "approximate location".
export const roundCoord = (x) => Math.round(x / 0.005) * 0.005;

// "5 min ago" style label.
export function timeAgo(ms) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

// "850 m" or "6.8 km".
export const formatKm = (km) => (km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`);

// ---------- Bridges: "Second Bridge · KM 6" labels ----------
// Same lines as api/geo.py (island end first, so KM 0 = island end).
const BRIDGES = [
  {
    label: "Second Bridge",
    points: [[5.29117, 100.29528], [5.27656, 100.31903], [5.26106, 100.33847], [5.2544, 100.35713],
             [5.24754, 100.37789], [5.23279, 100.3958], [5.22535, 100.41394], [5.2291, 100.43371]],
  },
  {
    label: "Penang Bridge",
    points: [[5.35889, 100.31703], [5.35669, 100.32894], [5.35523, 100.3384], [5.35371, 100.34823],
             [5.3523, 100.35771], [5.35137, 100.36694], [5.35216, 100.37685], [5.35363, 100.38817]],
  },
];
const BRIDGE_CORRIDOR_M = 400; // a story this close to a bridge line counts as "on the bridge"

// Distance (m) from a point to a line, and how far along the line (km) the closest spot is.
// Same maths as route_position() in api/geo.py: flatten to metres, project onto each segment.
function routePosition(lat, lng, line) {
  const [refLat, refLng] = line[0];
  const xy = ([la, ln]) => [
    (ln - refLng) * 111320 * Math.cos((refLat * Math.PI) / 180),
    (la - refLat) * 110540,
  ];
  const [px, py] = xy([lat, lng]);
  let best = Infinity, bestAlong = 0, walked = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = xy(line[i]);
    const [bx, by] = xy(line[i + 1]);
    const dx = bx - ax, dy = by - ay;
    const seg = Math.hypot(dx, dy);
    // t = how far along this segment the closest point is (0 = start, 1 = end)
    const t = seg === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / seg ** 2));
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (d < best) { best = d; bestAlong = walked + t * seg; }
    walked += seg;
  }
  return { distM: best, km: bestAlong / 1000 };
}

// "Second Bridge · KM 6" if the point is on a bridge, otherwise null.
export function bridgeLabel(lat, lng) {
  for (const b of BRIDGES) {
    const { distM, km } = routePosition(lat, lng, b.points);
    if (distM <= BRIDGE_CORRIDOR_M) return `${b.label} · KM ${Math.round(km)}`;
  }
  return null;
}

// ---------- Area names ("Bayan Lepas", "Gelugor") from OpenStreetMap ----------
// Free reverse geocoder (Nominatim). Its rules: max 1 request per second, and cache results.
// So: results are cached in this browser, and requests wait in a queue 1.1 s apart.
const NOMINATIM_REVERSE = "https://nominatim.openstreetmap.org/reverse";
const CACHE_KEY = "jomisu-area-names-v1";
let areaCache = {};
try { areaCache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"); } catch { areaCache = {}; }

const pending = {}; // key -> Promise, so the same spot is only looked up once
let queue = Promise.resolve();

// Cache key: coordinates rounded to ~100 m (nearby stories share one lookup).
const areaKey = (lat, lng) => `${lat.toFixed(3)},${lng.toFixed(3)}`;

// Pick the most useful "area" level from an OSM address (Penang uses suburb for most towns).
function pickArea(addr = {}) {
  const area = addr.suburb || addr.quarter || addr.neighbourhood || addr.village
    || addr.town || addr.city_district || addr.city || addr.county || addr.state;
  const city = addr.city || addr.town;
  return area && city && area !== city ? `${area}, ${city}` : area || null;
}

// Area name already known for this spot (or undefined if not looked up yet).
export const cachedArea = (lat, lng) => areaCache[areaKey(lat, lng)];

// Look up the area name for a spot. Resolves to a string, or null if unknown.
export function lookupArea(lat, lng) {
  const key = areaKey(lat, lng);
  if (key in areaCache) return Promise.resolve(areaCache[key]);
  if (pending[key]) return pending[key];

  pending[key] = queue = queue
    .then(() => new Promise((r) => setTimeout(r, 1100))) // keep 1 request per second
    .then(async () => {
      const url = `${NOMINATIM_REVERSE}?format=jsonv2&zoom=14&accept-language=en&lat=${lat}&lon=${lng}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Nominatim ${res.status}`);
      const name = pickArea((await res.json()).address);
      areaCache[key] = name;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(areaCache)); } catch { /* storage full or blocked */ }
      return name;
    })
    .catch(() => null) // offline or busy: just show no area name
    .finally(() => delete pending[key]);
  return pending[key];
}
