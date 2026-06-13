// ───────────────────────────────────────────────────────────────
// backend/db.js
// Persistence for the research engine.
//
// Uses Postgres when DATABASE_URL is set (Railway gives you one the
// moment you add the Postgres plugin) and falls back to in-memory maps
// otherwise — so the app still runs locally with ZERO setup, exactly
// like the rest of Meridian.
//
// Three things persist:
//   ontologies — the entity graph per ticker (build once, shock cheaply)
//   runs       — every crisis analysis, for history
//   shocks     — a reusable scenario library (the saved-scenarios drawer)
//
// `pg` is imported lazily, so you only need it installed if you actually
// point DATABASE_URL at a database.
// ───────────────────────────────────────────────────────────────

const HAS_DB = !!process.env.DATABASE_URL;
let pool = null;
const usePg = () => HAS_DB && pool;

// ----- in-memory fallback -----
const mem = {
  ontologies: new Map(), // ticker -> row
  runs: [],
  shocks: [],
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
    console.log("✅ Research DB ready (Postgres).");
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
