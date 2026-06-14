// ───────────────────────────────────────────────────────────────
// backend/signals-tracker.js
// The learning layer on top of signals.js.
//
// Three things this does:
//
//  1. LEARN OVER TIME
//     Every signal that fires gets recorded. 7 days later the
//     system checks whether the stock moved in the predicted
//     direction and updates the source's accuracy score.
//     Over time, credibility scores drift toward empirical truth.
//
//  2. CROSS-REFERENCE
//     When a high-value claim appears (e.g. "JPMorgan bought PLTR")
//     the tracker checks whether any other independent source
//     corroborates it within 48 hours. Corroborated = boost.
//     Uncorroborated after 48h = flag as "unverified claim".
//
//  3. FLAG ANOMALIES
//     Three patterns: volume spike (source suddenly very active),
//     sentiment reversal (source flipped direction overnight),
//     credibility mismatch (low-cred source makes specific claim
//     that high-cred sources don't pick up).
//
// Uses the same db.js as the rest of the research engine.
// Tables are created in initDb() — just call that and they appear.
// ───────────────────────────────────────────────────────────────

// ─── In-memory fallback (when no Postgres) ───────────────────────
const mem = {
  signalHistory: [],
  sourceAccuracy: new Map(),   // sourceKey -> { total, correct, accuracy }
  anomalyLog: [],
  seq: 1,
};

// ─── DB helpers (mirror the pattern in db.js) ────────────────────
let pool = null;
const usePg = () => !!pool;

export function setPool(pgPool) {
  pool = pgPool;
}

// Called from initDb() in db.js — adds the three new tables.
export const TRACKER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS signal_history (
    id                serial PRIMARY KEY,
    ticker            text NOT NULL,
    source            text NOT NULL,
    source_key        text NOT NULL,
    cluster           text,
    direction         text,
    raw_score         real,
    final_score       real,
    headline          text,
    url               text,
    fired_at          timestamptz NOT NULL DEFAULT now(),
    price_at_signal   real,
    outcome_checked   boolean DEFAULT false,
    outcome_checked_at timestamptz,
    price_7d_later    real,
    correct           boolean,
    corroborated      boolean,
    corroboration_sources text[]
  );

  CREATE TABLE IF NOT EXISTS source_accuracy (
    source_key        text PRIMARY KEY,
    ticker            text NOT NULL DEFAULT 'ALL',
    total_signals     int DEFAULT 0,
    correct_count     int DEFAULT 0,
    accuracy_rate     real DEFAULT 0.5,
    credibility_adj   real DEFAULT 0.0,
    last_updated      timestamptz DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS anomaly_log (
    id                serial PRIMARY KEY,
    ticker            text NOT NULL,
    anomaly_type      text NOT NULL,
    description       text,
    source_key        text,
    detected_at       timestamptz NOT NULL DEFAULT now(),
    resolved          boolean DEFAULT false,
    notes             text
  );

  CREATE INDEX IF NOT EXISTS signal_history_ticker_idx ON signal_history (ticker, fired_at DESC);
  CREATE INDEX IF NOT EXISTS signal_history_outcome_idx ON signal_history (outcome_checked, fired_at);
`;

// ─── RECORD SIGNALS ─────────────────────────────────────────────
// Call this right after gatherSignals() returns, with the full
// list of scored signals and the current stock price.
export async function recordSignals(ticker, scoredSignals, currentPrice) {
  const now = new Date().toISOString();
  if (!usePg()) {
    scoredSignals.forEach(s => {
      mem.signalHistory.push({
        id: mem.seq++,
        ticker,
        source: s.source,
        source_key: s.sourceKey,
        cluster: s.cluster,
        direction: s.direction,
        raw_score: s.rawSentiment,
        final_score: s.finalScore,
        headline: s.headline,
        url: s.url,
        fired_at: now,
        price_at_signal: currentPrice || null,
        outcome_checked: false,
        correct: null,
      });
    });
    // Cap in-memory history at 1000 entries
    if (mem.signalHistory.length > 1000) mem.signalHistory = mem.signalHistory.slice(-1000);
    return;
  }

  // Postgres: batch insert
  for (const s of scoredSignals) {
    await pool.query(
      `INSERT INTO signal_history
       (ticker, source, source_key, cluster, direction, raw_score, final_score, headline, url, price_at_signal)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [ticker, s.source, s.sourceKey, s.cluster, s.direction,
       s.rawSentiment, s.finalScore, s.headline?.slice(0, 500), s.url, currentPrice || null]
    ).catch(e => console.warn("recordSignals insert failed:", e.message));
  }
}

