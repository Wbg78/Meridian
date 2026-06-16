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
// ~50 strategically significant facilities of major public companies.
// Each is scannable from the Operations panel (Sentinel-2 + analysis).
export const FACILITIES = {
  // ── Semiconductors ──
  "TSMC_TAINAN":     { name: "TSMC Tainan Fab Complex",      company: "TSMC",        ticker: "TSM",       lat: 24.7741, lon: 120.9773, type: "semiconductor_fab", region: "Taiwan",        strategicNote: "World's most advanced chip production. N3/N2 process node." },
  "TSMC_ARIZONA":    { name: "TSMC Arizona Fab 21",          company: "TSMC",        ticker: "TSM",       lat: 33.5186, lon: -111.9253, type: "semiconductor_fab", region: "United States", strategicNote: "CHIPS Act beneficiary. N4 process. $40B investment." },
  "INTEL_CHANDLER":  { name: "Intel Ocotillo (Chandler)",    company: "Intel",       ticker: "INTC",      lat: 33.2658, lon: -111.8088, type: "semiconductor_fab", region: "United States", strategicNote: "Intel Foundry flagship. 18A/20A process node." },
  "INTEL_OHIO":      { name: "Intel Ohio (New Albany)",      company: "Intel",       ticker: "INTC",      lat: 40.0617, lon: -82.7674, type: "semiconductor_fab", region: "United States", strategicNote: "$28B+ mega-fab build-out. Watch construction pace." },
  "SAMSUNG_HWASEONG":{ name: "Samsung Hwaseong Campus",      company: "Samsung",     ticker: "005930.KS", lat: 37.1928, lon: 127.0747, type: "semiconductor_fab", region: "South Korea",   strategicNote: "Memory + Logic. HBM3E production critical for AI." },
  "SAMSUNG_TAYLOR":  { name: "Samsung Taylor (Texas)",       company: "Samsung",     ticker: "005930.KS", lat: 30.5683, lon: -97.4097, type: "semiconductor_fab", region: "United States", strategicNote: "$17B foundry. Apple/Nvidia advanced-node hopeful." },
  "SK_HYNIX":        { name: "SK Hynix Icheon",              company: "SK Hynix",    ticker: "000660.KS", lat: 37.2410, lon: 127.4870, type: "semiconductor_fab", region: "South Korea",   strategicNote: "Dominant HBM supplier for Nvidia AI GPUs." },
  "MICRON_BOISE":    { name: "Micron Boise HQ + Fab",        company: "Micron",      ticker: "MU",        lat: 43.5390, lon: -116.2300, type: "semiconductor_fab", region: "United States", strategicNote: "US memory champion. DRAM/HBM expansion." },
  "GF_MALTA":        { name: "GlobalFoundries Fab 8",        company: "GlobalFoundries", ticker: "GFS",   lat: 42.9930, lon: -73.8000, type: "semiconductor_fab", region: "United States", strategicNote: "Specialty + defense-grade silicon." },
  "ASML_VELDHOVEN":  { name: "ASML Veldhoven HQ",            company: "ASML",        ticker: "ASML",      lat: 51.4170, lon: 5.4530,   type: "semiconductor_equipment", region: "Netherlands", strategicNote: "Sole EUV lithography supplier. Chokepoint of chips." },
  "NVIDIA_HQ":       { name: "Nvidia HQ (Santa Clara)",      company: "Nvidia",      ticker: "NVDA",      lat: 37.3671, lon: -121.9677, type: "headquarters", region: "United States", strategicNote: "Fabless AI leader. Watch campus + workforce growth." },
  "AMD_HQ":          { name: "AMD HQ (Santa Clara)",         company: "AMD",         ticker: "AMD",       lat: 37.3855, lon: -121.9700, type: "headquarters", region: "United States", strategicNote: "Datacenter + AI accelerator challenger." },
  "TI_RICHARDSON":   { name: "Texas Instruments RFAB",       company: "Texas Instruments", ticker: "TXN", lat: 32.9680, lon: -96.7460, type: "semiconductor_fab", region: "United States", strategicNote: "Analog leader. 300mm capacity expansion." },
  "ASE_KAOHSIUNG":   { name: "ASE Kaohsiung (OSAT)",         company: "ASE Technology", ticker: "ASX",    lat: 22.6310, lon: 120.2800, type: "semiconductor_packaging", region: "Taiwan",   strategicNote: "Largest chip packaging/test. CoWoS advanced packaging." },

  // ── EV / Auto / Battery ──
  "TESLA_FREMONT":   { name: "Tesla Fremont Factory",        company: "Tesla",       ticker: "TSLA",      lat: 37.4935, lon: -121.9450, type: "auto_plant", region: "United States", strategicNote: "Original Tesla plant. Model S/X/3/Y output proxy." },
  "TESLA_AUSTIN":    { name: "Tesla Giga Texas",             company: "Tesla",       ticker: "TSLA",      lat: 30.2240, lon: -97.6170, type: "auto_plant", region: "United States", strategicNote: "HQ + Cybertruck/Model Y. 4680 cell ramp." },
  "TESLA_BERLIN":    { name: "Tesla Giga Berlin",            company: "Tesla",       ticker: "TSLA",      lat: 52.3920, lon: 13.8030,  type: "auto_plant", region: "Germany",       strategicNote: "European hub. Watch parking-lot throughput." },
  "TESLA_SHANGHAI":  { name: "Tesla Giga Shanghai",          company: "Tesla",       ticker: "TSLA",      lat: 30.9120, lon: 121.7200, type: "auto_plant", region: "China",         strategicNote: "Highest-volume Tesla plant. Export hub." },
  "BYD_SHENZHEN":    { name: "BYD Shenzhen HQ",              company: "BYD",         ticker: "1211.HK",   lat: 22.6560, lon: 114.0480, type: "auto_plant", region: "China",         strategicNote: "World's largest EV maker by volume." },
  "CATL_NINGDE":     { name: "CATL Ningde Megafactory",      company: "CATL",        ticker: "300750.SZ", lat: 26.6650, lon: 119.5480, type: "battery_plant", region: "China",      strategicNote: "World's #1 EV battery maker (~37% share)." },
  "RIVIAN_NORMAL":   { name: "Rivian Normal Plant",          company: "Rivian",      ticker: "RIVN",      lat: 40.4760, lon: -88.9520, type: "auto_plant", region: "United States", strategicNote: "EV startup output. R1T/R1S + Amazon vans." },
  "FORD_ROUGE":      { name: "Ford Rouge Complex",           company: "Ford",        ticker: "F",         lat: 42.3010, lon: -83.1680, type: "auto_plant", region: "United States", strategicNote: "F-150 + Lightning EV production." },
  "GM_FACTORY_ZERO": { name: "GM Factory ZERO (Detroit)",    company: "General Motors", ticker: "GM",     lat: 42.3760, lon: -83.0410, type: "auto_plant", region: "United States", strategicNote: "GM dedicated EV plant (Hummer EV, Silverado EV)." },
  "TOYOTA_TSUTSUMI": { name: "Toyota Tsutsumi Plant",        company: "Toyota",      ticker: "TM",        lat: 35.0790, lon: 137.1560, type: "auto_plant", region: "Japan",         strategicNote: "Flagship hybrid/Prius plant. Output proxy." },
  "VW_WOLFSBURG":    { name: "Volkswagen Wolfsburg",         company: "Volkswagen",  ticker: "VOW3.DE",   lat: 52.4320, lon: 10.7980,  type: "auto_plant", region: "Germany",       strategicNote: "World's largest car plant by area." },
  "PANASONIC_GIGA":  { name: "Panasonic/Tesla Giga Nevada",  company: "Panasonic",   ticker: "6752.T",    lat: 39.5380, lon: -119.4360, type: "battery_plant", region: "United States", strategicNote: "2170 cell supply for Tesla. Expansion watch." },

  // ── Aerospace & Defense ──
  "BOEING_EVERETT":  { name: "Boeing Everett Factory",       company: "Boeing",      ticker: "BA",        lat: 47.9220, lon: -122.2810, type: "aerospace_plant", region: "United States", strategicNote: "Widebody (777/767) assembly. Largest building by volume." },
  "BOEING_RENTON":   { name: "Boeing Renton (737)",          company: "Boeing",      ticker: "BA",        lat: 47.4900, lon: -122.2150, type: "aerospace_plant", region: "United States", strategicNote: "737 MAX line. Watch flight-line inventory." },
  "AIRBUS_TOULOUSE": { name: "Airbus Toulouse Final Assembly",company: "Airbus",     ticker: "AIR.PA",    lat: 43.6080, lon: 1.3640,   type: "aerospace_plant", region: "France",        strategicNote: "A320/A350 final assembly. Delivery-flow proxy." },
  "LOCKHEED_FW":     { name: "Lockheed Martin Fort Worth",   company: "Lockheed Martin", ticker: "LMT",   lat: 32.7690, lon: -97.4410, type: "defense_plant", region: "United States", strategicNote: "F-35 assembly line. Defense-demand signal." },
  "RTX_TUCSON":      { name: "Raytheon Tucson",              company: "RTX",         ticker: "RTX",       lat: 32.1130, lon: -110.8870, type: "defense_plant", region: "United States", strategicNote: "Missiles/munitions. Restock-cycle signal." },
  "NORTHROP_PALMDALE":{ name: "Northrop Grumman Palmdale",   company: "Northrop Grumman", ticker: "NOC",  lat: 34.6300, lon: -118.0840, type: "defense_plant", region: "United States", strategicNote: "B-21 Raider stealth bomber production." },
  "SPACEX_STARBASE": { name: "SpaceX Starbase",              company: "SpaceX",      ticker: "PRIVATE",   lat: 25.9970, lon: -97.1560, type: "launch_site", region: "United States", strategicNote: "Starship dev + launch. Cadence of test campaigns." },

  // ── Energy ──
  "ARAMCO_ABQAIQ":   { name: "Saudi Aramco Abqaiq",         company: "Saudi Aramco", ticker: "2222.SR",  lat: 25.9340, lon: 49.6720,  type: "oil_processing", region: "Saudi Arabia", strategicNote: "World's largest oil processing facility." },
  "EXXON_BAYTOWN":   { name: "ExxonMobil Baytown",          company: "ExxonMobil",  ticker: "XOM",       lat: 29.7470, lon: -94.9760, type: "refinery", region: "United States", strategicNote: "One of largest US refining/petrochem complexes." },
  "FIRSTSOLAR_OH":   { name: "First Solar Ohio",            company: "First Solar", ticker: "FSLR",      lat: 41.4870, lon: -83.6900, type: "solar_plant", region: "United States", strategicNote: "Largest US solar-panel manufacturing footprint." },

  // ── Big Tech / Data ──
  "APPLE_PARK":      { name: "Apple Park",                  company: "Apple",       ticker: "AAPL",      lat: 37.3349, lon: -122.0090, type: "headquarters", region: "United States", strategicNote: "HQ proxy for headcount/expansion sentiment." },
  "GOOGLE_PLEX":     { name: "Googleplex",                 company: "Alphabet",    ticker: "GOOGL",     lat: 37.4220, lon: -122.0840, type: "headquarters", region: "United States", strategicNote: "HQ; watch datacenter build-outs separately." },
  "META_HQ":         { name: "Meta HQ (Menlo Park)",       company: "Meta",        ticker: "META",      lat: 37.4850, lon: -122.1480, type: "headquarters", region: "United States", strategicNote: "AI capex + datacenter expansion signal." },
  "MICROSOFT_RED":   { name: "Microsoft Redmond",          company: "Microsoft",   ticker: "MSFT",      lat: 47.6400, lon: -122.1290, type: "headquarters", region: "United States", strategicNote: "HQ; Azure AI datacenter demand proxy." },
  "AMAZON_HQ":       { name: "Amazon HQ (Seattle)",        company: "Amazon",      ticker: "AMZN",      lat: 47.6150, lon: -122.3380, type: "headquarters", region: "United States", strategicNote: "AWS + logistics. Fulfillment-network watch." },

  // ── Industrial / Pharma ──
  "CATERPILLAR_TX":  { name: "Caterpillar HQ (Irving)",     company: "Caterpillar", ticker: "CAT",       lat: 32.8870, lon: -96.9690, type: "headquarters", region: "United States", strategicNote: "Global construction-demand bellwether." },
  "SIEMENS_BERLIN":  { name: "Siemens Gas Turbine Berlin",  company: "Siemens",     ticker: "SIE.DE",    lat: 52.5320, lon: 13.3290,  type: "industrial_plant", region: "Germany",   strategicNote: "Energy/industrial automation." },
  "NOVO_KALUNDBORG": { name: "Novo Nordisk Kalundborg",     company: "Novo Nordisk", ticker: "NVO",      lat: 55.6760, lon: 11.0890,  type: "pharma_plant", region: "Denmark",      strategicNote: "GLP-1 (Ozempic/Wegovy) API + fill-finish hub." },
  "LILLY_INDY":      { name: "Eli Lilly Indianapolis",      company: "Eli Lilly",   ticker: "LLY",       lat: 39.7700, lon: -86.1760, type: "pharma_plant", region: "United States", strategicNote: "Zepbound/Mounjaro capacity build-out." },
  "PFIZER_KALAMAZOO":{ name: "Pfizer Kalamazoo",            company: "Pfizer",      ticker: "PFE",       lat: 42.2470, lon: -85.5410, type: "pharma_plant", region: "United States", strategicNote: "Largest Pfizer manufacturing site." },
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

// ─── OPS NEWS ANALYSIS (Haiku + Google News) ────────────────────
// Per-click analysis: Google News → Haiku claude-haiku-4-5. ~$0.002/click.
// Returns structured brief about recent operational developments.
const HAIKU_MODEL = "claude-haiku-4-5-20251001";

async function analyzeOpsWithNews(facility) {
  if (!CLAUDE_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  // 1. Fetch 14 days of Google News for this company + region
  const query = `"${facility.company}" ${facility.region} factory operations`;
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en&gl=US&ceid=US:en`;
  let headlines = [];
  try {
    const r = await fetch(rssUrl, {
      headers: { "User-Agent": "Meridian/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const text = await r.text();
      const rx = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<pubDate>([\s\S]*?)<\/pubDate>[\s\S]*?<\/item>/g;
      let m;
      while ((m = rx.exec(text)) !== null && headlines.length < 20) {
        const title = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
          .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
        const daysAgo = Math.floor((Date.now() - new Date(m[2].trim())) / 86400000);
        if (daysAgo <= 14) headlines.push({ title, daysAgo });
      }
    }
  } catch (e) { console.warn("Google News fetch failed:", e.message); }

  if (!headlines.length) {
    return {
      source: "no_news",
      facility: facility.name, company: facility.company, region: facility.region,
      analysis: null, headlines: [],
    };
  }

  // 2. Haiku analysis — one call, all headlines in a single prompt
  const prompt = `You are an operational intelligence analyst. Assess recent activity at ${facility.name} (${facility.company}, ${facility.region} — ${facility.type}).

Facility context: ${facility.strategicNote}

Recent news headlines (last 14 days):
${headlines.map((h, i) => `${i + 1}. [${h.daysAgo}d ago] ${h.title}`).join("\n")}

Respond ONLY with valid JSON:
{
  "summary": "2-3 sentence operational overview based on the news",
  "keyDevelopments": ["up to 3 most significant developments"],
  "operationalStatus": "fully operational|partial|expansion|restructuring|unknown",
  "sentiment": "bullish|neutral|bearish",
  "riskFactors": ["key risks or challenges mentioned"],
  "investmentSignal": "bullish|neutral|bearish",
  "rationale": "1-sentence investment rationale",
  "confidence": 0.0
}`;

  const r2 = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CLAUDE_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const raw = await r2.text();
  if (!r2.ok) throw new Error(`Anthropic ${r2.status}: ${raw.slice(0, 120)}`);
  const data = JSON.parse(raw);
  const txt = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const first = txt.indexOf("{"), last = txt.lastIndexOf("}");
  if (first < 0 || last < 0) throw new Error("No JSON in Haiku response");
  const analysis = JSON.parse(txt.slice(first, last + 1));
  analysis.confidence = parseFloat(analysis.confidence) || 0.6;

  return {
    source: "haiku_news", facility: facility.name,
    company: facility.company, region: facility.region,
    headlines, analysis,
  };
}

satelliteRouter.get("/ops-news/:facilityKey", async (req, res) => {
  try {
    const facility = FACILITIES[req.params.facilityKey];
    if (!facility) return res.status(404).json({ error: "Unknown facility" });
    const result = await analyzeOpsWithNews(facility);
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
