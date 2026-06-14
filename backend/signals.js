// ───────────────────────────────────────────────────────────────
// backend/signals.js
// Meridian Signal Extraction Engine
//
// Pulls institutional positioning signals from four free sources:
//   1. SEC EDGAR Form 4  (insider transactions — ground truth)
//   2. NewsAPI           (financial news — keyword filtered)
//   3. Reddit PRAW       (retail sentiment + corroboration)
//   4. Finnhub           (analyst upgrades/downgrades)
//
// Every signal gets:
//   - Source credibility score    (what type of source is it?)
//   - Political bias correction   (does this outlet lean a direction?)
//   - Temporal decay weight       (how fresh is it?)
//   - Engagement weight           (how many people saw/agreed?)
//   - Corroboration multiplier    (do other sources confirm it?)
//
// Output: a clean, weighted PositioningSignal object that gets
// injected into the ontology graph — Claude never sees raw tweets
// or Reddit posts, only the aggregated summary.
//
// Add to backend/.env:
//   NEWS_API_KEY=your_newsapi_key        (free at newsapi.org)
//   FINNHUB_KEY=your_finnhub_key         (free at finnhub.io)
//   REDDIT_CLIENT_ID=your_reddit_app_id  (free at reddit.com/prefs/apps)
//   REDDIT_CLIENT_SECRET=your_reddit_secret
// ───────────────────────────────────────────────────────────────

// ─── KEYWORD CLUSTERS ───────────────────────────────────────────
// Grouped by signal type. Each cluster is searched independently
// then weighted by its signal strength category.
export const KEYWORD_CLUSTERS = {

  // Highest value — specific institution + action
  institutionPositionChange: [
    "increased stake", "reduced position", "new position",
    "exited position", "added shares", "trimmed holdings",
    "13F filing", "13G filing", "13D filing",
    "BlackRock position", "Vanguard position", "Citadel position",
    "Bridgewater position", "Morgan Stanley position",
    "Goldman Sachs position", "JPMorgan position",
    "Soros position", "Druckenmiller position",
    "ARK invest", "activist investor",
  ],

  // Aggressive moves — high urgency signals
  aggressiveMoves: [
    "short attack", "short seller report", "short interest spike",
    "unusual options activity", "unusual call options",
    "unusual put options", "block trade", "dark pool",
    "massive call sweep", "put spread", "bear put spread",
    "gamma squeeze", "short squeeze", "forced liquidation",
    "margin call", "concentrated bet",
  ],

  // Analyst moves — institutions follow these
  analystMoves: [
    "price target raised", "price target cut", "price target increased",
    "upgraded to buy", "downgraded to sell", "downgraded to hold",
    "initiating coverage", "outperform rating", "underperform rating",
    "overweight rating", "underweight rating", "neutral rating",
    "strong buy", "strong sell", "consensus upgrade",
    "analyst consensus", "wall street consensus",
  ],

  // Insider activity — legally disclosed, ground truth
  insiderActivity: [
    "insider buying", "insider selling", "insider purchase",
    "CEO purchased", "CFO sold", "director bought",
    "executive selling", "Form 4 filing", "10b5-1 plan",
    "open market purchase", "stock grant", "option exercise",
  ],

  // Capital flow signals — passive money movement
  capitalFlow: [
    "ETF inflows", "ETF outflows", "fund flows",
    "passive buying", "index inclusion", "index exclusion",
    "rebalancing", "institutional ownership increased",
    "institutional ownership decreased", "float percentage",
    "ownership concentration", "hedge fund buying",
    "mutual fund selling", "pension fund",
  ],

  // Sentiment shift — consensus changing
  sentimentShift: [
    "wall street bullish", "wall street bearish",
    "sentiment shift", "narrative change", "thesis change",
    "re-rating", "multiple expansion", "multiple compression",
    "sentiment divergence", "contrarian bet",
    "consensus too bearish", "consensus too bullish",
  ],

};

