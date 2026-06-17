// ───────────────────────────────────────────────────────────────
// backend/db.js
// Persistence for the research engine + predictions module.
//
// Uses Postgres when DATABASE_URL is set (Render managed Postgres).
// Falls back to in-memory maps — app still runs locally with ZERO setup.
//
// Persisted entities:
//   ontologies       — entity graph per ticker
//   runs             — crisis analysis history
//   shocks           — reusable scenario library
//   prediction_log   — my locked predictions + Brier scores
//   base_rate_library— confirmed/LLM-generated reference class base rates
//   niche_config     — editable niche list + last-selected niche
//
// `pg` is imported lazily, so you only need it installed if you actually
// point DATABASE_URL at a database.
// ───────────────────────────────────────────────────────────────

import { TRACKER_SCHEMA, setPool } from "./signals-tracker.js";
import { WATCHLIST_SCHEMA, setWatchlistPool } from "./watchlist.js";

const HAS_DB = !!process.env.DATABASE_URL;
let pool = null;
const usePg = () => HAS_DB && pool;

// ─── PREDICTIONS: default niche seeds ──────────────────────────
const DEFAULT_NICHES = [
  {
    slug: "tech-regulatory",
    label: "Tech & AI Regulatory",
    description: "EU AI Act, antitrust, FTC/DOJ, big-tech regulation milestones",
    keywords: ["AI regulation", "antitrust", "FTC", "DOJ tech", "EU AI Act", "GDPR", "Apple antitrust", "Google antitrust", "Meta antitrust", "tech regulation", "Section 230"],
    sort_order: 0,
  },
  {
    slug: "biotech-milestone",
    label: "Biotech Milestones",
    description: "FDA approvals, Phase III readouts, drug launches",
    keywords: ["FDA", "drug approval", "Phase III", "Phase 3", "clinical trial", "biotech", "oncology", "cancer drug", "gene therapy", "mRNA", "PDUFA", "NDA", "BLA"],
    sort_order: 1,
  },
  {
    slug: "nordic-macro",
    label: "Nordic & European Macro",
    description: "Riksbank, ECB, Nordic economic events, European elections",
    keywords: ["Riksbank", "Sweden", "ECB", "European Central Bank", "Eurozone", "Norway", "Denmark", "Finland", "interest rate Europe", "EU election", "Nordic", "Inflation Europe"],
    sort_order: 2,
  },
  {
    slug: "ai-compute",
    label: "AI/Compute Infrastructure",
    description: "AI model releases, chip export controls, data center policy",
    keywords: ["OpenAI", "Anthropic", "GPT", "Gemini", "Nvidia", "chip ban", "semiconductor export", "AI model", "compute", "data center", "AI chip", "export control", "Huawei chip"],
    sort_order: 3,
  },
];

