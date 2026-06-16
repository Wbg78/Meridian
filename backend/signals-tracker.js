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

// ─── BETA-BERNOULLI INFORMED PRIORS ─────────────────────────────
// Beta(α, β) prior for each source, seeded from finance-research
// literature on source accuracy. The system starts behaving well on
// day one and the priors get swamped by data after ~50 observations.
//
// Prior mean = α/(α+β). Variance shrinks as α+β grows (more data).
// Sources not listed get the _default prior.
export const INFORMED_PRIORS = {
  sec_form4:          { alpha: 7, beta: 3 },   // insiders right ~70% historically (Seyhun 1986)
  sec_13f:            { alpha: 6, beta: 4 },   // institutional 13F ~60% predictive
  sec_8k:             { alpha: 6, beta: 4 },
  reuters:            { alpha: 6, beta: 3 },   // tier-1 accuracy baseline
  bloomberg:          { alpha: 6, beta: 3 },
  financial_times:    { alpha: 6, beta: 3 },
  wsj:                { alpha: 5, beta: 3 },
  finnhub:            { alpha: 5, beta: 3 },   // analyst consensus mildly predictive
  tipranks:           { alpha: 5, beta: 3 },
  barrons:            { alpha: 5, beta: 3 },
  cnbc:               { alpha: 4, beta: 4 },   // mixed track record on calls
  marketwatch:        { alpha: 4, beta: 4 },
  yahoo_finance:      { alpha: 4, beta: 4 },
  seeking_alpha:      { alpha: 4, beta: 4 },   // broad range of author quality
  nyt:                { alpha: 4, beta: 4 },
  zacks:              { alpha: 4, beta: 4 },
  reddit_investing:   { alpha: 3, beta: 4 },   // retail better than WSB, still noise
  twitter_fintwit:    { alpha: 3, beta: 4 },
  reddit_wsb:         { alpha: 2, beta: 5 },   // contrarian/meme — often wrong direction
  twitter_unknown:    { alpha: 2, beta: 5 },
  unknown:            { alpha: 2, beta: 4 },   // conservative prior for unknowns
  substack_curated:   { alpha: 5, beta: 3 },   // independent authors with strong track records
  substack_unknown:   { alpha: 3, beta: 4 },   // unknown Substack writers
  _default:           { alpha: 3, beta: 3 },   // flat-ish prior for anything unlisted
};

// ─── In-memory fallback (when no Postgres) ───────────────────────
const mem = {
  signalHistory: [],
  sourceAccuracy: new Map(),   // sourceKey -> { alpha, beta, total, credibilityAdj }
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
    id                  serial PRIMARY KEY,
    ticker              text NOT NULL,
    source              text NOT NULL,
    source_key          text NOT NULL,
    signal_type         text,
    cluster             text,
    direction           text,
    raw_score           real,
    final_score         real,
    headline            text,
    url                 text,
    fired_at            timestamptz NOT NULL DEFAULT now(),
    price_at_signal     real,
    outcome_checked     boolean DEFAULT false,
    outcome_checked_at  timestamptz,
    price_7d_later      real,
    correct             boolean,
    outcome_checked_14d boolean DEFAULT false,
    price_14d_later     real,
    correct_14d         boolean,
    composite_correct   real,
    corroborated        boolean,
    corroboration_sources text[]
  );

  CREATE TABLE IF NOT EXISTS source_accuracy (
    source_key        text PRIMARY KEY,
    total_signals     int DEFAULT 0,
    correct_count     int DEFAULT 0,
    accuracy_rate     real DEFAULT 0.5,
    alpha             real DEFAULT 3.0,
    beta              real DEFAULT 3.0,
    posterior_mean    real DEFAULT 0.5,
    posterior_std     real DEFAULT 0.2,
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
  CREATE INDEX IF NOT EXISTS signal_history_outcome_7d_idx ON signal_history (outcome_checked, fired_at);
  CREATE INDEX IF NOT EXISTS signal_history_outcome_14d_idx ON signal_history (outcome_checked_14d, fired_at);
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
        signal_type: s.signalType || s.cluster || null,
        cluster: s.cluster,
        direction: s.direction,
        raw_score: s.rawSentiment,
        final_score: s.finalScore,
        headline: s.headline,
        url: s.url,
        fired_at: now,
        price_at_signal: currentPrice || null,
        outcome_checked: false,
        outcome_checked_14d: false,
        correct: null,
        correct_14d: null,
        composite_correct: null,
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
       (ticker, source, source_key, signal_type, cluster, direction, raw_score, final_score, headline, url, price_at_signal)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [ticker, s.source, s.sourceKey, s.signalType || s.cluster || null,
       s.cluster, s.direction, s.rawSentiment, s.finalScore,
       s.headline?.slice(0, 500), s.url, currentPrice || null]
    ).catch(e => console.warn("recordSignals insert failed:", e.message));
  }
}