// ─── SOURCE CREDIBILITY TIERS ────────────────────────────────────
// Base credibility before bias and engagement adjustments.
// Scale: 0.0 (worthless) to 1.0 (ground truth)
const SOURCE_CREDIBILITY = {
  // Legal filings — ground truth, cannot be faked
  sec_form4:        1.00,
  sec_13f:          1.00,
  sec_8k:           0.95,

  // Tier 1 financial outlets — professional journalists, editors
  reuters:          0.90,
  bloomberg:        0.90,
  financial_times:  0.88,
  wsj:              0.85,
  ft:               0.88,

  // Tier 2 financial outlets — good but more opinion
  cnbc:             0.72,
  marketwatch:      0.70,
  barrons:          0.75,
  seeking_alpha:    0.55,  // mix of professionals and retail
  motley_fool:      0.50,

  // Tier 3 — general news with financial coverage
  nyt:              0.65,
  washington_post:  0.63,
  guardian:         0.60,
  fox_business:     0.58,
  yahoo_finance:    0.60,

  // Analyst platforms
  finnhub:          0.80,
  tipranks:         0.75,
  zacks:            0.65,

  // Social — corroboration value, not primary signal
  reddit_investing: 0.35,
  reddit_wsb:       0.20,  // high noise, occasionally early
  twitter_fintwit:  0.40,  // known accounts tracked separately
  twitter_unknown:  0.10,

  // Default for unknown sources
  unknown:          0.25,
};

// ─── POLITICAL BIAS CORRECTION ───────────────────────────────────
// Financial news outlets have political lean that affects HOW they
// frame corporate/regulatory/macro news. This doesn't mean they're
// wrong — it means their framing can systematically skew sentiment
// scores for certain types of stories.
//
// Bias scale: -1.0 (hard left) to +1.0 (hard right)
// Bias TYPES that matter for investing:
//   - regulatory_bias: how they frame government/regulatory action
//   - corporate_bias:  how they frame corporate earnings/news
//   - macro_bias:      how they frame Fed, rates, economic policy
//
// Source: Media Bias Chart + Ad Fontes Media ratings
const POLITICAL_BIAS = {
  reuters:          { lean: 0.0,  regulatory: 0.0,  corporate:  0.0,  macro: 0.0  }, // center
  bloomberg:        { lean: 0.1,  regulatory: 0.1,  corporate:  0.2,  macro: 0.1  }, // center-right, pro-business
  financial_times:  { lean: 0.1,  regulatory: 0.0,  corporate:  0.2,  macro: 0.1  }, // center, pro-market
  wsj:              { lean: 0.3,  regulatory: 0.4,  corporate:  0.3,  macro: 0.3  }, // center-right, pro-corporate
  cnbc:             { lean: 0.1,  regulatory: 0.0,  corporate:  0.3,  macro: 0.1  }, // center, very pro-market
  nyt:              { lean: -0.3, regulatory: -0.3, corporate: -0.2,  macro: -0.2 }, // center-left
  washington_post:  { lean: -0.3, regulatory: -0.3, corporate: -0.2,  macro: -0.2 }, // center-left
  guardian:         { lean: -0.5, regulatory: -0.5, corporate: -0.4,  macro: -0.4 }, // left
  fox_business:     { lean: 0.5,  regulatory: 0.5,  corporate:  0.4,  macro: 0.5  }, // right, very pro-corporate
  marketwatch:      { lean: 0.0,  regulatory: 0.0,  corporate:  0.1,  macro: 0.0  }, // center
  barrons:          { lean: 0.2,  regulatory: 0.2,  corporate:  0.3,  macro: 0.2  }, // center-right, pro-investor
  seeking_alpha:    { lean: 0.1,  regulatory: 0.1,  corporate:  0.2,  macro: 0.1  }, // slightly pro-corporate
  yahoo_finance:    { lean: 0.0,  regulatory: 0.0,  corporate:  0.0,  macro: 0.0  }, // neutral aggregator
  unknown:          { lean: 0.0,  regulatory: 0.0,  corporate:  0.0,  macro: 0.0  },
};

// Determine what type of story this is so we apply the right bias correction
function detectStoryType(text) {
  const t = text.toLowerCase();
  if (/regulat|antitrust|sec |ftc|doj|government contract|legislation|policy/.test(t)) return "regulatory";
  if (/earnings|revenue|profit|margin|guidance|beat|miss|quarterly/.test(t)) return "corporate";
  if (/fed|rate|inflation|gdp|recession|monetary|fiscal|treasury/.test(t)) return "macro";
  return "corporate"; // default
}

