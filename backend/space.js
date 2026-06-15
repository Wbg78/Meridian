// ───────────────────────────────────────────────────────────────
// backend/space.js
// THE EYE — Space Intelligence Module
//
// Free data sources (no API keys required unless noted):
//   Launch Library 2  → all global rocket launches, real-time
//   Space-Track.org   → NORAD TLE data, all tracked objects in orbit
//   CelesTrak          → TLE satellite catalog (no auth needed)
//   NASA ISS API      → crew, position, EVA schedule
//   ACLED API         → armed conflict event data (free, requires key)
//   UN OCHA           → humanitarian crisis data (free)
//
// Add to backend/.env:
//   SPACE_TRACK_USER=your_email    (free at space-track.org)
//   SPACE_TRACK_PASS=your_password
//   ACLED_USERNAME=your_email      (free at acleddata.com — OAuth login)
//   ACLED_PASSWORD=your_password
// ───────────────────────────────────────────────────────────────

import express from "express";
import { FACILITIES } from "./satellite.js";

export const spaceRouter = express.Router();

const CACHE = new Map();
const TTL = {
  launches:    15 * 60_000,   // 15 min — launches don't change fast
  upcoming:    30 * 60_000,   // 30 min
  satellites:  60 * 60_000,   // 1 hour — orbital elements drift slowly
  iss:          2 * 60_000,   // 2 min — ISS moves fast
  conflicts:   24 * 3600_000, // 24 hours — conflict zones
  stats:       60 * 60_000,   // 1 hour
};

function cached(key, ttl, fn) {
  const c = CACHE.get(key);
  if (c && Date.now() - c.at < ttl) return Promise.resolve(c.data);
  return fn().then(data => { CACHE.set(key, { at: Date.now(), data }); return data; });
}

// ─── LAUNCH LIBRARY 2 ───────────────────────────────────────────
// Free, no auth. Covers ALL agencies globally.
const LL2 = "https://ll.thespacedevs.com/2.2.0";

async function fetchRecentLaunches(limit = 20) {
  // net__lte=now → only launches that have already happened (newest first),
  // otherwise upcoming launches show up with negative "time ago".
  const now = new Date().toISOString();
  const r = await fetch(
    `${LL2}/launch/?format=json&limit=${limit}&net__lte=${now}&ordering=-net&mode=detailed`,
    { headers: { "User-Agent": "Meridian/1.0" } }
  );
  if (!r.ok) throw new Error("Launch Library: " + r.status);
  const data = await r.json();
  return (data.results || []).map(l => ({
    id: l.id,
    name: l.name,
    status: l.status?.name || "Unknown",
    net: l.net,                           // NET (No Earlier Than) timestamp
    agency: l.launch_service_provider?.name || "Unknown",
    agencyType: l.launch_service_provider?.type || "Unknown",
    countryCode: l.launch_service_provider?.country_code || "??",
    rocket: l.rocket?.configuration?.name || "Unknown",
    missionName: l.mission?.name || null,
    missionType: l.mission?.type || null,
    missionOrbit: l.mission?.orbit?.name || null,
    padName: l.pad?.name || null,
    padLocation: l.pad?.location?.name || null,
    padLat: l.pad?.latitude || null,
    padLon: l.pad?.longitude || null,
    imageUrl: l.image || null,
    webcastLive: l.webcast_live || false,
    probability: l.probability || null,
  }));
}

async function fetchUpcomingLaunches(limit = 10) {
  const r = await fetch(
    `${LL2}/launch/upcoming/?format=json&limit=${limit}&mode=detailed`,
    { headers: { "User-Agent": "Meridian/1.0" } }
  );
  if (!r.ok) throw new Error("Launch Library upcoming: " + r.status);
  const data = await r.json();
  return (data.results || []).map(l => ({
    id: l.id,
    name: l.name,
    net: l.net,
    agency: l.launch_service_provider?.name || "Unknown",
    countryCode: l.launch_service_provider?.country_code || "??",
    rocket: l.rocket?.configuration?.name || "Unknown",
    missionName: l.mission?.name || null,
    missionType: l.mission?.type || null,
    missionOrbit: l.mission?.orbit?.name || null,
    padName: l.pad?.name || null,
    padLocation: l.pad?.location?.name || null,
    padLat: l.pad?.latitude || null,
    padLon: l.pad?.longitude || null,
    imageUrl: l.image || null,
    probability: l.probability || null,
    tMinus: l.net ? Math.max(0, new Date(l.net) - Date.now()) : null,
  }));
}