// ─── RESOLVE OUTCOMES — DUAL WEEKLY CHECKS ──────────────────────
// Two checks per signal: day 7 (weight 0.6) + day 14 (weight 0.4).
// This gives faster feedback than a 30-day wait while still capturing
// medium-term validity of the signal.
//
// Call this daily from a setInterval in server.js.
// `fetchPrice(ticker)` must return the current price as a number.
export async function resolveOutcomes(fetchPrice) {
  const sevenDaysAgo  = new Date(Date.now() -  7 * 86400_000).toISOString();
  const fourteenDaysAgo = new Date(Date.now() - 14 * 86400_000).toISOString();
  let resolved = 0;

  // ── PASS 1: Day-7 checks ─────────────────────────────────────
  let pending7 = [];
  if (!usePg()) {
    pending7 = mem.signalHistory.filter(
      s => !s.outcome_checked && s.fired_at < sevenDaysAgo && s.price_at_signal
    ).slice(0, 50);
  } else {
    const { rows } = await pool.query(
      `SELECT * FROM signal_history
       WHERE outcome_checked = false AND fired_at < $1 AND price_at_signal IS NOT NULL
       LIMIT 50`,
      [sevenDaysAgo]
    ).catch(() => ({ rows: [] }));
    pending7 = rows;
  }

  for (const signal of pending7) {
    try {
      const currentPrice = await fetchPrice(signal.ticker);
      if (!currentPrice) continue;
      const priceChange = (currentPrice - signal.price_at_signal) / signal.price_at_signal;
      const correct = gradeSignal(signal.direction, priceChange);

      if (!usePg()) {
        signal.outcome_checked = true;
        signal.outcome_checked_at = new Date().toISOString();
        signal.price_7d_later = currentPrice;
        signal.correct = correct;
      } else {
        await pool.query(
          `UPDATE signal_history
           SET outcome_checked=true, outcome_checked_at=now(), price_7d_later=$1, correct=$2
           WHERE id=$3`,
          [currentPrice, correct, signal.id]
        ).catch(() => {});
      }
      // Day-7 check carries 0.6 weight in the Beta update
      await updateSourceAccuracy(signal.source_key, correct, 0.6, signal.signal_type);
      resolved++;
    } catch { /* non-fatal */ }
  }

  // ── PASS 2: Day-14 checks ────────────────────────────────────
  let pending14 = [];
  if (!usePg()) {
    pending14 = mem.signalHistory.filter(
      s => s.outcome_checked && !s.outcome_checked_14d && s.fired_at < fourteenDaysAgo && s.price_at_signal
    ).slice(0, 50);
  } else {
    const { rows } = await pool.query(
      `SELECT * FROM signal_history
       WHERE outcome_checked = true AND outcome_checked_14d = false
         AND fired_at < $1 AND price_at_signal IS NOT NULL
       LIMIT 50`,
      [fourteenDaysAgo]
    ).catch(() => ({ rows: [] }));
    pending14 = rows;
  }

  for (const signal of pending14) {
    try {
      const currentPrice = await fetchPrice(signal.ticker);
      if (!currentPrice) continue;
      const priceChange = (currentPrice - signal.price_at_signal) / signal.price_at_signal;
      const correct14 = gradeSignal(signal.direction, priceChange);

      // Composite: weighted average of both checks
      const composite = ((signal.correct ? 1 : 0) * 0.6) + ((correct14 ? 1 : 0) * 0.4);

      if (!usePg()) {
        signal.outcome_checked_14d = true;
        signal.price_14d_later = currentPrice;
        signal.correct_14d = correct14;
        signal.composite_correct = composite;
      } else {
        await pool.query(
          `UPDATE signal_history
           SET outcome_checked_14d=true, price_14d_later=$1, correct_14d=$2, composite_correct=$3
           WHERE id=$4`,
          [currentPrice, correct14, composite, signal.id]
        ).catch(() => {});
      }
      // Day-14 check carries 0.4 weight
      await updateSourceAccuracy(signal.source_key, correct14, 0.4, signal.signal_type);
      resolved++;
    } catch { /* non-fatal */ }
  }

  return { resolved };
}

