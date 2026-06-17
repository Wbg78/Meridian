// ───────────────────────────────────────────────────────────────
// backend/predictions.js
// Prediction-markets module — READ-ONLY data consumption.
// No trading, no order placement, ever.
//
// Data sources:
//   Polymarket  — live markets via public Gamma + CLOB APIs (no auth)
//   Kalshi      — STUBBED for v1 (auth required, user in Sweden)
//
// Mounted OWNER-ONLY in server.js:
//   app.use("/api/predictions", requireOwner, predictionsRouter);
//
// Endpoints:
//   GET  /api/predictions/niches
//   PATCH /api/predictions/niches/:slug/select
//   GET  /api/predictions/feed?niche=slug
//   GET  /api/predictions/base-rate?market_id=&question=&niche=
//   POST /api/predictions/base-rate/confirm
//   GET  /api/predictions/log?niche=&limit=
//   POST /api/predictions/log
//   PATCH /api/predictions/log/:id/resolve
//   GET  /api/predictions/calibration?niche=
// ───────────────────────────────────────────────────────────────

import express from "express";
import {
  getPredictionNiches,
  upsertNicheLastSelected,
  getBaseRate,
  saveBaseRate,
  lockPrediction,
  getPredictionLog,
  resolvePrediction,
  getCalibrationData,
} from "./db.js";

export const predictionsRouter = express.Router();

// ─── CONFIG ─────────────────────────────────────────────────────
const HAIKU         = "claude-haiku-4-5-20251001";
const CLAUDE_KEY    = process.env.ANTHROPIC_API_KEY;
const DIV_THRESHOLD = parseFloat(process.env.PREDICTIONS_DIV_THRESHOLD || "0.15");
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

// Polymarket public APIs — no auth needed
const POLY_GAMMA = "https://gamma-api.polymarket.com";
// CLOB used only for on-demand flow data (v1: stub)

// ─── IN-MEMORY CACHES ───────────────────────────────────────────
const feedCache     = new Map(); // niche_slug → { at, markets }
const baseRateCache = new Map(); // market_id  → { at, data }
const FEED_TTL      = 10 * 60_000;  // 10 min — fetch on tab open / manual refresh
const BASE_RATE_TTL = 24 * 3600_000; // 24h — LLM suggestions are expensive

// ─── HELPERS ────────────────────────────────────────────────────

/**
 * Remove the bookmaker overround from a binary market.
 * On Polymarket, outcomePrices should already sum to ≈1.0, but we
 * normalise anyway to handle any CLOB bid/ask drift.
 */
function devigProb(yesStr, noStr) {
  const y = parseFloat(yesStr) || 0;
  const n = parseFloat(noStr)  || 0;
  if (y + n <= 0) return 0.5;
  return parseFloat((y / (y + n)).toFixed(4));
}

/**
 * confidence_weight ∈ [0,1] — how much to trust this market as a signal.
 *
 * Formula:
 *   w_vol  = min(1, volume_usd / 50_000)           $50k+ → full confidence
 *   w_liq  = min(1, liquidity_usd / 10_000)        $10k+ spread depth → full
 *   w_time = 1 − exp(−days_to_resolution / 90)     90d horizon → 0.63, 1yr → 0.98
 *   weight = w_vol × w_liq × w_time
 *
 * Thin/stale/imminent markets naturally score near 0.
 */
function confidenceWeight(volume, liquidity, daysToResolution) {
  const wVol  = Math.min(1, (volume   || 0) / 50_000);
  const wLiq  = Math.min(1, (liquidity || 0) / 10_000);
  const wTime = (daysToResolution != null && daysToResolution > 0)
    ? 1 - Math.exp(-daysToResolution / 90)
    : 0.05; // expired or resolving today
  return parseFloat(Math.min(1, wVol * wLiq * wTime).toFixed(2));
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const end = new Date(dateStr).getTime();
  if (isNaN(end)) return null;
  return Math.round((end - Date.now()) / 86_400_000);
}

/**
 * Normalise a raw Polymarket Gamma market object into the typed MarketEntity shape:
 * { id, question, venue, url, end_date, time_to_resolution,
 *   implied_prob_raw, implied_prob_devigged, volume, liquidity,
 *   flow_concentration, resolution_quality, confidence_weight, niche_tag }
 */