// ─── CELESTRAK — Satellite TLE data ─────────────────────────────
// Free, no auth. The GP (General Perturbations) API returns current
// TLEs per group; the frontend propagates them with SGP4 (satellite.js)
// to draw live satellite positions on the globe.
const CELESTRAK_GP = "https://celestrak.org/NORAD/elements/gp.php";

// Curated operator set for the globe. Each entry maps a CelesTrak GROUP
// to the operator/owner + a display colour, and caps how many we render
// (keeps the globe ~200 sats total — light + meaningful, not 30k).
const SAT_OPERATORS = [
  { group: "stations",  operator: "ISS / CSS (crewed)",        country: "International", color: "#ffffff", cap: 6  },
  { group: "gps-ops",   operator: "US Space Force — GPS",      country: "USA",          color: "#0066ff", cap: 31 },
  { group: "galileo",   operator: "EU / ESA — Galileo",        country: "EU",           color: "#aa44ff", cap: 28 },
  { group: "glo-ops",   operator: "Roscosmos — GLONASS",       country: "Russia",       color: "#ff3355", cap: 24 },
  { group: "beidou",    operator: "CNSA — BeiDou",             country: "China",        color: "#ffaa00", cap: 25 },
  { group: "starlink",  operator: "SpaceX — Starlink",         country: "USA",          color: "#00d4ff", cap: 45 },
  { group: "oneweb",    operator: "OneWeb",                    country: "UK",           color: "#00ff88", cap: 30 },
  { group: "geo",       operator: "Geostationary (mixed)",     country: "Various",      color: "#888888", cap: 18 },
];

// Fetch active satellite catalog (count + metadata)
async function fetchSatelliteCatalog() {
  const r = await fetch(
    "https://celestrak.org/pub/satcat.csv",
    { headers: { "User-Agent": "Meridian/1.0" } }
  );
  if (!r.ok) throw new Error("CelesTrak SATCAT: " + r.status);
  const csv = await r.text();
  const lines = csv.split("\n").filter(l => l.trim() && !l.startsWith("OBJECT_NAME"));
  let active = 0, debris = 0, rocket_bodies = 0, payload = 0;
  const countries = new Set();
  lines.forEach(line => {
    const cols = line.split(",");
    if (cols.length < 10) return;
    const type = cols[3]?.trim();
    const status = cols[4]?.trim();
    const country = cols[5]?.trim();
    if (status === "+" || status === "P" || status === "B" || status === "S") active++;
    if (type === "DEB") debris++;
    else if (type === "R/B") rocket_bodies++;
    else if (type === "PAY") payload++;
    if (country) countries.add(country);
  });
  return {
    total: lines.length,
    active,
    debris,
    rocketBodies: rocket_bodies,
    payloads: payload,
    countriesWithAssets: countries.size,
  };
}

// Fetch TLEs for one CelesTrak GROUP (3-line TLE text → parsed objects).
async function fetchTLEGroup(group = "starlink") {
  const r = await fetch(
    `${CELESTRAK_GP}?GROUP=${encodeURIComponent(group)}&FORMAT=tle`,
    { headers: { "User-Agent": "Meridian/1.0" } }
  );
  if (!r.ok) return [];
  return parseTLEText(await r.text());
}

function parseTLEText(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const sats = [];
  for (let i = 0; i < lines.length - 2; i += 3) {
    if (!lines[i + 1]?.startsWith("1 ") || !lines[i + 2]?.startsWith("2 ")) continue;
    sats.push({ name: lines[i], tle1: lines[i + 1], tle2: lines[i + 2] });
  }
  return sats;
}