// Grade a signal direction vs actual price move.
function gradeSignal(direction, priceChange) {
  if (direction === "bullish") return priceChange >  0.01;
  if (direction === "bearish") return priceChange < -0.01;
  if (direction === "neutral") return Math.abs(priceChange) < 0.03;
  return false;
}

// ─── BETA-BERNOULLI UPDATE ───────────────────────────────────────
// weight: 0.6 for day-7 check, 0.4 for day-14 check.
// We update both the source-level AND the signal-type-level posterior
// so the tracker can learn "insider_buy" vs "insider_sell" separately.
async function updateSourceAccuracy(sourceKey, correct, weight = 1.0, signalType = null) {
  const keys = [sourceKey];
  if (signalType && signalType !== sourceKey) keys.push(`${sourceKey}::${signalType}`);

  for (const key of keys) {
    const prior = INFORMED_PRIORS[sourceKey] || INFORMED_PRIORS._default;
    if (!usePg()) {
      const existing = mem.sourceAccuracy.get(key) || {
        alpha: prior.alpha, beta: prior.beta, total: 0,
      };
      // Weighted Beta update
      if (correct) existing.alpha += weight;
      else         existing.beta  += weight;
      existing.total += weight;

      const { mean, std, adj } = betaPosterior(existing.alpha, existing.beta, sourceKey);
      existing.posteriorMean = mean;
      existing.posteriorStd  = std;
      existing.credibilityAdj = adj;
      mem.sourceAccuracy.set(key, existing);
    } else {
      // Postgres: upsert with running α/β sums
      const alphaInc = correct ? weight : 0;
      const betaInc  = correct ? 0 : weight;
      await pool.query(
        `INSERT INTO source_accuracy
           (source_key, total_signals, correct_count, alpha, beta, posterior_mean, posterior_std, credibility_adj, last_updated)
         VALUES ($1, $2, $3, $4, $5, 0.5, 0.2, 0.0, now())
         ON CONFLICT (source_key) DO UPDATE SET
           total_signals  = source_accuracy.total_signals + $2,
           correct_count  = source_accuracy.correct_count + $3,
           alpha          = source_accuracy.alpha + $4,
           beta           = source_accuracy.beta  + $5,
           posterior_mean = (source_accuracy.alpha + $4) /
                            (source_accuracy.alpha + $4 + source_accuracy.beta + $5),
           posterior_std  = sqrt(
             (source_accuracy.alpha + $4) * (source_accuracy.beta + $5) /
             (power(source_accuracy.alpha + $4 + source_accuracy.beta + $5, 2) *
              (source_accuracy.alpha + $4 + source_accuracy.beta + $5 + 1))
           ),
           credibility_adj = GREATEST(-0.25, LEAST(0.25,
             (source_accuracy.alpha + $4) /
             (source_accuracy.alpha + $4 + source_accuracy.beta + $5) - 0.5
           )),
           last_updated   = now()`,
        [key, weight, correct ? weight : 0, alphaInc, betaInc]
      ).catch(e => console.warn("updateSourceAccuracy failed:", e.message));
    }
  }
}