function normalizeMarket(m, nicheTag) {
  const yesStr = m.outcomePrices?.[0] ?? "0.5";
  const noStr  = m.outcomePrices?.[1] ?? "0.5";
  const yes    = parseFloat(yesStr);
  const devig  = devigProb(yesStr, noStr);
  const days   = daysUntil(m.endDate);
  const cw     = confidenceWeight(m.volume, m.liquidity, days);

  return {
    id:                    m.conditionId || String(m.id),
    question:              m.question    || "(no question)",
    venue:                 "polymarket",
    url:                   `https://polymarket.com/event/${m.slug || ""}`,
    end_date:              m.endDate     || null,
    time_to_resolution:    days,
    implied_prob_raw:      parseFloat(yes.toFixed(4)),
    implied_prob_devigged: devig,
    volume:                parseFloat(m.volume   || 0),
    liquidity:             parseFloat(m.liquidity || 0),
    // flow_concentration: on-chain wallet analysis — hook reserved for v2
    flow_concentration:    null,
    resolution_quality:    "binary",
    confidence_weight:     cw,
    niche_tag:             nicheTag,
    // reference_class / base_rate are filled in when the card is expanded
    reference_class:       null,
    base_rate:             null,
  };
}

/** Fetch and filter Polymarket markets for one niche. */
async function fetchPolymarketForNiche(niche) {
  const keywords = Array.isArray(niche.keywords) ? niche.keywords : [];
  const markets  = [];
  const limit    = 100;

  // Fetch up to 2 pages (200 markets) sorted by 24h volume descending.
  for (let offset = 0; offset < 200; offset += limit) {
    const url = `${POLY_GAMMA}/markets?closed=false&limit=${limit}&offset=${offset}&order=volume24hr&ascending=false`;
    const r   = await fetch(url, { headers: { "User-Agent": "Meridian/1.0" } });

    if (r.status === 429) {
      // Rate-limited: stop paginating; use what we have
      if (!markets.length) throw Object.assign(new Error("Polymarket rate-limited (HTTP 429)"), { status: 429 });
      break;
    }
    if (!r.ok) throw new Error(`Polymarket Gamma API returned HTTP ${r.status}`);

    const page = await r.json();
    if (!Array.isArray(page) || !page.length) break;
    markets.push(...page);
    if (page.length < limit) break;
  }

  // Filter by niche keywords (case-insensitive, any match)
  let matched = markets;
  if (keywords.length) {
    const kws = keywords.map(k => k.toLowerCase());
    matched = markets.filter(m => {
      const text = `${m.question || ""} ${m.description || ""}`.toLowerCase();
      return kws.some(k => text.includes(k));
    });
  }

  // Sort best-signal first
  matched.sort((a, b) => (b.volume || 0) - (a.volume || 0));
  return matched.slice(0, 30).map(m => normalizeMarket(m, niche.slug));
}

// ─── ROUTES ─────────────────────────────────────────────────────