// Build the curated multi-operator satellite set for the globe.
// Returns ~200 sats tagged with operator + colour for SGP4 rendering.
async function fetchSatelliteSet() {
  const results = await Promise.allSettled(
    SAT_OPERATORS.map(op => fetchTLEGroup(op.group))
  );
  const sats = [];
  results.forEach((res, i) => {
    if (res.status !== "fulfilled") return;
    const op = SAT_OPERATORS[i];
    res.value.slice(0, op.cap).forEach(s => {
      sats.push({
        name: s.name,
        tle1: s.tle1,
        tle2: s.tle2,
        operator: op.operator,
        country: op.country,
        color: op.color,
        group: op.group,
      });
    });
  });
  return sats;
}

// ─── NASA ISS API ───────────────────────────────────────────────
async function fetchISSData() {
  // Position from wheretheiss.at (HTTPS, reliable, returns numeric lat/lon).
  // open-notify.org is HTTP-only and frequently down — keep it only for crew.
  const [pos, crew] = await Promise.allSettled([
    fetch("https://api.wheretheiss.at/v1/satellites/25544").then(r => r.json()),
    fetch("http://api.open-notify.org/astros.json").then(r => r.json()),
  ]);
  return {
    position: pos.status === "fulfilled" && pos.value?.latitude != null ? {
      lat: pos.value.latitude,
      lon: pos.value.longitude,
      timestamp: pos.value.timestamp,
    } : null,
    crew: crew.status === "fulfilled"
      ? (crew.value.people || []).filter(p => p.craft === "ISS")
      : [],
  };
}

// ─── LAUNCH STATS ───────────────────────────────────────────────
async function fetchLaunchStats() {
  const r = await fetch(
    `${LL2}/launch/?format=json&limit=1&net__gte=${new Date().getFullYear()}-01-01`,
    { headers: { "User-Agent": "Meridian/1.0" } }
  );
  if (!r.ok) return { totalThisYear: null };
  const data = await r.json();
  return { totalThisYear: data.count || null };
}

// ─── CONFLICT ZONES (ACLED) ─────────────────────────────────────
// ACLED moved to OAuth in 2025 (the old key-in-URL endpoint is dead).
// We exchange myACLED credentials (email + password) for a 24h access
// token, cache it in-module, then query the read endpoint with a
// Bearer header. Without credentials — or if anything fails — we fall
// back to a curated list of active zones so the globe is never empty.
//
// Add to backend/.env:
//   ACLED_USERNAME=your_myacled_email
//   ACLED_PASSWORD=your_myacled_password
const ACLED_OAUTH = "https://acleddata.com/oauth/token";
const ACLED_READ = "https://acleddata.com/api/acled/read";

// Curated fallback — major active conflict zones (approx. centroids).
const STATIC_CONFLICT_ZONES = [
  { name: "Ukraine",      lat: 49.0, lon: 32.0,  intensity: "high",   type: "armed_conflict" },
  { name: "Gaza",         lat: 31.5, lon: 34.5,  intensity: "high",   type: "armed_conflict" },
  { name: "Sudan",        lat: 15.0, lon: 30.0,  intensity: "high",   type: "armed_conflict" },
  { name: "Myanmar",      lat: 19.0, lon: 96.0,  intensity: "high",   type: "armed_conflict" },
  { name: "DR Congo",     lat: -2.0, lon: 28.0,  intensity: "high",   type: "armed_conflict" },
  { name: "Syria",        lat: 35.0, lon: 38.0,  intensity: "medium", type: "armed_conflict" },
  { name: "Yemen",        lat: 15.0, lon: 48.0,  intensity: "medium", type: "armed_conflict" },
  { name: "Somalia",      lat: 6.0,  lon: 46.0,  intensity: "medium", type: "armed_conflict" },
  { name: "Sahel (Mali)", lat: 17.0, lon: -4.0,  intensity: "medium", type: "armed_conflict" },
  { name: "Nigeria",      lat: 10.0, lon: 8.0,   intensity: "medium", type: "armed_conflict" },
  { name: "Ethiopia",     lat: 9.0,  lon: 39.0,  intensity: "medium", type: "armed_conflict" },
  { name: "Lebanon",      lat: 33.8, lon: 35.5,  intensity: "medium", type: "armed_conflict" },
  { name: "Haiti",        lat: 19.0, lon: -72.0, intensity: "medium", type: "armed_conflict" },
];

