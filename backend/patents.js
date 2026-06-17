// ───────────────────────────────────────────────────────────────
// backend/patents.js
// THE EYE — Patent Intelligence + CAD Design Assistant
//
// Data source: EPO Open Patent Services (OPS) v3.2
//   Worldwide patent data (incl. US), free tier, JSON.
//   (PatentsView was retired 2025-05-01; USPTO's replacement ODP
//    requires ID.me verification, so we use EPO OPS instead.)
//
// Get FREE credentials (email only, no ID verification):
//   1. Register at https://developers.epo.org
//   2. "My Apps" → add an app → copy Consumer Key + Consumer Secret
//
// Add to backend/.env:
//   EPO_OPS_KEY=your_consumer_key
//   EPO_OPS_SECRET=your_consumer_secret
//
// Patent analysis also uses ANTHROPIC_API_KEY (~$0.02–0.05/analysis).
// ───────────────────────────────────────────────────────────────

import express from "express";

export const patentsRouter = express.Router();

const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;
const OPS_KEY = process.env.EPO_OPS_KEY;
const OPS_SECRET = process.env.EPO_OPS_SECRET;
const OPS_BASE = "https://ops.epo.org/3.2/rest-services";
const CACHE = new Map();
const PATENT_TTL = 7 * 24 * 3600_000;  // patents don't change

// ─── Tiny helpers for OPS's deeply-nested, array-or-object JSON ──
const A = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);  // coerce to array
const TXT = (x) => (x && typeof x === "object" ? x["$"] : x) ?? "";  // unwrap {$: "text"}

// ─── OPS OAuth (client_credentials, ~20min token, cached) ───────
let opsToken = null;  // { value, expiresAt }
async function getOpsToken() {
  if (!OPS_KEY || !OPS_SECRET) {
    throw new Error("EPO_OPS_KEY/EPO_OPS_SECRET not set — get free credentials at https://developers.epo.org");
  }
  if (opsToken && Date.now() < opsToken.expiresAt) return opsToken.value;
  const basic = Buffer.from(`${OPS_KEY}:${OPS_SECRET}`).toString("base64");
  const r = await fetch("https://ops.epo.org/3.2/auth/accesstoken", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const raw = await r.text();
  if (!r.ok) throw new Error(`OPS auth ${r.status}: ${raw.slice(0, 160)}`);
  const data = JSON.parse(raw);
  const ttl = (+data.expires_in || 1200) * 1000 - 30_000;
  opsToken = { value: data.access_token, expiresAt: Date.now() + ttl };
  return opsToken.value;
}

// ─── OPS biblio search (CQL query) ──────────────────────────────
// Returns { total, docs } where docs are normalized patent objects.
async function opsSearch(cql, range = "1-10") {
  const token = await getOpsToken();
  const url = `${OPS_BASE}/published-data/search/biblio?q=${encodeURIComponent(cql)}&Range=${range}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const rawTxt = await r.text();
  if (!r.ok) throw new Error(`OPS search ${r.status}: ${rawTxt.slice(0, 160)}`);
  let raw;
  try { raw = JSON.parse(rawTxt); } catch { throw new Error("OPS returned non-JSON"); }

  const bs = raw?.["ops:world-patent-data"]?.["ops:biblio-search"] || {};
  const total = +(bs["@total-result-count"] || 0);
  const result = bs["ops:search-result"] || {};
  const docs = A(result["exchange-documents"])
    .flatMap(ed => A(ed["exchange-document"]))
    .map(normalizeDoc)
    .filter(Boolean);
  return { total, docs };
}

// Normalize one OPS exchange-document into our flat patent shape.
function normalizeDoc(doc) {
  try {
    const country = doc["@country"] || "";
    const num = doc["@doc-number"] || "";
    const kind = doc["@kind"] || "";
    const bib = doc["bibliographic-data"] || {};

    // Title — prefer English
    const titles = A(bib["invention-title"]);
    const title = TXT(titles.find(t => t["@lang"] === "en") || titles[0]) || "Untitled";

    // Applicant (assignee) — prefer the epodoc-formatted name
    const applicants = A(bib?.parties?.applicants?.applicant);
    const epodoc = applicants.find(a => a["@data-format"] === "epodoc") || applicants[0];
    const assignee = TXT(epodoc?.["applicant-name"]?.name) || "Unknown";

    // Publication date (YYYYMMDD) from the docdb document-id
    const ids = A(bib?.["publication-reference"]?.["document-id"]);
    const docdb = ids.find(d => d["@document-id-type"] === "docdb") || ids[0];
    const rawDate = TXT(docdb?.date);
    const date = rawDate.length === 8 ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}` : rawDate || null;

    // Abstract
    const abstract = A(doc["abstract"])
      .map(ab => A(ab.p).map(TXT).join(" "))
      .join(" ").trim().slice(0, 500) || null;

    const pubNumber = `${country}${num}${kind}`;
    return {
      number: pubNumber,
      title,
      date,
      abstract,
      assignee,
      inventors: A(bib?.parties?.inventors?.inventor)
        .filter(i => i["@data-format"] === "epodoc")
        .map(i => TXT(i?.["inventor-name"]?.name)).filter(Boolean).slice(0, 3),
      citedCount: null,  // OPS biblio doesn't include a citation count
      url: `https://worldwide.espacenet.com/patent/search?q=${encodeURIComponent(pubNumber)}`,
      source: "EPO/OPS",
    };
  } catch { return null; }
}