// ─── PREDICTIONS DB SCHEMA ──────────────────────────────────────
export const PREDICTIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS prediction_log (
    id                serial PRIMARY KEY,
    market_id         text NOT NULL,
    question          text NOT NULL,
    venue             text NOT NULL DEFAULT 'polymarket',
    my_prob           real NOT NULL,
    timestamp_locked  timestamptz NOT NULL DEFAULT now(),
    niche             text NOT NULL,
    resolution_outcome real,
    brier_score       real,
    metadata          jsonb
  );
  CREATE INDEX IF NOT EXISTS prediction_log_niche_idx  ON prediction_log (niche, timestamp_locked DESC);
  CREATE INDEX IF NOT EXISTS prediction_log_market_idx ON prediction_log (market_id);

  CREATE TABLE IF NOT EXISTS base_rate_library (
    market_id        text PRIMARY KEY,
    reference_class  text NOT NULL,
    base_rate        real,
    rationale        text,
    confirmed_by_me  boolean NOT NULL DEFAULT false,
    source           text NOT NULL DEFAULT 'llm',
    updated_at       timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS niche_config (
    id               serial PRIMARY KEY,
    slug             text NOT NULL UNIQUE,
    label            text NOT NULL,
    description      text,
    keywords         text[],
    is_active        boolean NOT NULL DEFAULT true,
    sort_order       int NOT NULL DEFAULT 0,
    last_selected_at timestamptz
  );
`;

// ----- in-memory fallback -----
const mem = {
  ontologies: new Map(), // ticker -> row
  runs: [],
  shocks: [],
  prediction_log: [],    // { id, market_id, question, venue, my_prob, timestamp_locked, niche, resolution_outcome, brier_score, metadata }
  base_rates: new Map(), // market_id -> row
  seq: 1,
};

export async function initDb() {
  if (!HAS_DB) {
    console.log("ℹ  No DATABASE_URL — research engine using in-memory storage (resets on restart).");
    return;
  }
  try {
    const pg = (await import("pg")).default;
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
    });
    setPool(pool);          // share the pool with the signal-engine tracker
    setWatchlistPool(pool); // share the pool with the watchlist store
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ontologies (
        ticker     text PRIMARY KEY,
        name       text,
        spine      jsonb,
        graph      jsonb NOT NULL,
        built_at   timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS runs (
        id            serial PRIMARY KEY,
        ticker        text NOT NULL,
        scenario      text NOT NULL,
        impact        jsonb NOT NULL,
        net_direction text,
        created_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS shocks (
        id          serial PRIMARY KEY,
        label       text NOT NULL,
        scenario    text NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS runs_ticker_idx ON runs (ticker, created_at DESC);
    `);
    await pool.query(TRACKER_SCHEMA);    // signal_history, source_accuracy, anomaly_log
    await pool.query(WATCHLIST_SCHEMA);  // watchlist
    await pool.query(PREDICTIONS_SCHEMA); // prediction_log, base_rate_library, niche_config

    // Seed default niches if table is empty
    const { rows: nicheCount } = await pool.query("SELECT COUNT(*)::int AS n FROM niche_config");
    if (nicheCount[0].n === 0) {
      for (const n of DEFAULT_NICHES) {
        await pool.query(
          `INSERT INTO niche_config (slug, label, description, keywords, sort_order)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (slug) DO NOTHING`,
          [n.slug, n.label, n.description, n.keywords, n.sort_order]
        );
      }
      console.log("✅ Seeded 4 default prediction niches.");
    }
    console.log("✅ Research + Predictions DB ready (Postgres).");
  } catch (e) {
    pool = null;
    console.warn("⚠  Postgres init failed — falling back to in-memory storage:", e.message);
  }
}

// ----- ontologies -----
export async function getOntology(ticker) {
  if (!usePg()) return mem.ontologies.get(ticker) || null;
  const { rows } = await pool.query("SELECT * FROM ontologies WHERE ticker = $1", [ticker]);
  return rows[0] || null;
}

export async function saveOntology({ ticker, name, spine, graph }) {
  if (!usePg()) {
    mem.ontologies.set(ticker, { ticker, name, spine, graph, built_at: new Date().toISOString() });
    return;
  }
  await pool.query(
    `INSERT INTO ontologies (ticker, name, spine, graph, built_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (ticker) DO UPDATE SET name=$2, spine=$3, graph=$4, built_at=now()`,
    [ticker, name, spine, graph]
  );
}

// ----- runs (history) -----
export async function saveRun({ ticker, scenario, impact }) {
  const net = impact?.netDirection || null;
  if (!usePg()) {
    const row = { id: mem.seq++, ticker, scenario, impact, net_direction: net, created_at: new Date().toISOString() };
    mem.runs.unshift(row);
    mem.runs = mem.runs.slice(0, 200);
    return row;
  }
  const { rows } = await pool.query(
    `INSERT INTO runs (ticker, scenario, impact, net_direction) VALUES ($1,$2,$3,$4) RETURNING *`,
    [ticker, scenario, impact, net]
  );
  return rows[0];
}

export async function recentRuns(ticker, limit = 10) {
  if (!usePg()) return mem.runs.filter((r) => !ticker || r.ticker === ticker).slice(0, limit)
    .map(({ impact, ...rest }) => rest); // strip heavy impact from the list
  const { rows } = await pool.query(
    ticker
      ? "SELECT id, ticker, scenario, net_direction, created_at FROM runs WHERE ticker=$1 ORDER BY created_at DESC LIMIT $2"
      : "SELECT id, ticker, scenario, net_direction, created_at FROM runs ORDER BY created_at DESC LIMIT $1",
    ticker ? [ticker, limit] : [limit]
  );
  return rows;
}

