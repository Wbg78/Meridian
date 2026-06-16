// ───────────────────────────────────────────────────────────────
// backend/motor.js
// Haiku training motor — fills the Beta-Bernoulli tracker with
// real signals at near-zero cost, so the system learns fast.
//
// Cost: ~$0.002 / ticker / night  (20 watchlist tickers ≈ $0.04/night)
// vs.  ~$0.28 / full Sonnet research run
//
// What it does each night:
//   1. Reads the watchlist (backend/watchlist.js)
//   2. For each ticker: fetches 24h of Google News headlines
//   3. Batches them to claude-haiku → structured JSON array
//      (cluster + sentiment + signal type — no prose, just classification)
//   4. Records each classified signal via recordSignals()
//   5. Resolves outcomes for signals 7 and 14 days old via Finnhub price
//
// Call runMotor() from a Render cron job or a daily setInterval.
// ───────────────────────────────────────────────────────────────

import { getWatchlist } from "./watchlist.js";
import { recordSignals, resolveOutcomes } from "./signals-tracker.js";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const API = "https://api.anthropic.com/v1/messages";
const FINNHUB_BASE = "https://finnhub.io/api/v1";

// ─── FETCH HEADLINES ────────────────────────────────────────────
// Same keyless Google News RSS that signals.js uses — no API key needed.
const NEWS_MAX_AGE_MS = 24 * 3600_000;

function parseMotorRss(xml) {
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  const out = [];
  for (const b of blocks) {
    const pick = (tag) => {
      const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      if (!m) return "";
      return m[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").replace(/<[^>]+>/g, "").trim();
    };
    const title = pick("title");
    const link = pick("link");
    const pubDate = pick("pubDate");
    let source = pick("source") || "";
    if (!source && title.includes(" - ")) source = title.split(" - ").pop();
    const cleanTitle = (source && title.endsWith(" - " + source))
      ? title.slice(0, -(source.length + 3)) : title;
    const srcUrlMatch = b.match(/<source[^>]*url="([^"]+)"/i);
    const url = srcUrlMatch ? srcUrlMatch[1] : link;
    if (cleanTitle && link) {
      out.push({ headline: cleanTitle, url: link, source, pubDate, sourceDomain: url });
    }
  }
  return out;
}

async function fetchHeadlines(ticker) {
  try {
    const query = `${ticker} stock (analyst OR upgrade OR downgrade OR "price target" OR insider OR "hedge fund" OR institutional OR stake OR earnings)`;
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query + " when:1d")}&hl=en-US&gl=US&ceid=US:en`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return [];
    const xml = await r.text();
    const now = Date.now();
    return parseMotorRss(xml)
      .filter(n => { const t = new Date(n.pubDate).getTime(); return t && (now - t) < NEWS_MAX_AGE_MS; })
      .slice(0, 30);
  } catch { return []; }
}

// ─── CLASSIFY HEADLINES VIA HAIKU ───────────────────────────────
// One API call batches ALL headlines for a ticker.
// Returns array of classified signals matching signal-schema in signals.js.
async function classifyWithHaiku(ticker, headlines) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || headlines.length === 0) return [];

  const indexedList = headlines
    .map((h, i) => `${i}. [${h.source || "Unknown"}] ${h.headline}`)
    .join("\n");

  const prompt = `You are a financial signal classifier. Given these news headlines about the stock ticker "${ticker}", classify each one.

Headlines:
${indexedList}

Return a JSON array. For each headline return one object:
{
  "index": <number matching the headline index>,
  "cluster": "analystMoves|insiderActivity|institutionPositionChange|aggressiveMoves|capitalFlow|sentimentShift",
  "sentiment": <float from -1.0 (bearish) to 1.0 (bullish)>,
  "signalType": "analyst_upgrade|analyst_downgrade|insider_buy|insider_sell|institution_buy|institution_sell|options_bullish|options_bearish|capital_inflow|capital_outflow|news_positive|news_negative|news_neutral"
}