// ─── PATENT SEARCH ──────────────────────────────────────────────
async function searchPatents(query, options = {}) {
  const { limit = 10, assignee, byNumber } = options;
  let cql;
  if (byNumber) cql = `num="${query}"`;
  else if (assignee) cql = `txt="${query}" and pa="${assignee}"`;
  else cql = `txt="${query}"`;
  const { docs } = await opsSearch(cql, `1-${Math.min(limit, 25)}`);
  return docs;
}

// ─── PATENT VELOCITY BY COMPANY ─────────────────────────────────
async function fetchPatentVelocity(company, years = 3) {
  const cacheKey = `velocity_${company}`;
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < PATENT_TTL) return cached.data;

  const currentYear = new Date().getFullYear();
  const yearlyData = [];
  for (let y = currentYear - years; y <= currentYear; y++) {
    try {
      // pd within "YYYY0101 YYYY1231" — count via total-result-count
      const { total } = await opsSearch(`pa="${company}" and pd within "${y}0101 ${y}1231"`, "1-1");
      yearlyData.push({ year: y, count: total });
    } catch { yearlyData.push({ year: y, count: null }); }
    await new Promise(r => setTimeout(r, 500));  // OPS free tier is throttled
  }

  const trend = yearlyData.length >= 2
    ? yearlyData[yearlyData.length - 1]?.count > yearlyData[0]?.count ? "increasing" : "decreasing"
    : "unknown";

  const data = { company, yearlyData, trend, analyzedAt: new Date().toISOString() };
  CACHE.set(cacheKey, { at: Date.now(), data });
  return data;
}

