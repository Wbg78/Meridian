// ───────────────────────────────────────────────────────────────
// backend/satellite.js
// THE EYE — Operational Intelligence from Satellite Imagery
//
// Free data sources:
//   Sentinel-2 (ESA Copernicus) → 10m resolution, 5-day revisit
//   Landsat 9 (USGS/NASA)       → 30m resolution, 16-day revisit
//   Claude Vision               → analyzes imagery for operations
//
// Production integration requires:
//   Copernicus Data Space (free): https://dataspace.copernicus.eu
//   NASA Earthdata (free):        https://earthdata.nasa.gov
//
// Add to backend/.env:
//   COPERNICUS_USER=your_email      (finds imagery; required)
//   COPERNICUS_PASS=your_password
//   ANTHROPIC_API_KEY=already_set
//   SH_CLIENT_ID=...   (OPTIONAL — Sentinel Hub OAuth client; enables
//   SH_CLIENT_SECRET=...  true-color VISION analysis. Create at
//                         dataspace.copernicus.eu → User Settings →
//                         OAuth clients. Without it, analysis runs in
//                         metadata mode — still useful, never crashes.)
// ───────────────────────────────────────────────────────────────

import express from "express";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

export const satelliteRouter = express.Router();

const DATA_DIR = process.env.SATELLITE_DATA_DIR || "./satellite-cache";
const CACHE_TTL = 7 * 24 * 3600_000;  // 7 days per facility
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;

// ─── FACILITY REGISTRY ──────────────────────────────────────────
export const FACILITIES = {
  "TSMC_TAINAN": {
    name: "TSMC Tainan Fab Complex",
    company: "TSMC", ticker: "TSM",
    lat: 24.7741, lon: 120.9773,
    type: "semiconductor_fab",
    region: "Taiwan",
    strategicNote: "World's most advanced chip production. N3/N2 process node.",
  },
  "TSMC_ARIZONA": {
    name: "TSMC Arizona Fab 21",
    company: "TSMC", ticker: "TSM",
    lat: 33.5186, lon: -111.9253,
    type: "semiconductor_fab",
    region: "United States",
    strategicNote: "CHIPS Act beneficiary. N4 process. $40B investment.",
  },
  "INTEL_CHANDLER": {
    name: "Intel Chandler Campus",
    company: "Intel", ticker: "INTC",
    lat: 33.4484, lon: -112.1185,
    type: "semiconductor_fab",
    region: "United States",
    strategicNote: "Intel Foundry Services flagship. 18A process node.",
  },
  "SAMSUNG_HWASEONG": {
    name: "Samsung Hwaseong Campus",
    company: "Samsung", ticker: "005930.KS",
    lat: 37.1928, lon: 127.0747,
    type: "semiconductor_fab",
    region: "South Korea",
    strategicNote: "Memory + Logic. HBM3E production critical for AI.",
  },
  "NVIDIA_HQ": {
    name: "Nvidia HQ",
    company: "Nvidia", ticker: "NVDA",
    lat: 37.3671, lon: -121.9677,
    type: "headquarters",
    region: "United States",
    strategicNote: "Fabless. Monitors for workforce + expansion activity.",
  },
};

// ─── COPERNICUS SENTINEL-2 ──────────────────────────────────────
async function fetchCopernicusToken() {
  const user = process.env.COPERNICUS_USER;
  const pass = process.env.COPERNICUS_PASS;
  if (!user || !pass) return null;
  const r = await fetch(
    "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", client_id: "cdse-public", username: user, password: pass }),
    }
  );
  if (!r.ok) return null;
  const data = await r.json();
  return data.access_token;
}