Rules:
- Use sentiment 0.0 if the headline is not relevant to ${ticker}'s stock direction
- analyst_upgrade = positive analyst action (raise target, upgrade), analyst_downgrade = negative
- insider_buy = insider/executive purchasing shares, insider_sell = selling
- Return ONLY the JSON array, no commentary`;

  try {
    const r = await fetch(API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) return [];
    const data = await r.json();
    const text = data.content?.[0]?.text || "[]";
    if (data.usage) {
      const cost = ((data.usage.input_tokens * 0.0008 + data.usage.output_tokens * 0.004) / 1000).toFixed(5);
      console.log(`[Motor/Haiku] ${ticker}: ${data.usage.input_tokens}in ${data.usage.output_tokens}out ~$${cost}`);
    }
    // Extract JSON from the response (may have markdown fences)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.warn(`[Motor] Haiku classify failed for ${ticker}:`, e.message);
    return [];
  }
}

// ─── FETCH CURRENT PRICE VIA FINNHUB ────────────────────────────
async function fetchFinnhubPrice(ticker) {
  const key = process.env.FINNHUB_KEY;
  if (!key) return null;
  try {
    const r = await fetch(
      `${FINNHUB_BASE}/quote?symbol=${encodeURIComponent(ticker)}&token=${key}`
    );
    if (!r.ok) return null;
    const data = await r.json();
    return data.c || null; // current price
  } catch { return null; }
}

// ─── PROCESS ONE TICKER ─────────────────────────────────────────
async function processTicker(ticker) {
  console.log(`[Motor] Processing ${ticker}…`);

  const headlines = await fetchHeadlines(ticker);
  if (headlines.length === 0) {
    console.log(`[Motor] No headlines found for ${ticker}`);
    return { ticker, signals: 0 };
  }

  const classifications = await classifyWithHaiku(ticker, headlines);
  if (classifications.length === 0) {
    console.log(`[Motor] Classification returned nothing for ${ticker}`);
    return { ticker, signals: 0 };
  }

  // Merge classifications back with original headline data
  const currentPrice = await fetchFinnhubPrice(ticker);
  const scoredSignals = [];

  for (const cl of classifications) {
    const h = headlines[cl.index];
    if (!h || Math.abs(cl.sentiment || 0) < 0.05) continue; // skip irrelevant

    const direction = cl.sentiment > 0.15 ? "bullish" : cl.sentiment < -0.15 ? "bearish" : "neutral";

    scoredSignals.push({
      source: h.source || "Google News",
      sourceKey: resolveMotorSourceKey(h.source || ""),
      signalType: cl.signalType || "news_neutral",
      cluster: cl.cluster || "sentimentShift",
      headline: h.headline,
      url: h.url,
      rawSentiment: +(cl.sentiment || 0).toFixed(3),
      finalScore: +(cl.sentiment || 0).toFixed(4),
      direction,
      publishedAt: h.pubDate,
    });
  }

  if (scoredSignals.length > 0) {
    await recordSignals(ticker, scoredSignals, currentPrice);
    console.log(`[Motor] Recorded ${scoredSignals.length} signals for ${ticker}`);
  }

  return { ticker, signals: scoredSignals.length, price: currentPrice };
}

// Simple source key resolution for motor (mirrors signals.js)
function resolveMotorSourceKey(sourceName = "") {
  const s = sourceName.toLowerCase().replace(/[^a-z_]/g, "");
  if (s.includes("reuters"))    return "reuters";
  if (s.includes("bloomberg"))  return "bloomberg";
  if (s.includes("financialtimes") || s.includes("ft")) return "financial_times";
  if (s.includes("wsj") || s.includes("wallstreet")) return "wsj";
  if (s.includes("cnbc"))       return "cnbc";
  if (s.includes("nyt") || s.includes("newyorktimes")) return "nyt";
  if (s.includes("guardian"))   return "guardian";
  if (s.includes("foxbusiness") || s.includes("fox")) return "fox_business";
  if (s.includes("marketwatch")) return "marketwatch";
  if (s.includes("barrons"))    return "barrons";
  if (s.includes("seekingalpha")) return "seeking_alpha";
  if (s.includes("yahoo"))      return "yahoo_finance";
  if (s.includes("substack"))   return "substack_curated";
  return "unknown";
}

// ─── PRICE RESOLVER FOR resolveOutcomes ─────────────────────────
async function motorPriceFetcher(ticker) {
  return fetchFinnhubPrice(ticker);
}

// ─── MAIN ENTRY POINT ───────────────────────────────────────────
// Call once per night from server.js setInterval or Render cron.
export async function runMotor() {
  const started = Date.now();
  console.log("[Motor] Starting nightly training run…");

  // 1. Get watchlist
  let watchlist = [];
  try {
    watchlist = await getWatchlist();
  } catch (e) {
    console.warn("[Motor] Could not load watchlist:", e.message);
    return { ok: false, reason: "watchlist unavailable" };
  }

  if (watchlist.length === 0) {
    console.log("[Motor] Watchlist is empty — nothing to process.");
    return { ok: true, processed: 0, signals: 0 };
  }

  // 2. Process tickers sequentially (avoid bursting Google News)
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const results = [];
  for (const row of watchlist) {
    try {
      const r = await processTicker(row.ticker);
      results.push(r);
    } catch (e) {
      console.warn(`[Motor] Error processing ${row.ticker}:`, e.message);
      results.push({ ticker: row.ticker, signals: 0, error: e.message });
    }
    // 2-second gap between tickers to respect rate limits
    if (watchlist.indexOf(row) < watchlist.length - 1) await sleep(2000);
  }

  // 3. Resolve outcomes for signals from 7+ days ago
  console.log("[Motor] Resolving older outcomes…");
  let resolved = 0;
  try {
    const r = await resolveOutcomes(motorPriceFetcher);
    resolved = r.resolved || 0;
    if (resolved > 0) console.log(`[Motor] Resolved ${resolved} signal outcomes.`);
  } catch (e) {
    console.warn("[Motor] resolveOutcomes failed:", e.message);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const totalSignals = results.reduce((s, r) => s + (r.signals || 0), 0);
  console.log(`[Motor] Done in ${elapsed}s — ${totalSignals} signals recorded, ${resolved} outcomes resolved.`);

  return {
    ok: true,
    processed: results.length,
    signals: totalSignals,
    resolved,
    elapsed: +elapsed,
    results,
  };
}