export async function getRun(id) {
  if (!usePg()) return mem.runs.find((r) => r.id === Number(id)) || null;
  const { rows } = await pool.query("SELECT * FROM runs WHERE id=$1", [id]);
  return rows[0] || null;
}

// ----- shocks (reusable scenario library) -----
export async function listShocks() {
  if (!usePg()) return mem.shocks;
  const { rows } = await pool.query("SELECT * FROM shocks ORDER BY created_at DESC");
  return rows;
}

export async function saveShock({ label, scenario }) {
  if (!usePg()) {
    const row = { id: mem.seq++, label, scenario, created_at: new Date().toISOString() };
    mem.shocks.unshift(row);
    return row;
  }
  const { rows } = await pool.query("INSERT INTO shocks (label, scenario) VALUES ($1,$2) RETURNING *", [label, scenario]);
  return rows[0];
}

export async function deleteShock(id) {
  if (!usePg()) { mem.shocks = mem.shocks.filter((s) => s.id !== Number(id)); return; }
  await pool.query("DELETE FROM shocks WHERE id=$1", [id]);
}

// ─── PREDICTIONS: niches ────────────────────────────────────────

export async function getPredictionNiches() {
  if (!usePg()) {
    // In-memory: return defaults (stateless — last_selected_at always null)
    return DEFAULT_NICHES.map((n, i) => ({ ...n, id: i + 1, is_active: true, last_selected_at: null }));
  }
  const { rows } = await pool.query("SELECT * FROM niche_config ORDER BY sort_order, id");
  return rows;
}

export async function upsertNicheLastSelected(slug) {
  if (!usePg()) return; // no-op in memory
  await pool.query("UPDATE niche_config SET last_selected_at = now() WHERE slug = $1", [slug]);
}

// ─── PREDICTIONS: base-rate library ────────────────────────────

export async function getBaseRate(marketId) {
  if (!usePg()) return mem.base_rates.get(marketId) || null;
  const { rows } = await pool.query("SELECT * FROM base_rate_library WHERE market_id = $1", [marketId]);
  return rows[0] || null;
}

export async function saveBaseRate({ market_id, reference_class, base_rate, rationale, confirmed_by_me, source }) {
  if (!usePg()) {
    mem.base_rates.set(market_id, {
      market_id, reference_class, base_rate, rationale,
      confirmed_by_me: !!confirmed_by_me, source: source || "llm",
      updated_at: new Date().toISOString(),
    });
    return;
  }
  await pool.query(
    `INSERT INTO base_rate_library (market_id, reference_class, base_rate, rationale, confirmed_by_me, source, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (market_id) DO UPDATE SET
       reference_class = EXCLUDED.reference_class,
       base_rate       = EXCLUDED.base_rate,
       rationale       = EXCLUDED.rationale,
       -- once confirmed by user, stay confirmed even if LLM rewrites
       confirmed_by_me = CASE WHEN EXCLUDED.confirmed_by_me THEN true
                              ELSE base_rate_library.confirmed_by_me END,
       source          = EXCLUDED.source,
       updated_at      = now()`,
    [market_id, reference_class, base_rate, rationale, !!confirmed_by_me, source || "llm"]
  );
}

// ─── PREDICTIONS: prediction log ───────────────────────────────