async function searchSentinel2(lat, lon, daysBack = 30, cloudCover = 30) {
  const token = await fetchCopernicusToken();
  const dateFrom = new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10);
  const dateTo = new Date().toISOString().slice(0, 10);
  const bbox = `${lon - 0.05},${lat - 0.05},${lon + 0.05},${lat + 0.05}`;
  const url = `https://catalogue.dataspace.copernicus.eu/odata/v1/Products?$filter=Collection/Name eq 'SENTINEL-2' and OData.CSC.Intersects(area=geography'SRID=4326;POLYGON((${lon-0.05} ${lat-0.05},${lon+0.05} ${lat-0.05},${lon+0.05} ${lat+0.05},${lon-0.05} ${lat+0.05},${lon-0.05} ${lat-0.05}))') and ContentDate/Start gt ${dateFrom}T00:00:00.000Z and ContentDate/Start lt ${dateTo}T23:59:59.000Z and Attributes/OData.CSC.DoubleAttribute/any(att:att/Name eq 'cloudCover' and att/OData.CSC.DoubleAttribute/Value lt ${cloudCover})&$orderby=ContentDate/Start desc&$top=5`;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const r = await fetch(url, { headers });
  if (!r.ok) return [];
  const data = await r.json();
  return (data.value || []).map(p => ({
    id: p.Id,
    name: p.Name,
    date: p.ContentDate?.Start,
    cloudCover: p.Attributes?.find(a => a.Name === "cloudCover")?.Value || null,
    downloadUrl: `https://zipper.dataspace.copernicus.eu/odata/v1/Products(${p.Id})/$value`,
    thumbnailUrl: `https://catalogue.dataspace.copernicus.eu/odata/v1/Products(${p.Id})/Nodes(${p.Name}.SAFE)/Nodes(GRANULE)/Nodes(0)/Nodes(BROWSE)/Nodes(S2${p.Name.substring(3, 5)}_OPER_MSI_L2A_TL_${p.Name.substring(33, 37)}_T${p.Name.substring(38, 44)}_B_TCI.jpg)/$value`,
  }));
}

// ─── SENTINEL HUB — render a true-color PNG (optional) ──────────
// CDSE's OData/OpenSearch don't expose a simple viewable thumbnail,
// so for real imagery we render a true-color PNG via the Sentinel Hub
// Process API (included with a CDSE account). Create OAuth client
// credentials at dataspace.copernicus.eu → User Settings → OAuth
// clients, then set SH_CLIENT_ID / SH_CLIENT_SECRET in .env.
// Without them we degrade to metadata-only analysis (no crash).
async function fetchSentinelHubToken() {
  const id = process.env.SH_CLIENT_ID;
  const secret = process.env.SH_CLIENT_SECRET;
  if (!id || !secret) return null;
  const r = await fetch(
    "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
    }
  );
  if (!r.ok) return null;
  const data = await r.json();
  return data.access_token || null;
}

async function renderTrueColor(lat, lon, daysBack = 30) {
  const token = await fetchSentinelHubToken();
  if (!token) return null;  // SH not configured → caller falls back to metadata
  const d = 0.02;  // ~2km half-box
  const from = new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  const evalscript = `//VERSION=3
function setup(){return{input:["B02","B03","B04"],output:{bands:3}}}
function evaluatePixel(s){return [2.5*s.B04,2.5*s.B03,2.5*s.B02]}`;
  const body = {
    input: {
      bounds: { bbox: [lon - d, lat - d, lon + d, lat + d], properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } },
      data: [{ type: "sentinel-2-l2a", dataFilter: { timeRange: { from: `${from}T00:00:00Z`, to: `${to}T23:59:59Z` }, maxCloudCoverage: 30, mosaickingOrder: "leastCC" } }],
    },
    output: { width: 512, height: 512, responses: [{ identifier: "default", format: { type: "image/png" } }] },
    evalscript,
  };
  const r = await fetch("https://sh.dataspace.copernicus.eu/api/v1/process", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Accept: "image/png" },
    body: JSON.stringify(body),
  });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) return null;
  return buf.toString("base64");
}

