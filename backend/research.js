// ───────────────────────────────────────────────────────────────
// backend/research.js
// Meridian Deep Research — "Foundry for investing".
// Ticker + crisis scenario in → typed entity graph + propagated
// impact tree out, streamed over SSE so the UI shows the agent walking.
//
// Two LLM calls per fresh run:
//   1) ONTOLOGY pass — turns EDGAR filings into a typed graph. No web.
//   2) CRISIS pass   — graph + scenario, live web search, shock
//                      propagated along the graph's edges.
//
// The graph persists (db.js → Postgres if DATABASE_URL is set, else
// in-memory). Re-running a NEW scenario on the same company skips
// ingestion entirely — build once, shock cheaply, many times.
//
// Endpoints (mount OWNER-ONLY in server.js):
//   POST   /api/research/deep      { ticker, scenario, context?, force? } → SSE
//   GET    /api/research/shocks                → saved scenario library
//   POST   /api/research/shocks    { label, scenario }
//   DELETE /api/research/shocks/:id
//   GET    /api/research/runs?ticker=PLTR      → recent run history
//   GET    /api/research/runs/:id              → one full past dossier
// ───────────────────────────────────────────────────────────────

import express from "express";
import { buildEdgarSpine } from "./edgar.js";
import {
  getOntology, saveOntology, saveRun, recentRuns, getRun,
  listShocks, saveShock, deleteShock,
} from "./db.js";

const MODEL = process.env.RESEARCH_MODEL || "claude-sonnet-4-6";
const API = "https://api.anthropic.com/v1/messages";
const ONTO_TTL = 7 * 24 * 3600_000; // a graph older than 7 days rebuilds

// ─── THE ONTOLOGY SCHEMA ────────────────────────────────────────
// Node types are chosen so a crisis can actually be injected and
// propagated: every node is a place a shock can land, every edge is a
// path it can travel. Every extracted node carries source + confidence.
const ONTOLOGY_SHAPE = `{
  "company": { "name": "", "sector": "", "businessModel": "", "moat": "", "moatTrend": "widening|stable|eroding|unknown" },
  "segments":     [{ "name": "", "revenuePct": null, "note": "", "source": "", "confidence": 0 }],
  "geographies":  [{ "region": "", "revenuePct": null, "source": "", "confidence": 0 }],
  "customers":    [{ "name": "", "relationship": "", "materiality": "high|med|low", "source": "", "confidence": 0 }],
  "suppliers":    [{ "name": "", "input": "", "criticality": "single-source|critical|standard", "source": "", "confidence": 0 }],
  "competitors":  [{ "name": "", "axis": "", "threat": "high|med|low", "source": "", "confidence": 0 }],
  "dependencies": [{ "name": "", "type": "input|tech|regulatory|infra|key-person|capital", "note": "", "source": "", "confidence": 0 }],
  "riskFactors":  [{ "text": "", "category": "", "source": "10-K", "confidence": 0 }],
  "edges":        [{ "from": "", "to": "", "relation": "competes_with|supplied_by|sells_to|depends_on|exposed_to", "note": "" }]
}`;

// ─── THE CRISIS OUTPUT SCHEMA ───────────────────────────────────
const IMPACT_SHAPE = `{
  "headline": "one sentence: the bottom line for the stock under this scenario",
  "netDirection": "bullish|bearish|mixed",
  "confidence": 0,
  "transmission": [
    {
      "node": "which ontology node is hit",
      "order": 1,
      "mechanism": "exactly how the shock reaches this node",
      "direction": "negative|positive",
      "magnitude": { "metric": "revenue|margin|multiple|other", "estimate": "a RANGE, clearly an estimate", "horizon": "0-6m|6-18m|18m+" },
      "path": ["scenario", "node A", "node B"],
      "confidence": 0,
      "evidence": [{ "claim": "", "url": "" }]
    }
  ],
  "bullCase": "the case the stock survives/benefits under this scenario",
  "bearCase": "the case it doesn't",
  "watchItems": ["leading indicators that would confirm this is playing out"],
  "falsifiers": ["observations that would prove this thesis wrong"],
  "estimatedImpact": { "revenue": "range %", "margin": "range bps/%", "multiple": "re-rate direction", "caveat": "these are reasoned estimates, not forecasts" }
}`;