// In-module OAuth token cache (valid ~24h; refreshed a minute early).
let acledToken = null;  // { value, expiresAt }
async function getAcledToken() {
  const user = process.env.ACLED_USERNAME || process.env.ACLED_EMAIL;
  const pass = process.env.ACLED_PASSWORD;
  if (!user || !pass) return null;  // no credentials configured
  if (acledToken && Date.now() < acledToken.expiresAt) return acledToken.value;

  const r = await fetch(ACLED_OAUTH, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username: user,
      password: pass,
      grant_type: "password",
      client_id: "acled",
      scope: "authenticated",
    }),
  });
  if (!r.ok) throw new Error("ACLED OAuth: " + r.status);
  const data = await r.json();
  if (!data.access_token) throw new Error("ACLED OAuth: no access_token in response");
  const ttl = (data.expires_in ? data.expires_in * 1000 : 24 * 3600_000) - 60_000;
  acledToken = { value: data.access_token, expiresAt: Date.now() + ttl };
  return acledToken.value;
}

async function fetchConflictZones() {
  let token;
  try { token = await getAcledToken(); }
  catch (e) { console.warn("ACLED auth failed:", e.message); return STATIC_CONFLICT_ZONES; }
  if (!token) return STATIC_CONFLICT_ZONES;  // not configured → static fallback

  try {
    const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const url = `${ACLED_READ}?_format=json`
      + `&event_date=${from}|${to}&event_date_where=BETWEEN`
      + `&fields=country|latitude|longitude|event_type|fatalities`
      + `&limit=5000`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error("ACLED read: " + r.status);
    const data = await r.json();
    const rows = data.data || data.results || [];
    if (!rows.length) return STATIC_CONFLICT_ZONES;

    // Aggregate by country → averaged centroid + event/fatality totals
    const zones = {};
    rows.forEach(e => {
      const c = e.country || "Unknown";
      if (!zones[c]) zones[c] = { name: c, latSum: 0, lonSum: 0, events: 0, fatalities: 0 };
      zones[c].latSum += +e.latitude || 0;
      zones[c].lonSum += +e.longitude || 0;
      zones[c].events++;
      zones[c].fatalities += +e.fatalities || 0;
    });
    return Object.values(zones).map(z => ({
      name: z.name,
      lat: z.events ? z.latSum / z.events : 0,
      lon: z.events ? z.lonSum / z.events : 0,
      events: z.events,
      fatalities: z.fatalities,
      type: "armed_conflict",
      intensity: z.fatalities > 100 ? "high" : z.fatalities > 20 ? "medium" : "low",
    })).sort((a, b) => b.fatalities - a.fatalities).slice(0, 25);
  } catch (e) {
    console.warn("ACLED fetch failed:", e.message);
    return STATIC_CONFLICT_ZONES;
  }
}

// ─── COMPANY SEARCH ─────────────────────────────────────────────
// When user types "TSMC" or "SpaceX" in the globe search
// Build a searchable company → locations index from the Operations
// facility catalog (satellite.js), so search covers every tracked
// company/factory (~30 companies, 46 sites) instead of a hand-picked list.
const COMPANY_LOCATIONS = {};
for (const f of Object.values(FACILITIES)) {
  const key = f.company.toUpperCase();
  if (!COMPANY_LOCATIONS[key]) {
    COMPANY_LOCATIONS[key] = {
      name: f.company, ticker: f.ticker, type: f.type,
      locations: [],
      intel: f.strategicNote,
      riskFlags: [],
    };
  }
  COMPANY_LOCATIONS[key].locations.push({
    name: f.name, lat: f.lat, lon: f.lon, type: f.type, key: Object.keys(FACILITIES).find(k => FACILITIES[k] === f),
  });
}

// Search companies/locations for the globe
function searchLocations(query) {
  const q = query.toUpperCase().trim();
  const matches = [];
  for (const [key, data] of Object.entries(COMPANY_LOCATIONS)) {
    if (key.includes(q) || data.name.toUpperCase().includes(q) || data.ticker?.toUpperCase().includes(q)) {
      matches.push(data);
    }
  }
  return matches;
}