// GET /api/predictions/niches
predictionsRouter.get("/niches", async (_req, res) => {
  try {
    res.json(await getPredictionNiches());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// PATCH /api/predictions/niches/:slug/select — persist last-selected niche
predictionsRouter.patch("/niches/:slug/select", async (req, res) => {
  try {
    await upsertNicheLastSelected(req.params.slug);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/predictions/feed?niche=slug
// Fetch-on-demand only — no background polling.
predictionsRouter.get("/feed", async (req, res) => {
  const { niche: nicheSlug = "all" } = req.query;

  try {
    // Check in-memory cache first
    const cached = feedCache.get(nicheSlug);
    if (cached && Date.now() - cached.at < FEED_TTL) {
      return res.json({
        markets:   cached.markets,
        niche:     nicheSlug,
        cached_at: cached.at,
        error:     null,
        stubbed:   { kalshi: true, kalshi_reason: "Auth required; user outside supported jurisdiction" },
      });
    }

    const niches = await getPredictionNiches();
    const targetNiches = nicheSlug === "all"
      ? niches.filter(n => n.is_active)
      : niches.filter(n => n.slug === nicheSlug && n.is_active);

    if (!targetNiches.length) {
      return res.json({
        markets: [], niche: nicheSlug, error: null,
        stubbed: { kalshi: true },
      });
    }

    let allMarkets = [];
    let fetchError = null;

    for (const n of targetNiches) {
      try {
        const mkts = await fetchPolymarketForNiche(n);
        allMarkets.push(...mkts);
      } catch (e) {
        // Record error but don't abort — other niches may succeed
        fetchError = e.message;
        console.warn(`[predictions] Polymarket fetch failed for niche "${n.slug}": ${e.message}`);
      }
    }

    if (!allMarkets.length && fetchError) {
      // Distinguish rate-limit vs general API error
      const isRateLimit = fetchError.includes("429");
      return res.status(502).json({
        markets: [],
        niche:   nicheSlug,
        error:   isRateLimit
          ? "Polymarket is rate-limiting requests — wait a minute and refresh."
          : `Polymarket API error: ${fetchError}`,
        stubbed: { kalshi: true },
      });
    }

    // Deduplicate (same market can match multiple niches in "all" mode)
    const seen = new Set();
    allMarkets = allMarkets.filter(m => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });

    // Sort: confidence_weight desc, then volume desc
    allMarkets.sort((a, b) =>
      b.confidence_weight - a.confidence_weight || b.volume - a.volume
    );

    const result = allMarkets.slice(0, 40);
    feedCache.set(nicheSlug, { at: Date.now(), markets: result });

    res.json({
      markets:   result,
      niche:     nicheSlug,
      cached_at: Date.now(),
      error:     fetchError, // partial error (some niches failed) but we got results
      stubbed:   { kalshi: true, kalshi_reason: "Auth required; user outside supported jurisdiction" },
    });

  } catch (e) {
    res.status(502).json({
      markets: [], niche: nicheSlug,
      error:   `Feed error: ${e.message}`,
      stubbed: { kalshi: true },
    });
  }
});

// GET /api/predictions/base-rate?market_id=&question=&niche=
// Returns a base rate from DB, falls back to LLM generation (Haiku), caches both ways.
predictionsRouter.get("/base-rate", async (req, res) => {
  const { market_id, question, niche } = req.query;
  if (!market_id || !question) {
    return res.status(400).json({ error: "market_id and question are required" });
  }

  try {
    // 1) In-memory cache
    const memCached = baseRateCache.get(market_id);
    if (memCached && Date.now() - memCached.at < BASE_RATE_TTL) {
      return res.json(memCached.data);
    }

    // 2) Persistent DB
    const stored = await getBaseRate(market_id);
    if (stored) {
      baseRateCache.set(market_id, { at: Date.now(), data: stored });
      return res.json(stored);
    }

    // 3) No LLM key — degrade gracefully
    if (!CLAUDE_KEY) {
      return res.json({
        market_id,
        reference_class: null,
        base_rate:       null,
        rationale:       "AI key not configured — base rate unavailable. Add ANTHROPIC_API_KEY to Render env vars.",
        confirmed_by_me: false,
        source:          "unavailable",
      });
    }

    // 4) Generate with Haiku
    const prompt = `You are a calibration expert helping a trader train their probabilistic judgment.

Prediction market question: "${question}"
Niche: ${niche || "general"}

Task: assign a REFERENCE CLASS and estimate a historical BASE RATE for this type of question.
Do NOT use the current market price — use historical outside-view base rates only.

Respond with ONLY a valid JSON object (no prose, no code block markers):
{
  "reference_class": "concise label for the reference class (e.g. 'FDA drug approvals Phase III')",
  "base_rate": 0.XX,
  "rationale": "1–2 sentences explaining which reference class you chose and why this base rate applies"
}

Rules:
- base_rate is a float 0.0–1.0
- Pick the reference class that is both specific enough to be informative and broad enough to have historical data
- Err on the side of regression to the mean when uncertain
- reference_class should be reusable for similar questions in the future`;

    const r = await fetch(ANTHROPIC_API, {
      method:  "POST",
      headers: {
        "x-api-key":         CLAUDE_KEY,
        "anthropic-version": "2023-06-01",
        "content-type":      "application/json",
      },
      body: JSON.stringify({
        model:      HAIKU,
        max_tokens: 300,
        messages:   [{ role: "user", content: prompt }],
      }),
    });

    if (!r.ok) throw new Error(`Haiku API returned HTTP ${r.status}`);
    const data = await r.json();
    const text = data.content?.[0]?.text || "{}";

    let parsed;
    try {
      const jsonMatch = text.match(/\{[\s\S]*?\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } catch {
      throw new Error("LLM returned unparseable JSON for base rate");
    }

    const result = {
      market_id,
      reference_class: parsed.reference_class || "General",
      base_rate: typeof parsed.base_rate === "number"
        ? Math.max(0, Math.min(1, parseFloat(parsed.base_rate.toFixed(3))))
        : null,
      rationale:       parsed.rationale || "",
      confirmed_by_me: false,
      source:          "llm",
    };

    // Persist so we don't re-call LLM on next open
    await saveBaseRate(result);
    baseRateCache.set(market_id, { at: Date.now(), data: result });

    res.json(result);

  } catch (e) {
    // Never swallow — return the real error so the UI can distinguish
    console.error("[predictions] base-rate error:", e.message);
    res.status(502).json({ error: e.message, market_id });
  }
});

// POST /api/predictions/base-rate/confirm
// User corrects or confirms a base rate — persists with confirmed_by_me=true.
predictionsRouter.post("/base-rate/confirm", async (req, res) => {
  const { market_id, reference_class, base_rate, rationale } = req.body || {};
  if (!market_id) return res.status(400).json({ error: "market_id required" });

  try {
    const result = {
      market_id,
      reference_class: reference_class || "General",
      base_rate: typeof base_rate === "number"
        ? Math.max(0, Math.min(1, base_rate))
        : null,
      rationale:       rationale || "",
      confirmed_by_me: true,
      source:          "user",
    };
    await saveBaseRate(result);
    baseRateCache.set(market_id, { at: Date.now(), data: result });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/predictions/log?niche=&limit=
predictionsRouter.get("/log", async (req, res) => {
  const { niche, limit = "50" } = req.query;
  try {
    const entries = await getPredictionLog(niche || null, parseInt(limit, 10));
    res.json(entries);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /api/predictions/log — lock a prediction BEFORE resolution
predictionsRouter.post("/log", async (req, res) => {
  const { market_id, question, venue, my_prob, niche, metadata } = req.body || {};
  if (!market_id || !question || my_prob == null || !niche) {
    return res.status(400).json({ error: "market_id, question, my_prob, niche are required" });
  }
  const prob = parseFloat(my_prob);
  if (isNaN(prob) || prob < 0 || prob > 1) {
    return res.status(400).json({ error: "my_prob must be a number between 0 and 1" });
  }
  try {
    const entry = await lockPrediction({
      market_id, question, venue: venue || "polymarket",
      my_prob: prob, niche, metadata,
    });
    res.status(201).json(entry);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// PATCH /api/predictions/log/:id/resolve
// Mark a prediction resolved; Brier score is computed server-side.
predictionsRouter.patch("/log/:id/resolve", async (req, res) => {
  const id      = parseInt(req.params.id, 10);
  const outcome = req.body?.outcome;
  if (outcome !== 0 && outcome !== 1) {
    return res.status(400).json({ error: "outcome must be 0 (NO) or 1 (YES)" });
  }
  try {
    const entry = await resolvePrediction(id, outcome);
    if (!entry) return res.status(404).json({ error: "Prediction not found" });
    res.json(entry);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/predictions/calibration?niche=
// All derived data computed from stored raw facts — nothing extra stored.
predictionsRouter.get("/calibration", async (req, res) => {
  const { niche } = req.query;
  try {
    const data = await getCalibrationData(niche || null);
    // Attach divergence threshold for UI reference
    res.json({ ...data, div_threshold: DIV_THRESHOLD });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── KALSHI STUB (v2 hook) ──────────────────────────────────────
// Clean interface — wiring up real Kalshi auth is drop-in here.
// export async function fetchKalshiMarkets(niche) {
//   // TODO: GET https://trading-api.kalshi.com/trade-api/v2/events?limit=100
//   // Requires KALSHI_API_KEY bearer auth.
//   // Returns [] (stub) until implemented.
//   return [];
// }

// ─── CROSS-NODE DIVERGENCE HOOK (ontology v2) ──────────────────
// Called when comparing a market's devigged_prob to a related ontology node.
// Currently a no-op — wired to nothing. Do NOT remove: this is the
// integration point for ontology-graph cross-referencing.
// export function checkCrossNodeDivergence(market, ontologyNode) {
//   // TODO: compare market.implied_prob_devigged to ontologyNode.impliedProbability
//   // when ontology nodes carry probabilistic states.
//   return null;
// }