// Apply bias correction to a raw sentiment score
// If a right-leaning outlet reports negative sentiment on a regulatory story,
// it might be exaggerating the negativity (because they're anti-regulation),
// so we pull the sentiment back toward center.
function applyBiasCorrection(sentimentScore, sourceKey, storyType) {
  const bias = POLITICAL_BIAS[sourceKey] || POLITICAL_BIAS.unknown;
  const biasMagnitude = bias[storyType] || bias.lean;

  // The correction logic:
  // If sentiment is negative AND source leans right on this story type
  // → right-leaning sources amplify negative regulatory/corporate news less
  // → left-leaning sources amplify it more
  // We pull back toward center proportionally to bias magnitude
  const correctionFactor = 0.15; // how much bias can shift the score
  const correction = biasMagnitude * correctionFactor;

  // Apply: if source has strong lean, dampen the sentiment in that direction
  const corrected = sentimentScore - (sentimentScore * Math.abs(correction) * Math.sign(biasMagnitude));
  return Math.max(-1, Math.min(1, corrected));
}

// ─── TEMPORAL DECAY ─────────────────────────────────────────────
// Fresh signals matter more than old ones.
function temporalWeight(publishedAt) {
  if (!publishedAt) return 0.3;
  const ageHours = (Date.now() - new Date(publishedAt).getTime()) / 3600000;
  if (ageHours < 6)   return 1.00;  // breaking — maximum weight
  if (ageHours < 24)  return 0.90;  // today
  if (ageHours < 48)  return 0.75;  // yesterday
  if (ageHours < 72)  return 0.60;  // 3 days
  if (ageHours < 168) return 0.40;  // this week
  if (ageHours < 336) return 0.20;  // 2 weeks
  return 0.10;                       // old news
}

// ─── ENGAGEMENT WEIGHT ──────────────────────────────────────────
// More engagement = more people saw it = signal has spread further
function engagementWeight(engagement = 0) {
  if (engagement > 10000) return 1.0;
  if (engagement > 1000)  return 0.8;
  if (engagement > 100)   return 0.6;
  if (engagement > 10)    return 0.4;
  return 0.2;
}

// ─── RESOLVE SOURCE KEY ─────────────────────────────────────────
function resolveSourceKey(sourceName = "") {
  const s = sourceName.toLowerCase().replace(/[^a-z_]/g, "");
  if (s.includes("reuters"))    return "reuters";
  if (s.includes("bloomberg"))  return "bloomberg";
  if (s.includes("financialtimes") || s.includes("ft")) return "financial_times";
  if (s.includes("wsj") || s.includes("wallstreet")) return "wsj";
  if (s.includes("cnbc"))       return "cnbc";
  if (s.includes("nyt") || s.includes("newyorktimes")) return "nyt";
  if (s.includes("washingtonpost")) return "washington_post";
  if (s.includes("guardian"))   return "guardian";
  if (s.includes("foxbusiness") || s.includes("fox")) return "fox_business";
  if (s.includes("marketwatch")) return "marketwatch";
  if (s.includes("barrons"))    return "barrons";
  if (s.includes("seekingalpha")) return "seeking_alpha";
  if (s.includes("yahoo"))      return "yahoo_finance";
  if (s.includes("reddit"))     return "reddit_investing";
  if (s.includes("finnhub"))    return "finnhub";
  return "unknown";
}

// ─── CORROBORATION DETECTION ─────────────────────────────────────
// If multiple independent sources report the same thing,
// multiply the signal strength. This is the key insight:
// one tweet is noise; Reuters + Reddit + SEC all saying the
// same thing is a very strong signal.
function applyCorroborationMultiplier(signals) {
  const directions = signals.map(s => s.direction);
  const bullCount = directions.filter(d => d === "bullish").length;
  const bearCount = directions.filter(d => d === "bearish").length;
  const total = signals.length;

  // How corroborated is the dominant direction?
  const dominantCount = Math.max(bullCount, bearCount);
  const corroborationRatio = dominantCount / Math.max(total, 1);

  // Multiplier: fully corroborated = 1.5x, fully contradicted = 0.5x
  if (corroborationRatio > 0.8) return 1.5;   // 80%+ agreement
  if (corroborationRatio > 0.6) return 1.2;   // 60%+ agreement
  if (corroborationRatio > 0.4) return 1.0;   // mixed
  return 0.7;                                  // mostly contradicted = lower confidence
}