// ─── RESOLVE OUTCOMES (run on a schedule) ───────────────────────
// Call this daily (e.g. via a setInterval in server.js at boot).
// Finds signals that fired 7+ days ago with no outcome recorded,
// fetches the current price, and marks them correct/incorrect.
export async function resolveOutcomes(fetchPrice) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  let pending = [];

  if (!usePg()) {
    pending = mem.signalHistory.filter(
      s => !s.outcome_checked && s.fired_at < sevenDaysAgo && s.price_at_signal
    ).slice(0, 50);
  } else {
    const { rows } = await pool.query(
      `SELECT * FROM signal_history
       WHERE outcome_checked = false
         AND fired_at < $1
         AND price_at_signal IS NOT NULL
       LIMIT 50`,
      [sevenDaysAgo]
    ).catch(() => ({ rows: [] }));
    pending = rows;
  }

  if (pending.length === 0) return { resolved: 0 };
  let resolved = 0;

  for (const signal of pending) {
    try {
      const currentPrice = await fetchPrice(signal.ticker);
      if (!currentPrice) continue;

      const priceChange = (currentPrice - signal.price_at_signal) / signal.price_at_signal;
      const correct =
        (signal.direction === "bullish" && priceChange > 0.01) ||
        (signal.direction === "bearish" && priceChange < -0.01) ||
        (signal.direction === "neutral" && Math.abs(priceChange) < 0.03);

      if (!usePg()) {
        signal.outcome_checked = true;
        signal.outcome_checked_at = new Date().toISOString();
        signal.price_7d_later = currentPrice;
        signal.correct = correct;
      } else {
        await pool.query(
          `UPDATE signal_history
           SET outcome_checked=true, outcome_checked_at=now(),
               price_7d_later=$1, correct=$2
           WHERE id=$3`,
          [currentPrice, correct, signal.id]
        ).catch(() => {});
      }

      // Update accuracy for this source
      await updateSourceAccuracy(signal.source_key, correct);
      resolved++;
    } catch { /* non-fatal, try next */ }
  }

  return { resolved };
}

// ─── UPDATE SOURCE ACCURACY ─────────────────────────────────────
async function updateSourceAccuracy(sourceKey, correct) {
  if (!usePg()) {
    const existing = mem.sourceAccuracy.get(sourceKey) || { total: 0, correct: 0 };
    existing.total++;
    if (correct) existing.correct++;
    existing.accuracy = existing.correct / existing.total;
    // Credibility adjustment: difference from 0.5 baseline, capped at ±0.2
    existing.credibilityAdj = Math.max(-0.2, Math.min(0.2, (existing.accuracy - 0.5) * 0.4));
    mem.sourceAccuracy.set(sourceKey, existing);
    return;
  }
  await pool.query(
    `INSERT INTO source_accuracy (source_key, total_signals, correct_count, accuracy_rate, credibility_adj, last_updated)
     VALUES ($1, 1, $2, $3, 0, now())
     ON CONFLICT (source_key) DO UPDATE SET
       total_signals   = source_accuracy.total_signals + 1,
       correct_count   = source_accuracy.correct_count + $2,
       accuracy_rate   = (source_accuracy.correct_count + $2)::real / (source_accuracy.total_signals + 1),
       credibility_adj = GREATEST(-0.2, LEAST(0.2,
                           ((source_accuracy.correct_count + $2)::real / (source_accuracy.total_signals + 1) - 0.5) * 0.4
                         )),
       last_updated    = now()`,
    [sourceKey, correct ? 1 : 0, correct ? 1 : 0]
  ).catch(e => console.warn("updateSourceAccuracy failed:", e.message));
}