// ─── LAUNCH CHART DATA ──────────────────────────────────────────
async function fetchLaunchChartData(days = 30) {
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const r = await fetch(
    `${LL2}/launch/?format=json&limit=100&net__gte=${from}&ordering=net&mode=normal`,
    { headers: { "User-Agent": "Meridian/1.0" } }
  );
  if (!r.ok) return [];
  const data = await r.json();
  // Group by agency/country for the bar chart
  const byAgency = {};
  (data.results || []).forEach(l => {
    const agency = l.launch_service_provider?.name || "Unknown";
    const country = l.launch_service_provider?.country_code || "??";
    const date = l.net?.slice(0, 10);
    if (!byAgency[agency]) byAgency[agency] = { agency, country, launches: 0, dates: [] };
    byAgency[agency].launches++;
    if (date) byAgency[agency].dates.push(date);
  });
  return Object.values(byAgency).sort((a, b) => b.launches - a.launches);
}

// ─── ROUTES ─────────────────────────────────────────────────────

// All space data in one shot (for initial globe load)
spaceRouter.get("/overview", async (req, res) => {
  try {
    const [launches, upcoming, iss, stats, conflicts, catalog, chartData] = await Promise.allSettled([
      cached("launches", TTL.launches, () => fetchRecentLaunches(20)),
      cached("upcoming", TTL.upcoming, () => fetchUpcomingLaunches(10)),
      cached("iss", TTL.iss, () => fetchISSData()),
      cached("stats", TTL.stats, () => fetchLaunchStats()),
      cached("conflicts", TTL.conflicts, () => fetchConflictZones()),
      cached("catalog", TTL.satellites, () => fetchSatelliteCatalog()),
      cached("chart", TTL.launches, () => fetchLaunchChartData(30)),
    ]);
    res.json({
      launches:  launches.status  === "fulfilled" ? launches.value  : [],
      upcoming:  upcoming.status  === "fulfilled" ? upcoming.value  : [],
      iss:       iss.status       === "fulfilled" ? iss.value       : null,
      stats:     stats.status     === "fulfilled" ? stats.value     : {},
      conflicts: conflicts.status === "fulfilled" ? conflicts.value : [],
      catalog:   catalog.status   === "fulfilled" ? catalog.value   : {},
      chartData: chartData.status === "fulfilled" ? chartData.value : [],
    });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

spaceRouter.get("/launches/recent", async (req, res) => {
  try { res.json(await cached("launches", TTL.launches, () => fetchRecentLaunches(20))); }
  catch (e) { res.status(500).json({ error: String(e.message) }); }
});

spaceRouter.get("/launches/upcoming", async (req, res) => {
  try { res.json(await cached("upcoming", TTL.upcoming, () => fetchUpcomingLaunches(10))); }
  catch (e) { res.status(500).json({ error: String(e.message) }); }
});

spaceRouter.get("/launches/chart", async (req, res) => {
  try { res.json(await cached("chart", TTL.launches, () => fetchLaunchChartData(30))); }
  catch (e) { res.status(500).json({ error: String(e.message) }); }
});

spaceRouter.get("/iss", async (req, res) => {
  try { res.json(await cached("iss", TTL.iss, () => fetchISSData())); }
  catch (e) { res.status(500).json({ error: String(e.message) }); }
});

spaceRouter.get("/conflicts", async (req, res) => {
  try { res.json(await cached("conflicts", TTL.conflicts, () => fetchConflictZones())); }
  catch (e) { res.status(500).json({ error: String(e.message) }); }
});

spaceRouter.get("/catalog", async (req, res) => {
  try { res.json(await cached("catalog", TTL.satellites, () => fetchSatelliteCatalog())); }
  catch (e) { res.status(500).json({ error: String(e.message) }); }
});

spaceRouter.get("/tle/:group", async (req, res) => {
  try {
    const group = req.params.group || "starlink";
    res.json(await cached(`tle_${group}`, TTL.satellites, () => fetchTLEGroup(group)));
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

// Curated multi-operator satellite set for the globe (~200 sats, SGP4-ready)
spaceRouter.get("/satellites", async (req, res) => {
  try { res.json(await cached("satset", TTL.satellites, () => fetchSatelliteSet())); }
  catch (e) { res.status(500).json({ error: String(e.message) }); }
});

spaceRouter.get("/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json([]);
  res.json(searchLocations(q));
});