// ─── COMPUTE FINAL SIGNAL SCORE ─────────────────────────────────
function computeSignalScore(raw) {
  const sourceKey = resolveSourceKey(raw.source);
  const credibility = SOURCE_CREDIBILITY[sourceKey] || SOURCE_CREDIBILITY.unknown;
  const storyType = detectStoryType(raw.text || raw.headline || "");
  const rawSentiment = raw.sentiment ?? (raw.direction === "bullish" ? 0.7 : raw.direction === "bearish" ? -0.7 : 0);
  const correctedSentiment = applyBiasCorrection(rawSentiment, sourceKey, storyType);
  const temporal = temporalWeight(raw.publishedAt || raw.datetime);
  const engagement = engagementWeight(raw.engagement || raw.upvotes || raw.likes || 0);

  // Final score = sentiment × credibility × temporal × engagement
  const score = correctedSentiment * credibility * temporal * engagement;

  return {
    source: raw.source || "unknown",
    sourceKey,
    headline: raw.headline || raw.title || raw.text?.slice(0, 120) || "",
    url: raw.url || null,
    rawSentiment: +rawSentiment.toFixed(3),
    correctedSentiment: +correctedSentiment.toFixed(3),
    biasApplied: +(rawSentiment - correctedSentiment).toFixed(3),
    storyType,
    credibility,
    temporalWeight: +temporal.toFixed(2),
    engagementWeight: +engagement.toFixed(2),
    finalScore: +score.toFixed(4),
    direction: correctedSentiment > 0.15 ? "bullish" : correctedSentiment < -0.15 ? "bearish" : "neutral",
    publishedAt: raw.publishedAt || raw.datetime || null,
    cluster: raw.cluster || "general",
  };
}

// ─── SOURCE 1: SEC EDGAR Form 4 (insider transactions) ──────────
// Free, real-time, legally required. Highest credibility signals.
const SEC_UA = process.env.SEC_USER_AGENT || "Meridian/1.0 set-your-email@example.com";

async function fetchInsiderTransactions(ticker) {
  try {
    // Use the SEC full-text search for Form 4 filings
    const r = await fetch(
      `https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(ticker)}%22&dateRange=custom&startdt=${daysAgo(30)}&enddt=${today()}&forms=4`,
      { headers: { "User-Agent": SEC_UA } }
    );
    if (!r.ok) return [];
    const data = await r.json();
    const hits = data.hits?.hits || [];

    return hits.slice(0, 10).map(h => ({
      source: "SEC Form 4",
      headline: `Insider transaction: ${h._source?.entity_name || ticker} — ${h._source?.file_date}`,
      url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${ticker}&type=4&dateb=&owner=include&count=10`,
      sentiment: detectInsiderSentiment(h._source?.period_of_report, h._source?.form_type),
      publishedAt: h._source?.file_date,
      engagement: 0,
      cluster: "insiderActivity",
      direction: null, // computed in detectInsiderSentiment
    }));
  } catch { return []; }
}

function detectInsiderSentiment(period, formType) {
  // Form 4 with purchase = bullish, sale = bearish
  // We return a score and let computeSignalScore handle it
  // Note: in a full impl you'd parse the actual XML for transaction type
  return 0; // neutral default until XML parsing is implemented
}

// ─── SOURCE 2: NewsAPI ──────────────────────────────────────────
async function fetchNewsSignals(ticker, clusters) {
  const key = process.env.NEWS_API_KEY;
  if (!key) { console.warn("NEWS_API_KEY not set — skipping NewsAPI"); return []; }

  const allSignals = [];
  // Build one query per cluster (parallel fetches)
  const queries = Object.entries(clusters).slice(0, 4).map(([clusterName, keywords]) => {
    // Pick 3 most specific keywords from the cluster
    const topKeywords = keywords.slice(0, 3).join(" OR ");
    const query = `(${topKeywords}) AND ${ticker}`;
    return fetch(
      `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&language=en&sortBy=publishedAt&pageSize=10&from=${daysAgo(7)}`,
      { headers: { "X-Api-Key": key } }
    )
      .then(r => r.ok ? r.json() : { articles: [] })
      .then(data => (data.articles || []).map(a => ({
        source: a.source?.name || "unknown",
        headline: a.title || "",
        url: a.url,
        text: (a.title || "") + " " + (a.description || ""),
        sentiment: null, // will be inferred from text
        publishedAt: a.publishedAt,
        engagement: 0,
        cluster: clusterName,
      })))
      .catch(() => []);
  });

  const results = await Promise.all(queries);
  results.forEach(batch => allSignals.push(...batch));
  return allSignals;
}

// ─── SOURCE 3: Reddit ───────────────────────────────────────────
async function fetchRedditSignals(ticker) {
  try {
    // Use Reddit's public JSON API — no auth needed for read-only
    const subreddits = ["investing", "stocks", "SecurityAnalysis", "wallstreetbets"];
    const fetches = subreddits.map(sub =>
      fetch(
        `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(ticker)}&sort=new&t=week&limit=15`,
        { headers: { "User-Agent": "Meridian/1.0" } }
      )
        .then(r => r.ok ? r.json() : { data: { children: [] } })
        .then(data => (data.data?.children || []).map(post => ({
          source: `reddit_${sub}`,
          headline: post.data?.title || "",
          url: `https://reddit.com${post.data?.permalink}`,
          text: (post.data?.title || "") + " " + (post.data?.selftext || "").slice(0, 200),
          sentiment: null,
          publishedAt: new Date(post.data?.created_utc * 1000).toISOString(),
          engagement: (post.data?.score || 0) + (post.data?.num_comments || 0),
          cluster: "sentimentShift",
          upvotes: post.data?.score || 0,
        })))
        .catch(() => [])
    );
    const results = await Promise.all(fetches);
    return results.flat();
  } catch { return []; }
}

