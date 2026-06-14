// ───────────────────────────────────────────────────────────────
// backend/twitter.js
// Twitter/X API v2 client for Meridian signal engine.
//
// Free tier limits: 500,000 tweet reads/month, 1 request/second.
// This file manages a monthly budget so you never accidentally
// burn through your allocation.
//
// Budget allocation (conservative, within free tier):
//   Daily routine scans:  ~3,000 tweets/day × 30 = 90,000/month
//   Crisis event scans:   ~500 per event × 50    = 25,000/month
//   Buffer remaining:     ~385,000 (safety margin)
//
// Add to backend/.env:
//   TWITTER_BEARER_TOKEN=your_bearer_token_from_developer.twitter.com
// ───────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const BEARER = process.env.TWITTER_BEARER_TOKEN;
const MONTHLY_BUDGET = 500_000;        // free tier cap
const DAILY_ROUTINE_CAP = 3_000;       // max per day for routine scans
const CRISIS_CAP = 500;                // max per crisis event search
const CACHE_TTL = 2 * 60 * 60_000;    // 2 hour cache per ticker
const RATE_LIMIT_MS = 1100;            // 1 request per second (free tier)

// ─── Budget tracking (persisted to disk) ─────────────────────────
// Stored as a simple JSON file in backend/ so it survives restarts.
const BUDGET_FILE = join(process.cwd(), ".twitter-budget.json");

function loadBudget() {
  try {
    if (existsSync(BUDGET_FILE)) {
      const b = JSON.parse(readFileSync(BUDGET_FILE, "utf8"));
      // Reset monthly counter if it's a new month
      const now = new Date();
      const saved = new Date(b.monthStart);
      if (now.getMonth() !== saved.getMonth() || now.getFullYear() !== saved.getFullYear()) {
        return freshBudget();
      }
      return b;
    }
  } catch { /* fall through */ }
  return freshBudget();
}

function freshBudget() {
  return {
    monthStart: new Date().toISOString(),
    monthlyUsed: 0,
    dailyUsed: 0,
    dailyDate: new Date().toISOString().slice(0, 10),
    lastRequest: 0,
  };
}

function saveBudget(b) {
  try { writeFileSync(BUDGET_FILE, JSON.stringify(b, null, 2)); } catch { /* non-fatal */ }
}

function checkAndDeductBudget(tweetCount, isRoutine = true) {
  const b = loadBudget();
  const today = new Date().toISOString().slice(0, 10);

  // Reset daily counter if new day
  if (b.dailyDate !== today) {
    b.dailyUsed = 0;
    b.dailyDate = today;
  }

  const dailyCap = isRoutine ? DAILY_ROUTINE_CAP : CRISIS_CAP * 10;

  if (b.monthlyUsed + tweetCount > MONTHLY_BUDGET * 0.95) {
    throw new Error(`Twitter monthly budget almost exhausted (${b.monthlyUsed}/${MONTHLY_BUDGET} used). Resets ${new Date(new Date(b.monthStart).setMonth(new Date(b.monthStart).getMonth() + 1)).toDateString()}.`);
  }

  if (b.dailyUsed + tweetCount > dailyCap) {
    throw new Error(`Twitter daily cap reached (${b.dailyUsed}/${dailyCap} used today). Resets tomorrow.`);
  }

  b.monthlyUsed += tweetCount;
  b.dailyUsed += tweetCount;
  b.lastRequest = Date.now();
  saveBudget(b);
  return b;
}

export function getBudgetStatus() {
  const b = loadBudget();
  return {
    monthlyUsed: b.monthlyUsed,
    monthlyBudget: MONTHLY_BUDGET,
    monthlyRemaining: MONTHLY_BUDGET - b.monthlyUsed,
    monthlyPct: +((b.monthlyUsed / MONTHLY_BUDGET) * 100).toFixed(1),
    dailyUsed: b.dailyUsed,
    dailyCap: DAILY_ROUTINE_CAP,
    dailyRemaining: DAILY_ROUTINE_CAP - b.dailyUsed,
    monthStart: b.monthStart,
  };
}

// ─── Rate limiter (1 req/sec for free tier) ──────────────────────
let _lastReq = 0;
async function rateLimit() {
  const wait = RATE_LIMIT_MS - (Date.now() - _lastReq);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastReq = Date.now();
}