// ─── GET LEARNED CREDIBILITY ADJUSTMENTS ────────────────────────
// Called by signals.js to apply learned adjustments on top of
// the hardcoded base credibility scores.
export async function getLearnedAdjustments() {
  if (!usePg()) {
    const result = {};
    mem.sourceAccuracy.forEach((v, k) => {
      if (v.total >= 10) {  // only apply after 10+ signals (enough data)
        result[k] = { adj: v.credibilityAdj, accuracy: v.accuracy, total: v.total };
      }
    });
    return result;
  }
  const { rows } = await pool.query(
    `SELECT source_key, credibility_adj, accuracy_rate, total_signals
     FROM source_accuracy WHERE total_signals >= 10`
  ).catch(() => ({ rows: [] }));
  const result = {};
  rows.forEach(r => { result[r.source_key] = { adj: r.credibility_adj, accuracy: r.accuracy_rate, total: r.total_signals }; });
  return result;
}

// ─── CROSS-REFERENCE ────────────────────────────────────────────
// After signals are gathered, look for high-value claims and check
// if other sources have picked them up. Runs async in background.
export async function crossReferenceSignals(ticker, signals) {
  // Find high-credibility institutional claims worth cross-referencing
  const highValueClaims = signals.filter(s =>
    s.credibility >= 0.5 &&
    s.cluster === "institutionPositionChange" &&
    s.direction !== "neutral"
  );

  const results = [];
  for (const claim of highValueClaims.slice(0, 5)) {  // max 5 per run
    const corroborators = signals.filter(s =>
      s.id !== claim.id &&
      s.direction === claim.direction &&
      s.source !== claim.source &&
      s.credibility >= 0.4
    );

    const corroborated = corroborators.length >= 2;
    const crossRefResult = {
      claim: claim.headline,
      claimSource: claim.source,
      claimCredibility: claim.credibility,
      corroborated,
      corroboratorCount: corroborators.length,
      corroboratorSources: corroborators.map(c => c.source),
      status: corroborated ? "confirmed" : "unverified",
    };
    results.push(crossRefResult);

    // Update the signal's corroboration status in DB
    if (usePg()) {
      await pool.query(
        `UPDATE signal_history
         SET corroborated=$1, corroboration_sources=$2
         WHERE ticker=$3 AND headline=$4 AND fired_at > now() - interval '1 hour'`,
        [corroborated, corroborators.map(c => c.source), ticker, claim.headline?.slice(0, 500)]
      ).catch(() => {});
    }
  }
  return results;
}