// ─── SOURCE 4: Finnhub (analyst moves) ──────────────────────────
async function fetchAnalystSignals(ticker) {
  const key = process.env.FINNHUB_KEY;
  if (!key) { console.warn("FINNHUB_KEY not set — skipping Finnhub"); return []; }
  try {
    // Analyst recommendations
    const [rec, news] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/stock/recommendation?symbol=${ticker}&token=${key}`).then(r => r.ok ? r.json() : []),
      fetch(`https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${daysAgo(7)}&to=${today()}&token=${key}`).then(r => r.ok ? r.json() : []),
    ]);

    const recSignals = (Array.isArray(rec) ? rec.slice(0, 3) : []).map(r => ({
      source: "finnhub",
      headline: `Analyst consensus: Buy=${r.buy} Hold=${r.hold} Sell=${r.sell} (${r.period})`,
      url: null,
      sentiment: recToSentiment(r),
      publishedAt: r.period ? new Date(r.period).toISOString() : new Date().toISOString(),
      engagement: 0,
      cluster: "analystMoves",
    }));

    const newsSignals = (Array.isArray(news) ? news.slice(0, 10) : []).map(n => ({
      source: n.source || "finnhub",
      headline: n.headline || "",
      url: n.url,
      text: n.headline || "",
      sentiment: n.sentiment || null,
      publishedAt: n.datetime ? new Date(n.datetime * 1000).toISOString() : null,
      engagement: 0,
      cluster: "institutionPositionChange",
    }));

    return [...recSignals, ...newsSignals];
  } catch { return []; }
}

function recToSentiment(rec) {
  const total = (rec.buy || 0) + (rec.hold || 0) + (rec.sell || 0) + (rec.strongBuy || 0) + (rec.strongSell || 0);
  if (!total) return 0;
  const bullish = (rec.buy || 0) + (rec.strongBuy || 0);
  const bearish = (rec.sell || 0) + (rec.strongSell || 0);
  return (bullish - bearish) / total;
}

// ─── INFER SENTIMENT FROM TEXT ───────────────────────────────────
// For signals where no sentiment score is provided, infer from text
// using the same lexicon pattern as the existing sentiment endpoint.
const BULL = /\b(surg|soar|jump|rall|beat|tops?|upgrad|record|grow|gains?|rise|rises|rising|risen|rose|climb|outperform|bullish|strong|profit|wins?|won|contract|approv|expand|rais|boost|optimis|breakthrough|rebound|higher|surpass|rocket|best|bought|purchase|long position|call option|increased stake|new position)\w*/gi;
const BEAR = /\b(fall|fell|drop|plung|slump|miss|downgrad|loss|lawsuit|prob|investigat|cuts?|warn|weak|declin|sink|sell.?off|bearish|recall|fraud|scrutiny|layoff|halts?|tumbl|crash|fears?|risks?|disappoint|slash|lower|downturn|bankrupt|delay|worst|slow|woes?|sluggish|cools?|short position|put option|reduced position|exited|short attack|short seller)\w*/gi;

function inferSentiment(text = "") {
  const bull = (text.match(BULL) || []).length;
  const bear = (text.match(BEAR) || []).length;
  const total = bull + bear;
  if (!total) return 0;
  return (bull - bear) / total;
}

// ─── DATE HELPERS ────────────────────────────────────────────────
function today() { return new Date().toISOString().slice(0, 10); }
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// ─── MAIN: GATHER + AGGREGATE ALL SIGNALS ────────────────────────
// This is what the research engine calls. Returns a clean
// PositioningSignal object ready to be injected into the ontology.
export async function gatherSignals(ticker) {
  ticker = ticker.toUpperCase().trim();

  // 1) Fetch all sources in parallel
  const [insiderRaw, newsRaw, redditRaw, analystRaw] = await Promise.all([
    fetchInsiderTransactions(ticker),
    fetchNewsSignals(ticker, KEYWORD_CLUSTERS),
    fetchRedditSignals(ticker),
    fetchAnalystSignals(ticker),
  ]);

  const allRaw = [...insiderRaw, ...newsRaw, ...redditRaw, ...analystRaw];
  if (allRaw.length === 0) return buildEmptySignal(ticker);

  // 2) Infer missing sentiment scores from text
  allRaw.forEach(s => {
    if (s.sentiment === null || s.sentiment === undefined) {
      s.sentiment = inferSentiment(s.text || s.headline || "");
    }
  });

  // 3) Score every signal
  const scored = allRaw.map(computeSignalScore).filter(s => s.finalScore !== 0);

  // 4) Apply corroboration multiplier
  const corrMult = applyCorroborationMultiplier(scored);

  // 5) Aggregate
  const weightedSum = scored.reduce((sum, s) => sum + s.finalScore, 0);
  const totalWeight = scored.reduce((sum, s) => sum + (s.credibility * s.temporalWeight), 0);
  const aggregatedScore = totalWeight > 0 ? (weightedSum / totalWeight) * corrMult : 0;
  const clampedScore = Math.max(-1, Math.min(1, aggregatedScore));

  const bullSignals = scored.filter(s => s.direction === "bullish");
  const bearSignals = scored.filter(s => s.direction === "bearish");
  const neutSignals = scored.filter(s => s.direction === "neutral");

  // 6) Find the most credible signal (the "key driver")
  const topSignal = [...scored].sort((a, b) => (b.credibility * b.temporalWeight) - (a.credibility * a.temporalWeight))[0];

  // 7) Find conflicts (high credibility sources disagreeing)
  const highCredBull = bullSignals.filter(s => s.credibility >= 0.7);
  const highCredBear = bearSignals.filter(s => s.credibility >= 0.7);
  const hasConflict = highCredBull.length > 0 && highCredBear.length > 0;

  // 8) Total bias applied (how much political bias shifted the signals)
  const avgBiasApplied = scored.reduce((sum, s) => sum + Math.abs(s.biasApplied), 0) / Math.max(scored.length, 1);

  return {
    ticker,
    aggregatedScore: +clampedScore.toFixed(3),
    direction: clampedScore > 0.15 ? "bullish" : clampedScore < -0.15 ? "bearish" : "neutral",
    confidence: +Math.min(Math.abs(clampedScore) * corrMult, 1).toFixed(2),
    corroborationMultiplier: +corrMult.toFixed(2),
    totalSignals: scored.length,
    bullSignals: bullSignals.length,
    bearSignals: bearSignals.length,
    neutralSignals: neutSignals.length,
    keyDriver: topSignal ? {
      headline: topSignal.headline,
      source: topSignal.source,
      credibility: topSignal.credibility,
      url: topSignal.url,
    } : null,
    hasConflict,
    conflictNote: hasConflict
      ? `${highCredBull.length} high-credibility bullish vs ${highCredBear.length} high-credibility bearish signals — interpret with caution`
      : null,
    politicalBiasNote: avgBiasApplied > 0.05
      ? `Avg political bias correction applied: ${(avgBiasApplied * 100).toFixed(1)}% sentiment shift across sources`
      : "Minimal political bias detected in sources",
    topBullishSignals: bullSignals.sort((a, b) => b.finalScore - a.finalScore).slice(0, 3).map(s => ({ headline: s.headline, source: s.source, score: s.finalScore, url: s.url })),
    topBearishSignals: bearSignals.sort((a, b) => a.finalScore - b.finalScore).slice(0, 3).map(s => ({ headline: s.headline, source: s.source, score: s.finalScore, url: s.url })),
    clusterBreakdown: buildClusterBreakdown(scored),
    gatheredAt: new Date().toISOString(),
  };
}

function buildClusterBreakdown(scored) {
  const clusters = {};
  scored.forEach(s => {
    if (!clusters[s.cluster]) clusters[s.cluster] = { count: 0, avgScore: 0, direction: "neutral" };
    clusters[s.cluster].count++;
    clusters[s.cluster].avgScore += s.finalScore;
  });
  Object.keys(clusters).forEach(k => {
    clusters[k].avgScore = +(clusters[k].avgScore / clusters[k].count).toFixed(3);
    clusters[k].direction = clusters[k].avgScore > 0.1 ? "bullish" : clusters[k].avgScore < -0.1 ? "bearish" : "neutral";
  });
  return clusters;
}

function buildEmptySignal(ticker) {
  return {
    ticker,
    aggregatedScore: 0,
    direction: "neutral",
    confidence: 0,
    totalSignals: 0,
    bullSignals: 0,
    bearSignals: 0,
    neutralSignals: 0,
    keyDriver: null,
    hasConflict: false,
    conflictNote: "No signals found — check API keys or try a more liquid ticker",
    politicalBiasNote: "No data",
    topBullishSignals: [],
    topBearishSignals: [],
    clusterBreakdown: {},
    gatheredAt: new Date().toISOString(),
  };
}

// Cache signals 30 min so the same ticker doesn't hit APIs repeatedly
const _signalCache = new Map();
const SIGNAL_TTL = 30 * 60_000;

export async function getCachedSignals(ticker) {
  const cached = _signalCache.get(ticker);
  if (cached && Date.now() - cached.at < SIGNAL_TTL) return cached.data;
  const data = await gatherSignals(ticker);
  _signalCache.set(ticker, { at: Date.now(), data });
  return data;
}

// ─── TWITTER INTEGRATION ─────────────────────────────────────────
// Import is dynamic so the file still works if twitter.js is absent.
async function fetchTwitterSignalsSafe(ticker, clusters) {
  try {
    const { fetchTwitterSignals } = await import("./twitter.js");
    return await fetchTwitterSignals(ticker, clusters);
  } catch { return []; }
}

// ─── APPLY LEARNED CREDIBILITY ADJUSTMENTS ───────────────────────
// After the tracker has seen 10+ signals from a source, its accuracy
// adjusts the base credibility score. This is how the system learns.
async function applyLearnedCredibility(scored) {
  try {
    const { getLearnedAdjustments } = await import("./signals-tracker.js");
    const adjustments = await getLearnedAdjustments();
    return scored.map(s => {
      const adj = adjustments[s.sourceKey];
      if (!adj) return s;
      const newCredibility = Math.max(0.05, Math.min(1.0, s.credibility + adj.adj));
      const newFinalScore = s.rawSentiment * newCredibility * s.temporalWeight * s.engagementWeight;
      return {
        ...s,
        credibility: +newCredibility.toFixed(3),
        finalScore: +newFinalScore.toFixed(4),
        learnedAdj: +adj.adj.toFixed(3),
        learnedAccuracy: +adj.accuracy.toFixed(2),
        learnedSampleSize: adj.total,
      };
    });
  } catch { return scored; }  // graceful fallback if tracker unavailable
}

// Override the main gatherSignals export to include Twitter + learning.
// This replaces the original export at the bottom of this file.
export async function gatherSignalsV2(ticker) {
  ticker = ticker.toUpperCase().trim();

  // 1) Fetch all sources in parallel (including Twitter)
  const [insiderRaw, newsRaw, redditRaw, analystRaw, twitterRaw] = await Promise.all([
    fetchInsiderTransactions(ticker),
    fetchNewsSignals(ticker, KEYWORD_CLUSTERS),
    fetchRedditSignals(ticker),
    fetchAnalystSignals(ticker),
    fetchTwitterSignalsSafe(ticker, KEYWORD_CLUSTERS),
  ]);

  const allRaw = [...insiderRaw, ...newsRaw, ...redditRaw, ...analystRaw, ...twitterRaw];
  if (allRaw.length === 0) return buildEmptySignal(ticker);

  // 2) Infer missing sentiment
  allRaw.forEach(s => {
    if (s.sentiment === null || s.sentiment === undefined) {
      s.sentiment = inferSentiment(s.text || s.headline || "");
    }
  });

  // 3) Score every signal
  let scored = allRaw.map(computeSignalScore).filter(s => s.finalScore !== 0);

  // 4) Apply learned credibility adjustments (the "learn over time" part)
  scored = await applyLearnedCredibility(scored);

  // 5) Corroboration multiplier
  const corrMult = applyCorroborationMultiplier(scored);

  // 6) Aggregate
  const weightedSum = scored.reduce((sum, s) => sum + s.finalScore, 0);
  const totalWeight = scored.reduce((sum, s) => sum + (s.credibility * s.temporalWeight), 0);
  const aggregatedScore = totalWeight > 0 ? (weightedSum / totalWeight) * corrMult : 0;
  const clampedScore = Math.max(-1, Math.min(1, aggregatedScore));

  const bullSignals = scored.filter(s => s.direction === "bullish");
  const bearSignals = scored.filter(s => s.direction === "bearish");
  const neutSignals = scored.filter(s => s.direction === "neutral");
  const topSignal = [...scored].sort((a, b) => (b.credibility * b.temporalWeight) - (a.credibility * a.temporalWeight))[0];
  const highCredBull = bullSignals.filter(s => s.credibility >= 0.7);
  const highCredBear = bearSignals.filter(s => s.credibility >= 0.7);
  const hasConflict = highCredBull.length > 0 && highCredBear.length > 0;
  const avgBiasApplied = scored.reduce((sum, s) => sum + Math.abs(s.biasApplied), 0) / Math.max(scored.length, 1);
  const learnedSignals = scored.filter(s => s.learnedAdj !== undefined);

  return {
    ticker,
    aggregatedScore: +clampedScore.toFixed(3),
    direction: clampedScore > 0.15 ? "bullish" : clampedScore < -0.15 ? "bearish" : "neutral",
    confidence: +Math.min(Math.abs(clampedScore) * corrMult, 1).toFixed(2),
    corroborationMultiplier: +corrMult.toFixed(2),
    totalSignals: scored.length,
    sourceBreakdown: {
      sec: insiderRaw.length,
      news: newsRaw.length,
      reddit: redditRaw.length,
      analyst: analystRaw.length,
      twitter: twitterRaw.length,
    },
    bullSignals: bullSignals.length,
    bearSignals: bearSignals.length,
    neutralSignals: neutSignals.length,
    keyDriver: topSignal ? {
      headline: topSignal.headline,
      source: topSignal.source,
      credibility: topSignal.credibility,
      url: topSignal.url,
    } : null,
    hasConflict,
    conflictNote: hasConflict
      ? `${highCredBull.length} high-credibility bullish vs ${highCredBear.length} bearish — interpret with caution`
      : null,
    politicalBiasNote: avgBiasApplied > 0.05
      ? `Avg political bias correction: ${(avgBiasApplied * 100).toFixed(1)}% sentiment shift`
      : "Minimal political bias detected",
    learningNote: learnedSignals.length > 0
      ? `${learnedSignals.length} signals adjusted by learned credibility from historical accuracy`
      : "Not enough history yet to apply learned adjustments (need 10+ signals per source)",
    topBullishSignals: bullSignals.sort((a, b) => b.finalScore - a.finalScore).slice(0, 3)
      .map(s => ({ headline: s.headline, source: s.source, score: s.finalScore, url: s.url, learned: s.learnedAccuracy })),
    topBearishSignals: bearSignals.sort((a, b) => a.finalScore - b.finalScore).slice(0, 3)
      .map(s => ({ headline: s.headline, source: s.source, score: s.finalScore, url: s.url, learned: s.learnedAccuracy })),
    clusterBreakdown: buildClusterBreakdown(scored),
    scoredSignals: scored,  // full list passed to tracker for recording
    gatheredAt: new Date().toISOString(),
  };
}