// ─── Anthropic call helper ──────────────────────────────────────
async function callClaude({ system, user, web = false, maxTokens = 4096 }) {
  // Strip any non-printable-ASCII chars (e.g. a stray U+2028/whitespace from
  // copy-paste) — HTTP headers must be pure ASCII or fetch() throws.
  const key = (process.env.ANTHROPIC_API_KEY || "").replace(/[^\x21-\x7E]/g, "");
  if (!key) throw new Error("ANTHROPIC_API_KEY not set on server");
  const body = {
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  };
  if (web) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }];

  const r = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message || "anthropic error");
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

// Defensive JSON extraction — models occasionally wrap in prose/fences.
function parseJson(text) {
  let t = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const first = t.indexOf("{"), last = t.lastIndexOf("}");
  if (first >= 0 && last > first) t = t.slice(first, last + 1);
  return JSON.parse(t);
}

// ─── PASS 1: ontology ───────────────────────────────────────────
async function buildOntologyPass({ ticker, spine, context }) {
  const facts = spine?.financials
    ? JSON.stringify(spine.financials.concepts) + "\nDerived: " + JSON.stringify(spine.financials.derived)
    : "No EDGAR financials (likely a non-US filer — rely on the profile + your knowledge, and lower confidences).";
  const filing = spine?.filingText ? spine.filingText.slice(0, 45000) : "No 10-K text available.";
  const profile = context ? JSON.stringify(context).slice(0, 2000) : "none";

  const system =
    "You are a forensic equity analyst building a structured entity graph. " +
    "Use ONLY the provided filings, financials and profile for facts — do not invent numbers. " +
    "Where the filing implies something but doesn't state it, lower the confidence. " +
    "Output ONLY valid JSON matching the schema. No prose, no markdown.";

  const user =
    `Ticker: ${ticker}\n\nProfile: ${profile}\n\n` +
    `EDGAR financials:\n${facts}\n\n` +
    `10-K narrative (Business + Risk Factors, truncated):\n${filing}\n\n` +
    `Build the entity graph. Fill this exact schema:\n${ONTOLOGY_SHAPE}\n\n` +
    `Rules: revenuePct must sum to ~100 within segments and within geographies where the filing supports it; ` +
    `flag single-source suppliers and customer concentration explicitly; ` +
    `'source' is where you found each claim (e.g. "10-K Item 1", "financials", "profile"). Return JSON only.`;

  return parseJson(await callClaude({ system, user, maxTokens: 8192 }));
}

// ─── PASS 2: crisis propagation (live web) ──────────────────────
async function propagateCrisis({ ticker, scenario, graph }) {
  const system =
    "You are a scenario analyst. You are given a company's entity graph and a specific shock. " +
    "Inject the shock and trace it along the graph's edges: first-order (nodes directly hit), " +
    "second-order (what those connect to), third-order (the financial result: revenue/margin/multiple). " +
    "Search the web for the CURRENT state of the affected nodes before judging — a 10-K is a snapshot, " +
    "the world has moved. Cite a URL for every external claim. Be specific about magnitude but always give " +
    "ranges and label them estimates. Output ONLY valid JSON matching the schema.";

  const user =
    `Company: ${ticker}\n\nEntity graph:\n${JSON.stringify(graph)}\n\n` +
    `SCENARIO / CRISIS TO INJECT:\n"${scenario}"\n\n` +
    `Propagate this shock through the graph. For each affected node give the transmission mechanism, ` +
    `direction, a sized estimate, the path the shock travelled, and web-sourced evidence. ` +
    `Then synthesise bull/bear, what to watch, and what would falsify the thesis.\n\n` +
    `Fill this exact schema:\n${IMPACT_SHAPE}\n\nReturn JSON only.`;

  return parseJson(await callClaude({ system, user, web: true, maxTokens: 8192 }));
}