// ─── CLAUDE ANALYSIS ────────────────────────────────────────────
// Robust: takes an optional base64 PNG. With an image it does true
// vision analysis; without one it produces a metadata-grounded
// assessment. Never throws on a bad API response — surfaces the error.
async function analyzeWithClaude(facility, imageB64, meta) {
  if (!CLAUDE_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const hasImage = !!imageB64;
  const prompt = `You are an operational intelligence analyst assessing ${facility.name} (${facility.company}, ${facility.region}).
This is a ${facility.type} facility. ${facility.strategicNote}

${hasImage
  ? "A true-color Sentinel-2 satellite image of the site is attached. Analyze what is visible."
  : `You do NOT have image pixels. Base your assessment on the imagery METADATA and known facility profile below, and keep confidence low.
Imagery metadata: latest acquisition ${meta?.date || "unknown"}, cloud cover ${meta?.cloudCover ?? "n/a"}%, ${meta?.totalFound ?? 0} cloud-tolerable passes in the last 30 days near ${facility.lat},${facility.lon}.`}

Respond ONLY in valid JSON matching this schema exactly:

{
  "utilizationEstimate": "percentage or range e.g. 75-85%",
  "constructionActivity": true or false,
  "constructionDescription": "what is being built if any",
  "workforceProxy": "high|medium|low",
  "thermalSignature": "elevated|normal|low|unknown",
  "equipmentVisible": ["list significant equipment if visible, else empty"],
  "infrastructureChanges": "any new roads, buildings, expansions noted",
  "operationalStatus": "fully operational|partial|maintenance|shutdown",
  "changeSignals": "what has changed vs typical operations if notable",
  "investmentSignal": "bullish|neutral|bearish",
  "investmentRationale": "1-2 sentences",
  "confidence": 0.0 to 1.0,
  "limitations": "what this assessment cannot tell us"
}`;

  const content = [];
  if (hasImage) content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: imageB64 } });
  content.push({ type: "text", text: prompt });

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CLAUDE_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content }],
    }),
  });

  const raw = await r.text();  // read as text first — never crash on empty body
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${raw.slice(0, 200)}`);
  let data;
  try { data = JSON.parse(raw); }
  catch { throw new Error("Anthropic returned non-JSON: " + raw.slice(0, 120)); }
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const first = text.indexOf("{"), last = text.lastIndexOf("}");
  if (first < 0 || last < 0) throw new Error("No JSON object in model response");
  const result = JSON.parse(text.slice(first, last + 1));
  result.analysisMode = hasImage ? "vision" : "metadata";
  return result;
}

// ─── MAIN FACILITY ANALYSIS ─────────────────────────────────────
async function analyzeFacility(facilityKey) {
  const facility = FACILITIES[facilityKey];
  if (!facility) throw new Error(`Unknown facility: ${facilityKey}`);

  await mkdir(DATA_DIR, { recursive: true });
  const cacheFile = join(DATA_DIR, `${facilityKey}.json`);

  if (existsSync(cacheFile)) {
    const cached = JSON.parse(await readFile(cacheFile, "utf8"));
    if (Date.now() - new Date(cached.analyzedAt).getTime() < CACHE_TTL) {
      return { ...cached, fromCache: true };
    }
  }

  // Search for recent imagery
  const images = await searchSentinel2(facility.lat, facility.lon, 30, 30);
  if (!images.length) {
    // Return mock structure when no imagery is available
    const mockResult = {
      facilityKey,
      facility: facility.name,
      company: facility.company,
      ticker: facility.ticker,
      lat: facility.lat,
      lon: facility.lon,
      type: facility.type,
      region: facility.region,
      strategicNote: facility.strategicNote,
      imagery: { available: false, reason: "No cloud-free imagery found in last 30 days" },
      analysis: null,
      analyzedAt: new Date().toISOString(),
      fromCache: false,
    };
    await writeFile(cacheFile, JSON.stringify(mockResult, null, 2));
    return mockResult;
  }

  const latestImage = images[0];
  const meta = { date: latestImage.date, cloudCover: latestImage.cloudCover, totalFound: images.length };

  // Try to render a real true-color image (Sentinel Hub); fall back to
  // metadata-only analysis if SH isn't configured or the render fails.
  let imageB64 = null;
  try { imageB64 = await renderTrueColor(facility.lat, facility.lon, 30); }
  catch (e) { console.warn("Sentinel Hub render failed:", e.message); }

  let analysis = null;
  try { analysis = await analyzeWithClaude(facility, imageB64, meta); }
  catch (e) { console.warn("Claude analysis failed:", e.message); }

  const result = {
    facilityKey,
    facility: facility.name,
    company: facility.company,
    ticker: facility.ticker,
    lat: facility.lat,
    lon: facility.lon,
    type: facility.type,
    region: facility.region,
    strategicNote: facility.strategicNote,
    imagery: {
      available: true,
      latest: latestImage,
      totalFound: images.length,
      allImages: images,
      rendered: !!imageB64,
    },
    analysis,
    analyzedAt: new Date().toISOString(),
    fromCache: false,
  };

  await writeFile(cacheFile, JSON.stringify(result, null, 2));
  return result;
}

// ─── ROUTES ─────────────────────────────────────────────────────
satelliteRouter.get("/facilities", (req, res) => {
  const list = Object.entries(FACILITIES).map(([key, f]) => ({
    key,
    name: f.name,
    company: f.company,
    ticker: f.ticker,
    lat: f.lat,
    lon: f.lon,
    type: f.type,
    region: f.region,
  }));
  res.json(list);
});

satelliteRouter.get("/analyze/:facilityKey", async (req, res) => {
  try {
    const result = await analyzeFacility(req.params.facilityKey);
    res.json(result);
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

satelliteRouter.get("/all", async (req, res) => {
  try {
    const results = await Promise.allSettled(
      Object.keys(FACILITIES).map(key => analyzeFacility(key))
    );
    res.json(results.map((r, i) => r.status === "fulfilled" ? r.value : {
      facilityKey: Object.keys(FACILITIES)[i],
      error: r.reason?.message || "Failed",
    }));
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});
