// ───────────────────────────────────────────────────────────────
// backend/watchlist.js
// Persistent watchlist — tickers the Haiku motor scans nightly.
//
// In-memory when no DATABASE_URL is set; Postgres when it is.
// Call setPool() from db.js once the pool is ready (same pattern
// as signals-tracker.js).
//
// SCHEMA (added to initDb in db.js):
//   CREATE TABLE IF NOT EXISTS watchlist (
//     ticker    text PRIMARY KEY,
//     added_at  timestamptz NOT NULL DEFAULT now()
//   );
// ───────────────────────────────────────────────────────────────

let pool = null;
const usePg = () => !!pool;

// In-memory fallback
const _mem = new Set();

export function setWatchlistPool(pgPool) {
  pool = pgPool;
}

// Schema SQL exported so db.js can include it in initDb()
export const WATCHLIST_SCHEMA = `
  CREATE TABLE IF NOT EXISTS watchlist (
    ticker    text PRIMARY KEY,
    added_at  timestamptz NOT NULL DEFAULT now()
  );
`;

export async function getWatchlist() {
  if (!usePg()) return [..._mem].map(ticker => ({ ticker }));
  const { rows } = await pool.query(
    "SELECT ticker, added_at FROM watchlist ORDER BY added_at DESC"
  ).catch(() => ({ rows: [] }));
  return rows;
}

export async function addToWatchlist(ticker) {
  const t = ticker.toUpperCase().trim();
  if (!t) return false;
  if (!usePg()) {
    _mem.add(t);
    return true;
  }
  await pool.query(
    "INSERT INTO watchlist (ticker) VALUES ($1) ON CONFLICT DO NOTHING",
    [t]
  ).catch(() => {});
  return true;
}

export async function removeFromWatchlist(ticker) {
  const t = ticker.toUpperCase().trim();
  if (!usePg()) {
    _mem.delete(t);
    return;
  }
  await pool.query("DELETE FROM watchlist WHERE ticker=$1", [t]).catch(() => {});
}

export async function isOnWatchlist(ticker) {
  const t = ticker.toUpperCase().trim();
  if (!usePg()) return _mem.has(t);
  const { rows } = await pool.query(
    "SELECT 1 FROM watchlist WHERE ticker=$1", [t]
  ).catch(() => ({ rows: [] }));
  return rows.length > 0;
}