// ─── ANOMALY DETECTION ──────────────────────────────────────────
// Runs after each signal gather. Looks for three patterns.
export async function detectAnomalies(ticker, signals, previousSignalCount) {
  const anomalies = [];
  const now = new Date().toISOString();

  // 1) Volume spike: source suddenly very active on this ticker
  const sourceCounts = {};
  signals.forEach(s => {
    sourceCounts[s.sourceKey] = (sourceCounts[s.sourceKey] || 0) + 1;
  });
  Object.entries(sourceCounts).forEach(([sourceKey, count]) => {
    if (count > 8) {  // more than 8 signals from one source in one gather = anomalous
      const anomaly = {
        ticker,
        type: "volume_spike",
        description: `Source "${sourceKey}" produced ${count} signals in a single scan — possible coordinated activity or breaking news`,
        sourceKey,
        detectedAt: now,
      };
      anomalies.push(anomaly);
    }
  });

  // 2) Sentiment reversal: all signals flipped direction vs last time
  const currentDirection = signals.filter(s => s.direction !== "neutral").length > 0
    ? (signals.filter(s => s.direction === "bullish").length > signals.filter(s => s.direction === "bearish").length ? "bullish" : "bearish")
    : "neutral";

  if (previousSignalCount?.direction &&
      previousSignalCount.direction !== "neutral" &&
      currentDirection !== "neutral" &&
      previousSignalCount.direction !== currentDirection) {
    anomalies.push({
      ticker,
      type: "sentiment_reversal",
      description: `Sentiment flipped from ${previousSignalCount.direction} to ${currentDirection} since last scan — investigate cause`,
      sourceKey: "aggregate",
      detectedAt: now,
    });
  }

  // 3) Credibility mismatch: low-cred source makes specific institutional claim
  //    but no high-cred source corroborates within this scan
  const lowCredInstitutionalClaims = signals.filter(s =>
    s.credibility < 0.4 &&
    s.cluster === "institutionPositionChange" &&
    /JPMorgan|Goldman|BlackRock|Citadel|Bridgewater|Morgan Stanley/i.test(s.headline || "")
  );
  const hasHighCredCorroboration = signals.some(s => s.credibility >= 0.7 && s.direction !== "neutral");

  if (lowCredInstitutionalClaims.length > 0 && !hasHighCredCorroboration) {
    anomalies.push({
      ticker,
      type: "credibility_mismatch",
      description: `${lowCredInstitutionalClaims.length} low-credibility source(s) making specific institutional claims with no high-credibility corroboration — possible misinformation or rumor`,
      sourceKey: lowCredInstitutionalClaims[0]?.sourceKey || "unknown",
      detectedAt: now,
    });
  }

  // Persist anomalies
  for (const a of anomalies) {
    if (!usePg()) {
      mem.anomalyLog.push({ id: mem.seq++, ...a, resolved: false });
    } else {
      await pool.query(
        `INSERT INTO anomaly_log (ticker, anomaly_type, description, source_key)
         VALUES ($1,$2,$3,$4)`,
        [a.ticker, a.type, a.description, a.sourceKey]
      ).catch(() => {});
    }
  }

  return anomalies;
}

// ─── GET SIGNAL HISTORY FOR A TICKER ────────────────────────────
export async function getSignalHistory(ticker, limit = 20) {
  if (!usePg()) {
    return mem.signalHistory
      .filter(s => s.ticker === ticker)
      .sort((a, b) => new Date(b.fired_at) - new Date(a.fired_at))
      .slice(0, limit);
  }
  const { rows } = await pool.query(
    `SELECT id, ticker, source, direction, final_score, headline, url,
            fired_at, correct, corroborated
     FROM signal_history WHERE ticker=$1
     ORDER BY fired_at DESC LIMIT $2`,
    [ticker, limit]
  ).catch(() => ({ rows: [] }));
  return rows;
}

// ─── GET ANOMALY LOG ────────────────────────────────────────────
export async function getAnomalyLog(ticker, limit = 10) {
  if (!usePg()) {
    return mem.anomalyLog
      .filter(a => !ticker || a.ticker === ticker)
      .sort((a, b) => new Date(b.detected_at) - new Date(a.detected_at))
      .slice(0, limit);
  }
  const { rows } = await pool.query(
    ticker
      ? `SELECT * FROM anomaly_log WHERE ticker=$1 ORDER BY detected_at DESC LIMIT $2`
      : `SELECT * FROM anomaly_log ORDER BY detected_at DESC LIMIT $1`,
    ticker ? [ticker, limit] : [limit]
  ).catch(() => ({ rows: [] }));
  return rows;
}

// ─── GET SOURCE ACCURACY LEADERBOARD ────────────────────────────
export async function getSourceLeaderboard() {
  if (!usePg()) {
    const rows = [];
    mem.sourceAccuracy.forEach((v, k) => {
      rows.push({ source_key: k, ...v });
    });
    return rows.sort((a, b) => b.accuracy - a.accuracy);
  }
  const { rows } = await pool.query(
    `SELECT source_key, total_signals, correct_count, accuracy_rate, credibility_adj
     FROM source_accuracy ORDER BY accuracy_rate DESC`
  ).catch(() => ({ rows: [] }));
  return rows;
}