// ─── the agent loop, as an async generator of stage events ──────
async function* runDeepResearch({ ticker, scenario, context, force = false }) {
  ticker = ticker.toUpperCase().trim();
  yield { stage: "resolve", status: "running", label: `Resolving ${ticker}` };

  // 1) Try the persisted graph first.
  let graph = null;
  if (!force) {
    const row = await getOntology(ticker).catch(() => null);
    if (row && Date.now() - new Date(row.built_at).getTime() < ONTO_TTL) {
      graph = row.graph;
      yield { stage: "edgar", status: "cached", label: `Reusing entity graph from ${new Date(row.built_at).toLocaleDateString("sv-SE")}` };
      yield { stage: "ontology", status: "done", label: "Entity graph (saved)", data: graph };
    }
  }

  // 2) Fresh build when there's no usable graph.
  if (!graph) {
    yield { stage: "edgar", status: "running", label: "Pulling SEC EDGAR filings & financials" };
    const spine = await buildEdgarSpine(ticker).catch(() => null);
    yield {
      stage: "edgar",
      status: "done",
      label: spine?.financials
        ? `EDGAR: ${spine.filings?.length || 0} filings, financials ✓`
        : "No EDGAR filing (non-US filer) — using profile + model knowledge",
      data: { source10K: spine?.source10K || null, filings: spine?.filings || [] },
    };

    yield { stage: "ontology", status: "running", label: "Building the entity graph" };
    graph = await buildOntologyPass({ ticker, spine, context });
    await saveOntology({
      ticker,
      name: graph?.company?.name || ticker,
      spine: spine ? { source10K: spine.source10K, filings: spine.filings, financials: spine.financials } : null,
      graph,
    }).catch((e) => console.warn("saveOntology failed:", e.message));
    yield { stage: "ontology", status: "done", label: "Entity graph built & saved", data: graph };
  }

  // 3) Inject the shock.
  yield { stage: "crisis", status: "running", label: `Injecting shock: "${scenario}" — walking the web` };
  const impact = await propagateCrisis({ ticker, scenario, graph });
  const run = await saveRun({ ticker, scenario, impact }).catch(() => null);
  yield { stage: "crisis", status: "done", label: "Shock propagated", data: impact };

  yield { stage: "done", status: "done", label: "Dossier ready", data: { ticker, scenario, ontology: graph, impact, runId: run?.id ?? null } };
}

// ─── Express router ─────────────────────────────────────────────
export const researchRouter = express.Router();

// SSE stream — the main analysis endpoint.
researchRouter.post("/deep", async (req, res) => {
  const { ticker, scenario, context, force } = req.body || {};
  if (!ticker || !scenario) return res.status(400).json({ error: "need { ticker, scenario }" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    for await (const ev of runDeepResearch({ ticker, scenario, context, force: !!force })) send(ev);
  } catch (e) {
    send({ stage: "error", status: "error", label: String(e.message || e) });
  } finally {
    res.write("event: end\ndata: {}\n\n");
    res.end();
  }
});

// Saved scenario library (the drawer).
researchRouter.get("/shocks", async (req, res) => {
  try { res.json(await listShocks()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

researchRouter.post("/shocks", async (req, res) => {
  const { label, scenario } = req.body || {};
  if (!label?.trim() || !scenario?.trim()) return res.status(400).json({ error: "need { label, scenario }" });
  try { res.json(await saveShock({ label: label.trim(), scenario: scenario.trim() })); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

researchRouter.delete("/shocks/:id", async (req, res) => {
  try { await deleteShock(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Run history.
researchRouter.get("/runs", async (req, res) => {
  try { res.json(await recentRuns(req.query.ticker || null, 15)); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

researchRouter.get("/runs/:id", async (req, res) => {
  try {
    const run = await getRun(req.params.id);
    if (!run) return res.status(404).json({ error: "not found" });
    res.json(run);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