// ─── CLAUDE PATENT ANALYSIS ─────────────────────────────────────
async function analyzePatent(patent) {
  if (!CLAUDE_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const prompt = `You are a patent intelligence analyst and CAD design assistant.
Analyze this patent and extract investment + design intelligence.
Respond ONLY in valid JSON matching this exact schema:

{
  "coreInnovation": "what is the key technical breakthrough in plain language",
  "industryApplication": "which industries/products does this apply to",
  "competitiveAdvantage": "what advantage does this give the assignee",
  "threatTo": ["list companies this patent could threaten"],
  "benefitsTo": ["list companies/sectors that benefit if this is licensed"],
  "designComponents": [
    {
      "component": "component name",
      "function": "what it does",
      "cadHint": "how you might model this in CAD (geometry, material, constraint)"
    }
  ],
  "designAroundOpportunities": ["ways to achieve similar result without infringing"],
  "investmentSignal": "bullish|neutral|bearish for the assignee company",
  "investmentRationale": "1-2 sentences",
  "moatContribution": "does this strengthen or weaken the company's competitive moat?",
  "technologyReadinessLevel": 1 to 9
}

Patent to analyze:
Number: ${patent.number}
Title: ${patent.title}
Assignee: ${patent.assignee}
Date: ${patent.date}
Abstract: ${patent.abstract}`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CLAUDE_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",  // cheaper for patent analysis
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const rawTxt = await r.text();
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${rawTxt.slice(0, 160)}`);
  const data = JSON.parse(rawTxt);
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const first = text.indexOf("{"), last = text.lastIndexOf("}");
  if (first < 0 || last < 0) throw new Error("No JSON object in model response");
  return JSON.parse(text.slice(first, last + 1));
}

// ─── INDUSTRY PATENT LANDSCAPE ──────────────────────────────────
// Who dominates patents in a given technology area?
async function fetchIndustryLandscape(technology) {
  const cacheKey = `landscape_${technology}`;
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < PATENT_TTL) return cached.data;

  const { total, docs } = await opsSearch(`txt="${technology}"`, "1-50");
  const sample = docs.length || 1;  // share is relative to the sampled rows

  const byCompany = {};
  docs.forEach(p => {
    const company = p.assignee || "Unknown";
    byCompany[company] = (byCompany[company] || 0) + 1;
  });

  const landscape = Object.entries(byCompany)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([company, count]) => ({ company, patents: count, share: +(count / sample * 100).toFixed(1) }));

  const result = {
    technology,
    totalPatents: total,
    sampleSize: docs.length,
    landscape,
    dominantPlayer: landscape[0]?.company || "Unknown",
    concentrationRatio: +landscape.slice(0, 3).reduce((s, c) => s + c.share, 0).toFixed(1),
    analyzedAt: new Date().toISOString(),
  };
  CACHE.set(cacheKey, { at: Date.now(), data: result });
  return result;
}

// ─── FEED — industry feed (IPC classification + 90-day window) ──
const FEED_TTL = 6 * 3600_000;  // 6 h — recent filings change daily

// IPC classification codes per industry section.
// IPC field in OPS CQL is `ic`. Parentheses required for OR expressions.
const INDUSTRY_IPC = {
  semiconductors: `ic="H01L"`,
  aerospace:      `(ic="B64C" or ic="B64D" or ic="B64G" or ic="F42B")`,
  ai_ml:          `ic="G06N"`,
  energy:         `(ic="H02J" or ic="H02S" or ic="H01M" or ic="F03D")`,
  biotech:        `(ic="A61K" or ic="C12N" or ic="A61P")`,
  robotics:       `(ic="B25J" or ic="G05B" or ic="G05D")`,
};

function recentDateWindow(days = 90) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 3600_000);
  const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, "");
  return `${fmt(start)} ${fmt(end)}`;
}

// ─── ROUTES ─────────────────────────────────────────────────────

// Diagnostic handler — exported so server.js can mount it WITHOUT requireOwner.
// GET /api/patents/health → { ok, message } or { ok, error }
export async function patentsHealthHandler(req, res) {
  if (!OPS_KEY || !OPS_SECRET) {
    return res.json({ ok: false, error: "EPO_OPS_KEY/EPO_OPS_SECRET not set in environment" });
  }
  try {
    await getOpsToken();
    res.json({ ok: true, message: "OPS auth OK — token acquired successfully" });
  } catch (e) {
    res.json({ ok: false, error: String(e.message) });
  }
}

// GET /api/patents/feed?industry=semiconductors&limit=10
// Returns { industry, docs[], fetchedAt } or { error, code }
patentsRouter.get("/feed", async (req, res) => {
  const { industry, limit } = req.query;
  if (!industry) return res.status(400).json({ error: "need ?industry=semiconductors" });
  const ipcFilter = INDUSTRY_IPC[industry];
  if (!ipcFilter) {
    return res.status(400).json({
      error: `Unknown industry "${industry}". Valid: ${Object.keys(INDUSTRY_IPC).join(", ")}`,
    });
  }

  const cacheKey = `feed_${industry}`;
  const hit = CACHE.get(cacheKey);
  if (hit && Date.now() - hit.at < FEED_TTL) return res.json(hit.data);

  try {
    const window = recentDateWindow(90);
    const cql = `${ipcFilter} and pd within "${window}"`;
    const n = Math.min(+limit || 10, 25);
    const { docs } = await opsSearch(cql, `1-${n}`);
    const data = { industry, docs, fetchedAt: new Date().toISOString() };
    CACHE.set(cacheKey, { at: Date.now(), data });
    res.json(data);
  } catch (e) {
    const msg = String(e.message);
    if (msg.includes("EPO_OPS_KEY") || msg.includes("OPS auth 4")) {
      return res.status(401).json({ error: msg, code: "AUTH_FAILED" });
    }
    if (msg.includes("403")) {
      return res.status(429).json({ error: "EPO OPS quota exceeded — try again later", code: "QUOTA_EXCEEDED" });
    }
    res.status(500).json({ error: msg });
  }
});

patentsRouter.get("/search", async (req, res) => {
  const { q, assignee, limit } = req.query;
  if (!q) return res.status(400).json({ error: "need ?q=search+term" });
  try {
    const patents = await searchPatents(q, { assignee, limit: Math.min(+limit || 10, 25) });
    res.json(patents);
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

patentsRouter.get("/analyze/:number", async (req, res) => {
  try {
    const cacheKey = `patent_${req.params.number}`;
    const cached = CACHE.get(cacheKey);
    if (cached && Date.now() - cached.at < PATENT_TTL) return res.json(cached.data);

    const patents = await searchPatents(req.params.number, { byNumber: true, limit: 1 });
    if (!patents.length) return res.status(404).json({ error: "Patent not found" });
    const analysis = await analyzePatent(patents[0]);
    const data = { patent: patents[0], analysis, analyzedAt: new Date().toISOString() };
    CACHE.set(cacheKey, { at: Date.now(), data });
    res.json(data);
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

patentsRouter.get("/velocity/:company", async (req, res) => {
  try { res.json(await fetchPatentVelocity(req.params.company)); }
  catch (e) { res.status(500).json({ error: String(e.message) }); }
});

patentsRouter.get("/landscape", async (req, res) => {
  const { tech } = req.query;
  if (!tech) return res.status(400).json({ error: "need ?tech=semiconductor" });
  try { res.json(await fetchIndustryLandscape(tech)); }
  catch (e) { res.status(500).json({ error: String(e.message) }); }
});

// ─── BOSS WILLIAM — Part explanation (per-click, cached) ─────────
// POST /api/patents/explain-part
// body: { patentNumber, component, function, cadHint, coreInnovation, title }
// Returns { explanation } — 2-4 friendly sentences from Haiku.
// Cached per (patentNumber :: component) so repeat clicks are free.
const PART_EXPLAIN_CACHE = new Map();

patentsRouter.post("/explain-part", async (req, res) => {
  const { patentNumber, component, function: fn, cadHint, coreInnovation, title } = req.body || {};
  if (!component) return res.status(400).json({ error: "component required" });
  const key = `${patentNumber}::${component}`;
  const hit = PART_EXPLAIN_CACHE.get(key);
  if (hit) return res.json({ explanation: hit, cached: true });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.json({
      explanation: `${component}: ${fn || "part of the assembly"}. (AI explanation unavailable — ANTHROPIC_API_KEY not set in backend environment.)`,
    });
  }
  try {
    const prompt = `You are "Boss William", a friendly, encouraging engineering mentor.
A user clicked the part "${component}" in a 3D schematic model of the patent "${title || patentNumber}".
The patent's core innovation: ${coreInnovation || "n/a"}.
This part's function: ${fn || "n/a"}. Modeling hint: ${cadHint || "n/a"}.
Explain in 2-4 warm, plain-language sentences what this specific part does and why it matters to the product. Avoid jargon; if you must use a technical term, gloss it briefly.`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json();
    const explanation = (data.content || [])
      .filter(b => b.type === "text").map(b => b.text).join("").trim();
    PART_EXPLAIN_CACHE.set(key, explanation);
    res.json({ explanation });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});