// ─── Core Twitter search ─────────────────────────────────────────
async function searchTweets(query, maxResults = 100) {
  if (!BEARER) {
    console.warn("TWITTER_BEARER_TOKEN not set — skipping Twitter");
    return [];
  }

  // Budget check BEFORE the request
  checkAndDeductBudget(maxResults);
  await rateLimit();

  const params = new URLSearchParams({
    query: query + " -is:retweet lang:en",  // exclude retweets, English only
    max_results: Math.min(maxResults, 100).toString(),
    "tweet.fields": "created_at,public_metrics,author_id,entities",
    "user.fields": "public_metrics,verified,username",
    expansions: "author_id",
  });

  const r = await fetch(
    `https://api.twitter.com/2/tweets/search/recent?${params}`,
    { headers: { Authorization: `Bearer ${BEARER}` } }
  );

  if (r.status === 429) {
    console.warn("Twitter rate limited — backing off 60s");
    await new Promise(res => setTimeout(res, 60_000));
    return [];
  }

  if (!r.ok) {
    console.warn("Twitter API error:", r.status, await r.text());
    return [];
  }

  const data = await r.json();
  if (!data.data) return [];

  // Build a user lookup map from the expansions
  const users = {};
  (data.includes?.users || []).forEach(u => { users[u.id] = u; });

  return (data.data || []).map(t => {
    const user = users[t.author_id] || {};
    const metrics = t.public_metrics || {};
    const engagement = (metrics.like_count || 0) +
                       (metrics.retweet_count || 0) * 2 +
                       (metrics.reply_count || 0) +
                       (metrics.quote_count || 0);
    const followerCount = user.public_metrics?.followers_count || 0;
    return {
      id: t.id,
      text: t.text,
      authorId: t.author_id,
      username: user.username || "unknown",
      verified: user.verified || false,
      followerCount,
      engagement,
      createdAt: t.created_at,
      metrics,
      // Account tier for credibility scoring
      accountTier: followerCount > 100_000 ? "major"
                 : followerCount > 10_000  ? "established"
                 : followerCount > 1_000   ? "minor"
                 : "unknown",
    };
  });
}

// ─── In-memory cache ─────────────────────────────────────────────
const _twitterCache = new Map();

// ─── Main export: fetch signals for a ticker ─────────────────────
// Uses ONE batched query per ticker (combining all keyword clusters)
// to stay within budget. Returns signals in the same shape as the
// other sources in signals.js.
export async function fetchTwitterSignals(ticker, clusters) {
  if (!BEARER) return [];

  const cacheKey = ticker;
  const cached = _twitterCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL) {
    return cached.data;
  }

  // Build one batched query using OR — 1 API call instead of N
  // This is the budget-efficiency trick: combine clusters
  const allKeywords = Object.values(clusters)
    .flat()
    .filter(k => k.split(" ").length <= 3)   // Twitter search prefers short phrases
    .slice(0, 20);                             // max 20 keyword phrases per query

  // Split into batches of 5 keywords (Twitter query length limit)
  const batches = [];
  for (let i = 0; i < allKeywords.length; i += 5) {
    batches.push(allKeywords.slice(i, i + 5));
  }

  // Only run first 3 batches to stay within budget
  const activeBatches = batches.slice(0, 3);
  const results = [];

  for (const batch of activeBatches) {
    const keywordQuery = batch.map(k => `"${k}"`).join(" OR ");
    const query = `(${keywordQuery}) (${ticker}) -is:retweet`;
    try {
      const tweets = await searchTweets(query, 100);
      results.push(...tweets);
    } catch (e) {
      console.warn("Twitter batch search failed:", e.message);
      break; // stop on budget error, don't crash
    }
    // Small delay between batches
    await new Promise(r => setTimeout(r, 1200));
  }

  // Convert to signal format
  const signals = results.map(t => ({
    source: resolveTwitterSourceTier(t),
    headline: t.text.slice(0, 200),
    url: `https://twitter.com/${t.username}/status/${t.id}`,
    text: t.text,
    sentiment: null,     // inferred in signals.js
    publishedAt: t.createdAt,
    engagement: t.engagement,
    cluster: "sentimentShift",
    // Extra Twitter-specific metadata for credibility scoring
    followerCount: t.followerCount,
    verified: t.verified,
    accountTier: t.accountTier,
  }));

  _twitterCache.set(cacheKey, { at: Date.now(), data: signals });
  return signals;
}

// Map Twitter account tier to source key for credibility scoring
function resolveTwitterSourceTier(tweet) {
  if (tweet.verified && tweet.followerCount > 100_000) return "twitter_verified_major";
  if (tweet.followerCount > 50_000) return "twitter_fintwit";
  if (tweet.followerCount > 10_000) return "twitter_established";
  return "twitter_unknown";
}