export async function lockPrediction({ market_id, question, venue, my_prob, niche, metadata }) {
  if (!usePg()) {
    const row = {
      id: mem.seq++, market_id, question, venue: venue || "polymarket",
      my_prob, niche, metadata: metadata || null,
      timestamp_locked: new Date().toISOString(),
      resolution_outcome: null, brier_score: null,
    };
    mem.prediction_log.unshift(row);
    mem.prediction_log = mem.prediction_log.slice(0, 500);
    return row;
  }
  const { rows } = await pool.query(
    `INSERT INTO prediction_log (market_id, question, venue, my_prob, niche, metadata)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [market_id, question, venue || "polymarket", my_prob, niche, metadata || null]
  );
  return rows[0];
}

export async function getPredictionLog(niche, limit = 50) {
  if (!usePg()) {
    const log = mem.prediction_log;
    return (niche ? log.filter(r => r.niche === niche) : log).slice(0, limit);
  }
  const { rows } = await pool.query(
    niche
      ? "SELECT * FROM prediction_log WHERE niche=$1 ORDER BY timestamp_locked DESC LIMIT $2"
      : "SELECT * FROM prediction_log ORDER BY timestamp_locked DESC LIMIT $1",
    niche ? [niche, limit] : [limit]
  );
  return rows;
}

// Brier score = (my_prob - outcome)²  — perfect = 0, worst = 1
export async function resolvePrediction(id, outcome) {
  if (!usePg()) {
    const idx = mem.prediction_log.findIndex(r => r.id === Number(id));
    if (idx === -1) return null;
    const entry = mem.prediction_log[idx];
    const brier = Math.pow(entry.my_prob - outcome, 2);
    mem.prediction_log[idx] = { ...entry, resolution_outcome: outcome, brier_score: brier };
    return mem.prediction_log[idx];
  }
  const { rows: existing } = await pool.query("SELECT my_prob FROM prediction_log WHERE id=$1", [id]);
  if (!existing.length) return null;
  const brier = Math.pow(existing[0].my_prob - outcome, 2);
  const { rows } = await pool.query(
    "UPDATE prediction_log SET resolution_outcome=$1, brier_score=$2 WHERE id=$3 RETURNING *",
    [outcome, brier, id]
  );
  return rows[0] || null;
}

// ─── PREDICTIONS: calibration (computed on read, not stored) ────
// Returns bucketed hit-rate data + aggregate Brier for the calibration curve.

export async function getCalibrationData(niche) {
  if (!usePg()) {
    const log = mem.prediction_log.filter(
      r => r.resolution_outcome != null && (niche ? r.niche === niche : true)
    );
    const all = mem.prediction_log.filter(niche ? r => r.niche === niche : () => true);
    const buckets = {};
    for (const r of log) {
      const b = Math.round(r.my_prob * 10) / 10;
      if (!buckets[b]) buckets[b] = { total: 0, hits: 0, brier_sum: 0 };
      buckets[b].total++;
      buckets[b].hits += r.resolution_outcome;
      buckets[b].brier_sum += r.brier_score;
    }
    const curve = Object.entries(buckets)
      .map(([b, v]) => ({
        bucket: parseFloat(b),
        total: v.total,
        hit_rate: v.hits / v.total,
        avg_brier: v.brier_sum / v.total,
      }))
      .sort((a, b) => a.bucket - b.bucket);
    const allBriers = log.map(r => r.brier_score).filter(v => v != null);
    return {
      curve,
      avg_brier_overall: allBriers.length ? allBriers.reduce((s, v) => s + v, 0) / allBriers.length : null,
      total_predictions: all.length,
      resolved_predictions: log.length,
    };
  }

  const params = niche ? [niche] : [];
  const nicheWhere = niche ? "AND niche = $1" : "";

  const { rows: bucketRows } = await pool.query(
    `SELECT
       ROUND(my_prob::numeric * 10) / 10     AS bucket,
       COUNT(*)::int                          AS total,
       SUM(resolution_outcome)::real          AS hits,
       AVG(brier_score)::real                 AS avg_brier
     FROM prediction_log
     WHERE resolution_outcome IS NOT NULL ${nicheWhere}
     GROUP BY bucket
     ORDER BY bucket`,
    params
  );

  const { rows: totals } = await pool.query(
    `SELECT
       COUNT(*)::int                                                        AS total_predictions,
       COUNT(CASE WHEN resolution_outcome IS NOT NULL THEN 1 END)::int     AS resolved_predictions,
       AVG(CASE WHEN resolution_outcome IS NOT NULL THEN brier_score END)::real AS avg_brier_overall
     FROM prediction_log
     ${niche ? "WHERE niche = $1" : ""}`,
    params
  );

  return {
    curve: bucketRows.map(r => ({
      bucket:    parseFloat(r.bucket),
      total:     r.total,
      hit_rate:  r.hits / r.total,
      avg_brier: r.avg_brier,
    })),
    avg_brier_overall:    totals[0]?.avg_brier_overall ?? null,
    total_predictions:    totals[0]?.total_predictions  ?? 0,
    resolved_predictions: totals[0]?.resolved_predictions ?? 0,
  };
}