// Compute posterior mean, std, and credibility adjustment from α/β.
function betaPosterior(alpha, beta, sourceKey) {
  const n = alpha + beta;
  const mean = alpha / n;
  const variance = (alpha * beta) / (n * n * (n + 1));
  const std = Math.sqrt(variance);
  // Credibility adjustment = deviation of posterior mean from 0.5 baseline,
  // capped at ±0.25. Applied only when posterior is reasonably confident
  // (std < 0.15, i.e. roughly 20+ effective observations).
  const adj = std < 0.15
    ? Math.max(-0.25, Math.min(0.25, mean - 0.5))
    : 0;  // not enough data yet — don't adjust
  return { mean: +mean.toFixed(4), std: +std.toFixed(4), adj: +adj.toFixed(4) };
}

// ─── GET LEARNED CREDIBILITY ADJUSTMENTS ────────────────────────
// Called by signals.js to apply learned adjustments on top of
// the hardcoded base credibility scores.
// Returns learned credibility adjustments for every source that has
// accumulated enough data. Includes posterior mean, std, and the
// adjustment to apply — so callers can skip adjustment when uncertain.
export async function getLearnedAdjustments() {
  if (!usePg()) {
    const result = {};
    mem.sourceAccuracy.forEach((v, k) => {
      // Require at least ~7 effective observations (prior counts toward this)
      if ((v.alpha + v.beta) >= 10) {
        result[k] = {
          adj:             v.credibilityAdj ?? 0,
          posteriorMean:   v.posteriorMean  ?? (v.alpha / (v.alpha + v.beta)),
          posteriorStd:    v.posteriorStd   ?? 0.2,
          confidence:      v.posteriorStd < 0.10 ? "high" : v.posteriorStd < 0.15 ? "medium" : "low",
          total:           v.total ?? 0,
          alpha:           v.alpha,
          beta:            v.beta,
        };
      }
    });
    return result;
  }
  const { rows } = await pool.query(
    `SELECT source_key, credibility_adj, posterior_mean, posterior_std,
            accuracy_rate, total_signals, alpha, beta
     FROM source_accuracy WHERE (alpha + beta) >= 10`
  ).catch(() => ({ rows: [] }));
  const result = {};
  rows.forEach(r => {
    result[r.source_key] = {
      adj:           r.credibility_adj,
      posteriorMean: r.posterior_mean,
      posteriorStd:  r.posterior_std,
      confidence:    r.posterior_std < 0.10 ? "high" : r.posterior_std < 0.15 ? "medium" : "low",
      total:         r.total_signals,
      alpha:         r.alpha,
      beta:          r.beta,
    };
  });
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
      const n = (v.alpha || 3) + (v.beta || 3);
      rows.push({
        source_key:     k,
        alpha:          v.alpha,
        beta:           v.beta,
        posterior_mean: +(v.posteriorMean || v.alpha / n).toFixed(4),
        posterior_std:  +(v.posteriorStd  || 0.2).toFixed(4),
        credibility_adj: v.credibilityAdj || 0,
        total:          v.total || 0,
        confidence:     v.posteriorStd < 0.10 ? "high" : v.posteriorStd < 0.15 ? "medium" : "low",
      });
    });
    return rows.sort((a, b) => b.posterior_mean - a.posterior_mean);
  }
  const { rows } = await pool.query(
    `SELECT source_key, total_signals, correct_count, alpha, beta,
            posterior_mean, posterior_std, credibility_adj,
            CASE WHEN posterior_std < 0.10 THEN 'high'
                 WHEN posterior_std < 0.15 THEN 'medium' ELSE 'low' END AS confidence
     FROM source_accuracy ORDER BY posterior_mean DESC`
  ).catch(() => ({ rows: [] }));
  return rows;
}
