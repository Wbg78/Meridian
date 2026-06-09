// ───────────────────────────────────────────────────────────────
// MERIDIAN data backend
// Serves real market data to the Meridian frontend.
//
//   GET /health                      → quick "is it alive" check
//   GET /api/quotes?tickers=PLTR,BX  → live prices for tickers
//   GET /api/portfolio               → your holdings + live prices
//   GET /api/news?tickers=PLTR,HIMS  → recent news per ticker
//   GET /api/capitol                 → Capitol Trades (politician) feed
//   GET /api/screener                → Finviz top-gainers screener
//
// Run it:  npm install   then   npm start
// It listens on http://localhost:3001
// ───────────────────────────────────────────────────────────────

import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import YF from "yahoo-finance2";
import { toYahoo, SYMBOL_MAP } from "./symbols.js";

// Normalise across yahoo-finance2 build shapes so `yahooFinance.quote(...)`
// always resolves to the object that actually has the methods.
const yahooFinance =
  (YF && typeof YF.quote === "function") ? YF :
  (YF?.default && typeof YF.default.quote === "function") ? YF.default :
  (typeof YF === "function" ? new YF() : YF);

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3001;

// ─── SECRETS (from environment) ─────────────────────────────────
// Set these in a local .env file and in your host's env settings.
// Never commit real values. See .env.example.
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || "meridian2026";
const ACCESS_CODE    = process.env.ACCESS_CODE    || "TSLA5574";
// Used to sign login tokens. If unset, a random one is made at boot
// (which simply means everyone is logged out on each restart).
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
// Comma-separated list of sites allowed to call this API.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  "http://localhost:5173,http://localhost:3000")
  .split(",").map((s) => s.trim()).filter(Boolean);

if (!process.env.OWNER_PASSWORD) {
  console.warn("⚠  OWNER_PASSWORD not set — using a default. Set it in .env before deploying.");
}

// Lock CORS to known origins (plus tools/curl with no Origin header).
// Any localhost / 127.0.0.1 port is allowed for local development.
function isLocalhost(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || "");
}
app.use(cors({
  origin(origin, cb) {
    if (!origin || isLocalhost(origin) || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("Origin not allowed"));
  },
}));

// ─── AUTH (signed tokens, no extra dependency) ──────────────────
function makeToken(role) {
  const payload = { role, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 }; // 7 days
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  // constant-time compare
  if (sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload; // { role, exp }
  } catch { return null; }
}

function getToken(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

// Require any logged-in user (owner OR guest with the code)
function requireAuth(req, res, next) {
  const p = verifyToken(getToken(req));
  if (!p) return res.status(401).json({ error: "Not authenticated" });
  req.user = p;
  next();
}

// Require the owner specifically
function requireOwner(req, res, next) {
  const p = verifyToken(getToken(req));
  if (!p) return res.status(401).json({ error: "Not authenticated" });
  if (p.role !== "owner") return res.status(403).json({ error: "Forbidden" });
  req.user = p;
  next();
}

// Constant-time string compare for passwords
function safeEqual(a, b) {
  const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// POST /api/login { password } -> { token, role }
app.post("/api/login", (req, res) => {
  const pw = (req.body && req.body.password) || "";
  if (safeEqual(pw, OWNER_PASSWORD)) return res.json({ token: makeToken("owner"), role: "owner" });
  if (safeEqual(pw, ACCESS_CODE))    return res.json({ token: makeToken("guest"), role: "guest" });
  return res.status(401).json({ error: "Incorrect password or code" });
});

// Your real holdings (shares + avg cost). Prices are fetched live.
// Edit shares/avgCost here whenever you buy or sell.
const HOLDINGS = {
  stocks: [
    { ticker: "GOOGL",  name: "Alphabet Inc C",       shares: 1,   avgCost: 145.95, currency: "USD", country: "US", sector: "Tech" },
    { ticker: "BETS-B", name: "Betsson B",            shares: 15,  avgCost: 166.75, currency: "SEK", country: "SE", sector: "Gaming" },
    { ticker: "BX",     name: "Blackstone",           shares: 6,   avgCost: 142.68, currency: "USD", country: "US", sector: "Finance" },
    { ticker: "BXMT",   name: "Blackstone Mortgage",  shares: 15,  avgCost: 19.50,  currency: "USD", country: "US", sector: "Finance" },
    { ticker: "DUOL",   name: "Duolingo A",           shares: 2,   avgCost: 263.89, currency: "USD", country: "US", sector: "Tech/Edu" },
    { ticker: "FLAT",   name: "Flat Capital",         shares: 335, avgCost: 22.05,  currency: "SEK", country: "SE", sector: "Finance" },
    { ticker: "FLYE",   name: "Fly-E Group",          shares: 2,   avgCost: 150.50, currency: "USD", country: "US", sector: "EV" },
    { ticker: "HIMS",   name: "Hims & Hers Health",   shares: 15,  avgCost: 55.71,  currency: "USD", country: "US", sector: "Health" },
    { ticker: "INVE-B", name: "Investor B",           shares: 64,  avgCost: 314.39, currency: "SEK", country: "SE", sector: "Conglomerate" },
    { ticker: "LMND",   name: "Lemonade",             shares: 9,   avgCost: 60.51,  currency: "USD", country: "US", sector: "Insurtech" },
    { ticker: "NIBE-B", name: "Nibe Industrier B",    shares: 41,  avgCost: 61.17,  currency: "SEK", country: "SE", sector: "Industry" },
    { ticker: "NVO",    name: "Novo Nordisk B",       shares: 2,   avgCost: 918.79, currency: "DKK", country: "DK", sector: "Pharma" },
    { ticker: "PLTR",   name: "Palantir Technologies",shares: 4,   avgCost: 24.50,  currency: "USD", country: "US", sector: "AI/Data" },
    { ticker: "ROOT",   name: "Root Inc",             shares: 5,   avgCost: 82.35,  currency: "USD", country: "US", sector: "Insurtech" },
    { ticker: "HO",     name: "Thales",               shares: 1,   avgCost: 271.97, currency: "EUR", country: "FR", sector: "Defense" },
  ],
  etfs: [
    { ticker: "FLXI", name: "Franklin FTSE India UCITS ETF", shares: 9, avgCost: 41.73,  currency: "EUR" },
    { ticker: "XACT", name: "XACT OMXS30 ESG",               shares: 1, avgCost: 329.00, currency: "SEK" },
  ],
  // Funds aren't on Yahoo — keep their values manual.
  funds: [
    { ticker: "AMF-LANG",  name: "AMF Räntefond Lång",          value: 5172,  gainPct: 3.43 },
    { ticker: "AVZ-GLO",   name: "Avanza Global",               value: 50191, gainPct: 18.17 },
    { ticker: "AVZ-USA",   name: "Avanza USA",                  value: 4703,  gainPct: 49.32 },
    { ticker: "AVZ-ZERO",  name: "Avanza Zero",                 value: 22374, gainPct: 13.40 },
    { ticker: "PLUS-FAST", name: "PLUS Fastigheter Sverige",    value: 1309,  gainPct: -6.49 },
    { ticker: "SWB-ASIEN", name: "Swedbank Robur Access Asien", value: 32648, gainPct: 29.56 },
  ],
};

// ─── helpers ────────────────────────────────────────────────────

// Fetch live quotes for a list of *your* tickers. Returns a map
// keyed by your ticker -> { price, change, currency, ... }
function mapQuote(q, fallbackName) {
  return {
    price: q.regularMarketPrice ?? null,
    change: q.regularMarketChangePercent ?? null,
    currency: q.currency ?? null,
    name: q.shortName ?? q.longName ?? fallbackName,
    marketState: q.marketState ?? null,
    pe: q.trailingPE ?? null,
    forwardPe: q.forwardPE ?? null,
    pb: q.priceToBook ?? null,
    eps: q.epsTrailingTwelveMonths ?? null,
    marketCap: q.marketCap ?? null,
    divYield: q.trailingAnnualDividendYield != null ? q.trailingAnnualDividendYield * 100 : (q.dividendYield ?? null),
    week52High: q.fiftyTwoWeekHigh ?? null,
    week52Low: q.fiftyTwoWeekLow ?? null,
  };
}

// Cache so we don't hammer Yahoo (which returns 429 "Too Many Requests").
const _quoteCache = new Map(); // ticker -> { at, data }
const QUOTE_TTL = 60_000;

// Fetch live quotes for your tickers in ONE batched request (not 15).
async function fetchQuotes(tickers) {
  const now = Date.now();
  const out = {};
  const need = [];
  for (const t of tickers) {
    const c = _quoteCache.get(t);
    if (c && now - c.at < QUOTE_TTL) out[t] = c.data;
    else need.push(t);
  }
  if (need.length === 0) return out;

  const yahooSymbols = need.map(toYahoo);
  try {
    // Single request for all symbols at once.
    const results = await yahooFinance.quote(yahooSymbols, {}, { validateResult: false });
    const arr = Array.isArray(results) ? results : [results];
    const bySym = {};
    arr.forEach((q) => { if (q && q.symbol) bySym[String(q.symbol).toUpperCase()] = q; });
    need.forEach((t, i) => {
      const q = bySym[yahooSymbols[i].toUpperCase()];
      const data = q ? mapQuote(q, t) : { price: null, change: null, error: "no data" };
      out[t] = data;
      if (q) _quoteCache.set(t, { at: now, data });
    });
  } catch (e) {
    const msg = String(e.message || e);
    need.forEach((t) => { out[t] = { price: null, change: null, error: msg }; });
  }
  return out;
}

// ─── routes ─────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Live quotes for arbitrary tickers
app.get("/api/quotes", requireAuth, async (req, res) => {
  try {
    const tickers = (req.query.tickers || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (!tickers.length) return res.status(400).json({ error: "pass ?tickers=AAPL,MSFT" });
    res.json(await fetchQuotes(tickers));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Your portfolio with live prices merged in — OWNER ONLY.
// Guests never receive this data; it isn't in the frontend bundle either.
app.get("/api/portfolio", requireOwner, async (req, res) => {
  try {
    const liveTickers = [
      ...HOLDINGS.stocks.map((s) => s.ticker),
      ...HOLDINGS.etfs.map((e) => e.ticker),
    ];
    const quotes = await fetchQuotes(liveTickers);

    const stocks = HOLDINGS.stocks.map((s) => {
      const q = quotes[s.ticker] || {};
      const price = q.price ?? null;
      return {
        ...s,
        price,
        change: q.change ?? null,
        gainPct: price != null ? ((price - s.avgCost) / s.avgCost) * 100 : null,
        pe: q.pe, forwardPe: q.forwardPe, pb: q.pb, eps: q.eps,
        marketCap: q.marketCap, divYield: q.divYield,
        week52High: q.week52High, week52Low: q.week52Low,
      };
    });
    const etfs = HOLDINGS.etfs.map((e) => {
      const q = quotes[e.ticker] || {};
      const price = q.price ?? null;
      return {
        ...e,
        price,
        change: q.change ?? null,
        gainPct: price != null ? ((price - e.avgCost) / e.avgCost) * 100 : null,
      };
    });

    res.json({ stocks, etfs, funds: HOLDINGS.funds, updated: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── NEWS (free, via Google News RSS) ───────────────────────────
// Each category is a search query + locale. Add/edit freely.
const NEWS_CATEGORIES = {
  portfolio:        { label: "My Holdings",      q: "Palantir OR Novo Nordisk OR Investor AB OR Hims Hers OR Blackstone stock", loc: { hl: "en-US", gl: "US", ceid: "US:en" } },
  sweden:           { label: "Sweden",           q: "Sverige ekonomi OR börs OR Riksbanken",        loc: { hl: "sv-SE", gl: "SE", ceid: "SE:sv" } },
  swedish_politics: { label: "Swedish Politics",  q: "svensk politik regeringen riksdagen",          loc: { hl: "sv-SE", gl: "SE", ceid: "SE:sv" } },
  us:               { label: "US",               q: "US stock market economy Federal Reserve",      loc: { hl: "en-US", gl: "US", ceid: "US:en" } },
  europe:           { label: "Europe",           q: "Europe economy markets ECB EU",                loc: { hl: "en-US", gl: "US", ceid: "US:en" } },
  china:            { label: "China",            q: "China economy markets trade",                  loc: { hl: "en-US", gl: "US", ceid: "US:en" } },
  middle_east:      { label: "Middle East / Iran",q: "Middle East Iran conflict oil",               loc: { hl: "en-US", gl: "US", ceid: "US:en" } },
  geopolitics:      { label: "Geopolitics",      q: "geopolitics global tensions",                  loc: { hl: "en-US", gl: "US", ceid: "US:en" } },
  tech:             { label: "Tech",             q: "technology AI semiconductors stocks",          loc: { hl: "en-US", gl: "US", ceid: "US:en" } },
  automotive:       { label: "Automotive",       q: "automotive industry EV Tesla cars",            loc: { hl: "en-US", gl: "US", ceid: "US:en" } },
  commodities:      { label: "Commodities",      q: "commodities oil gold copper prices",           loc: { hl: "en-US", gl: "US", ceid: "US:en" } },
};

const _newsCache = new Map(); // category -> { at, items }
const NEWS_TTL = 10 * 60_000;

function decodeEntities(s = "") {
  return s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}
function stripTags(s = "") { return decodeEntities(s.replace(/<[^>]*>/g, "")).trim(); }

// Search terms per holding, so "My Holdings" covers every position.
const HOLDINGS_NEWS_TERMS = {
  GOOGL: "Alphabet Google", "BETS-B": "Betsson", BX: "Blackstone",
  BXMT: "Blackstone Mortgage Trust", DUOL: "Duolingo", FLAT: "Flat Capital",
  FLYE: "Fly-E Group", HIMS: "Hims Hers", "INVE-B": "Investor AB",
  LMND: "Lemonade insurance", "NIBE-B": "NIBE Industrier", NVO: "Novo Nordisk",
  PLTR: "Palantir", ROOT: "Root Insurance", HO: "Thales",
};

function domainFromUrl(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function parseRssItems(xml) {
  const items = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const b of blocks) {
    const pick = (tag) => {
      const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      if (!m) return "";
      return decodeEntities(m[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "")).trim();
    };
    let title = pick("title");
    const link = pick("link");
    const pubDate = pick("pubDate");
    const source = pick("source") || (title.includes(" - ") ? title.split(" - ").pop() : "");
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    const summary = stripTags(pick("description")).replace(/\s+/g, " ").slice(0, 220);
    // try to find a real image (RSS media / enclosure / inline img)
    const imgMatch =
      b.match(/<media:content[^>]*url="([^"]+)"/i) ||
      b.match(/<media:thumbnail[^>]*url="([^"]+)"/i) ||
      b.match(/<enclosure[^>]*url="([^"]+)"[^>]*type="image/i) ||
      b.match(/<img[^>]+src="([^"]+)"/i);
    const image = imgMatch ? imgMatch[1] : null;
    // source domain (for a logo fallback)
    const srcUrlMatch = b.match(/<source[^>]*url="([^"]+)"/i);
    const sourceDomain = srcUrlMatch ? domainFromUrl(srcUrlMatch[1]) : "";
    if (title && link) items.push({ headline: title, link, source, time: pubDate, summary, image, sourceDomain });
  }
  return items;
}

const NEWS_MAX_AGE = 7 * 86400_000;     // drop anything older than 7 days

// Low-level: one Google News search -> recent, sorted, with logo fallback.
async function fetchGoogleNews(query, loc, days = 5) {
  const { hl, gl, ceid } = loc;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query + ` when:${days}d`)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error("google news " + r.status);
  const xml = await r.text();
  const now = Date.now();
  return parseRssItems(xml)
    .filter((n) => { const t = new Date(n.time).getTime(); return t && (now - t) < NEWS_MAX_AGE; })
    .map((n) => ({
      ...n,
      // Use a real photo if present; otherwise the publisher's logo.
      image: n.image || (n.sourceDomain ? `https://www.google.com/s2/favicons?sz=64&domain=${n.sourceDomain}` : null),
    }));
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((n) => { const k = n.headline.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

async function fetchCategory(catId) {
  const cat = NEWS_CATEGORIES[catId];
  if (!cat) return [];
  const cached = _newsCache.get(catId);
  if (cached && Date.now() - cached.at < NEWS_TTL) return cached.items;

  let items;
  if (catId === "portfolio") {
    // Search each holding separately, then merge — so every position shows.
    const terms = Object.values(HOLDINGS_NEWS_TERMS);
    const per = await Promise.allSettled(
      terms.map((t) => fetchGoogleNews(`${t} stock`, { hl: "en-US", gl: "US", ceid: "US:en" }, 7))
    );
    items = dedupe(per.flatMap((r) => (r.status === "fulfilled" ? r.value.slice(0, 3) : [])));
  } else {
    items = dedupe(await fetchGoogleNews(cat.q, cat.loc, 5));
  }
  items = items
    .map((n) => ({ ...n, category: catId }))
    .sort((a, b) => new Date(b.time) - new Date(a.time))
    .slice(0, 18);
  _newsCache.set(catId, { at: Date.now(), items });
  return items;
}

// GET /api/news                 -> list of available categories + a default mix
// GET /api/news?category=sweden -> articles for one category
app.get("/api/news", requireAuth, async (req, res) => {
  try {
    const categories = Object.entries(NEWS_CATEGORIES).map(([id, c]) => ({ id, label: c.label }));
    const cat = req.query.category;
    if (cat && NEWS_CATEGORIES[cat]) {
      return res.json({ categories, articles: await fetchCategory(cat) });
    }
    // default: a mix from a few key categories
    const mixIds = ["portfolio", "us", "sweden", "tech"];
    const results = await Promise.allSettled(mixIds.map(fetchCategory));
    const articles = results.flatMap((r) => r.status === "fulfilled" ? r.value : [])
      .sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 30);
    res.json({ categories, articles });
  } catch (e) {
    res.status(502).json({ error: "News unavailable: " + String(e) });
  }
});

// Capitol Trades — politician disclosures (public BFF JSON API)
app.get("/api/capitol", requireAuth, async (req, res) => {
  try {
    const url =
      "https://bff.capitoltrades.com/trades?per_page=20&page=1&sortBy=-txDate";
    const r = await fetch(url, { headers: {
      accept: "application/json",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
      referer: "https://www.capitoltrades.com/",
      origin: "https://www.capitoltrades.com",
    } });
    if (!r.ok) throw new Error("capitoltrades " + r.status);
    const json = await r.json();
    const feed = (json.data || []).map((t) => ({
      name: t.politician?.fullName || "Unknown",
      party: (t.politician?.party || "").charAt(0).toUpperCase(),
      ticker: t.asset?.assetTicker || t.issuer?.issuerTicker || "—",
      action: (t.txType || "").toUpperCase(),
      amount: t.value || t.size || "—",
      date: t.txDate,
    }));
    res.json(feed);
  } catch (e) {
    res.status(502).json({ error: "Capitol Trades unavailable: " + String(e) });
  }
});

// Finviz screener — top gainers (lightweight HTML scrape)
// Top movers from Finviz, enriched with live prices.
//   ?view=topgainers (default) | losers | mostactive
app.get("/api/screener", requireAuth, async (req, res) => {
  try {
    const map = { topgainers: "ta_topgainers", losers: "ta_toplosers", mostactive: "ta_mostactive" };
    const signal = map[req.query.view] || "ta_topgainers";
    const url = `https://finviz.com/screener.ashx?v=111&s=${signal}`;
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!r.ok) throw new Error("finviz " + r.status);
    const html = await r.text();
    // Match ticker links directly (robust to CSS class changes).
    const tickers = [...new Set(
      [...html.matchAll(/quote\.ashx\?t=([A-Za-z.\-]+)/g)].map((m) => m[1].toUpperCase())
    )].slice(0, 15);
    const q = await fetchQuotes(tickers);
    const rows = tickers.map((t) => ({
      ticker: t, price: q[t]?.price ?? null, change: q[t]?.change ?? null,
      name: q[t]?.name ?? t, marketCap: q[t]?.marketCap ?? null, pe: q[t]?.pe ?? null,
    }));
    res.json({ rows, source: "finviz" });
  } catch (e) {
    res.status(502).json({ error: "Finviz unavailable: " + String(e) });
  }
});

// Market overview — indices, commodities, crypto (batched, one request).
const MARKET_GROUPS = {
  indices: [["^GSPC", "S&P 500"], ["^IXIC", "Nasdaq"], ["^DJI", "Dow Jones"], ["^OMX", "OMXS30"], ["^GDAXI", "DAX"], ["^FTSE", "FTSE 100"], ["^VIX", "VIX"]],
  commodities: [["GC=F", "Gold"], ["CL=F", "Crude Oil"], ["BZ=F", "Brent"], ["SI=F", "Silver"], ["NG=F", "Nat Gas"], ["HG=F", "Copper"]],
  crypto: [["BTC-USD", "Bitcoin"], ["ETH-USD", "Ethereum"]],
  fx: [["USDSEK=X", "USD/SEK"], ["EURSEK=X", "EUR/SEK"]],
};
app.get("/api/market", requireAuth, async (req, res) => {
  try {
    const all = Object.values(MARKET_GROUPS).flat().map((x) => x[0]);
    const q = await fetchQuotes(all);
    const build = (list) => list.map(([sym, label]) => ({
      symbol: sym, label, price: q[sym]?.price ?? null,
      change: q[sym]?.change ?? null, currency: q[sym]?.currency ?? null,
    }));
    res.json(Object.fromEntries(Object.entries(MARKET_GROUPS).map(([k, v]) => [k, build(v)])));
  } catch (e) {
    res.status(502).json({ error: "Market data unavailable: " + String(e) });
  }
});

// Instant ticker / company search.
app.get("/api/search", requireAuth, async (req, res) => {
  try {
    const qstr = (req.query.q || "").trim();
    if (!qstr) return res.json([]);
    const r = await yahooFinance.search(qstr, { quotesCount: 8, newsCount: 0 }, { validateResult: false });
    const out = (r.quotes || []).filter((x) => x.symbol).map((x) => ({
      symbol: x.symbol, name: x.shortname || x.longname || x.symbol,
      exchange: x.exchDisp || x.exchange || "", type: x.quoteType || "",
    }));
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: "Search unavailable: " + String(e) });
  }
});

// Full detail for one stock — Avanza-style page data.
//   GET /api/stock/PLTR?range=5y
app.get("/api/stock/:ticker", requireAuth, async (req, res) => {
  try {
    const ticker = req.params.ticker;
    const sym = toYahoo(ticker);
    const rangeYears = ({ "1y": 1, "3y": 3, "5y": 5, "10y": 10 }[req.query.range]) || 5;

    const [summary, chart] = await Promise.allSettled([
      yahooFinance.quoteSummary(sym, {
        modules: [
          "price", "summaryDetail", "defaultKeyStatistics", "financialData",
          "calendarEvents", "summaryProfile", "institutionOwnership",
        ],
      }),
      yahooFinance.chart(sym, {
        period1: new Date(Date.now() - rangeYears * 365 * 24 * 60 * 60 * 1000),
        interval: rangeYears <= 1 ? "1d" : "1wk",
      }),
    ]);

    const s = summary.status === "fulfilled" ? summary.value : {};
    const sd = s.summaryDetail || {};
    const ks = s.defaultKeyStatistics || {};
    const fd = s.financialData || {};
    const pr = s.price || {};
    const prof = s.summaryProfile || {};
    const cal = s.calendarEvents || {};

    const history = chart.status === "fulfilled"
      ? (chart.value.quotes || [])
          .filter((q) => q.close != null)
          .map((q) => ({ t: q.date, c: q.close }))
      : [];

    const owners = (s.institutionOwnership?.ownershipList || []).slice(0, 8).map((o) => ({
      organization: o.organization,
      pctHeld: o.pctHeld != null ? o.pctHeld * 100 : null,
      value: o.value ?? null,
      reportDate: o.reportDate ?? null,
    }));

    const earningsDates = cal.earnings?.earningsDate || [];

    res.json({
      ticker,
      name: pr.longName || pr.shortName || ticker,
      currency: pr.currency || sd.currency || null,
      price: pr.regularMarketPrice ?? null,
      change: pr.regularMarketChangePercent != null ? pr.regularMarketChangePercent * 100 : null,
      sector: prof.sector || null,
      industry: prof.industry || null,
      country: prof.country || null,
      website: prof.website || null,
      summary: prof.longBusinessSummary || null,
      stats: {
        peTrailing: sd.trailingPE ?? null,
        peForward: ks.forwardPE ?? sd.forwardPE ?? null,
        ps: sd.priceToSalesTrailing12Months ?? null,
        pb: ks.priceToBook ?? null,
        eps: ks.trailingEps ?? null,
        marketCap: sd.marketCap ?? pr.marketCap ?? null,
        beta: sd.beta ?? ks.beta ?? null,
        dividendYield: sd.dividendYield != null ? sd.dividendYield * 100 : null,
        profitMargin: fd.profitMargins != null ? fd.profitMargins * 100 : null,
        revenueGrowth: fd.revenueGrowth != null ? fd.revenueGrowth * 100 : null,
        roe: fd.returnOnEquity != null ? fd.returnOnEquity * 100 : null,
        week52High: sd.fiftyTwoWeekHigh ?? null,
        week52Low: sd.fiftyTwoWeekLow ?? null,
        recommendation: fd.recommendationKey ?? null,
      },
      nextEarnings: earningsDates[0] ?? null,
      exDividend: cal.exDividendDate ?? null,
      dividendDate: cal.dividendDate ?? null,
      owners,
      history,
    });
  } catch (e) {
    res.status(502).json({ error: "Stock detail unavailable: " + String(e) });
  }
});

// FX rates -> SEK, fetched live (cached 1h)
let _fxCache = { at: 0, rates: null };
async function fxToSEK() {
  if (_fxCache.rates && Date.now() - _fxCache.at < 3600_000) return _fxCache.rates;
  const rates = { SEK: 1 };
  const pairs = { USD: "USDSEK=X", EUR: "EURSEK=X", DKK: "DKKSEK=X" };
  await Promise.allSettled(
    Object.entries(pairs).map(async ([cur, sym]) => {
      try { const q = await yahooFinance.quote(sym); rates[cur] = q.regularMarketPrice; } catch { /* leave undefined */ }
    })
  );
  _fxCache = { at: Date.now(), rates };
  return rates;
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const std = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };

// Portfolio analytics — OWNER ONLY.
//   Sharpe + volatility from 1y aligned returns, plus country/sector %.
app.get("/api/analytics", requireOwner, async (req, res) => {
  try {
    const fx = await fxToSEK();
    const RF = 0.03; // assumed annual risk-free rate

    const equities = [...HOLDINGS.stocks, ...HOLDINGS.etfs];
    const quotes = await fetchQuotes(equities.map((e) => e.ticker));

    // Current SEK value per holding
    const valued = equities.map((e) => {
      const price = quotes[e.ticker]?.price ?? e.avgCost;
      const rate = fx[e.currency] ?? 1;
      return { ...e, valueSEK: price * e.shares * rate };
    });
    const stockTotalSEK = valued.reduce((s, v) => s + v.valueSEK, 0) || 1;

    // Country & sector allocation (over whole portfolio incl. funds)
    const fundsSEK = HOLDINGS.funds.reduce((s, f) => s + (f.value || 0), 0);
    const grandTotal = stockTotalSEK + fundsSEK || 1;
    const byCountry = {}, bySector = {};
    valued.forEach((v) => {
      if (v.country) byCountry[v.country] = (byCountry[v.country] || 0) + v.valueSEK;
      if (v.sector)  bySector[v.sector]  = (bySector[v.sector]  || 0) + v.valueSEK;
    });
    if (fundsSEK) { byCountry["Funds"] = fundsSEK; bySector["Funds/ETF"] = fundsSEK; }
    const pct = (obj, total) => Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, +(v / total * 100).toFixed(1)]).sort((a, b) => b[1] - a[1])
    );

    // Sharpe / volatility from 1y daily history (aligned by date)
    let sharpe = null, volatility = null, annReturn = null;
    try {
      const since = new Date(Date.now() - 370 * 24 * 60 * 60 * 1000);
      const charts = await Promise.allSettled(
        valued.map((v) => yahooFinance.chart(toYahoo(v.ticker), { period1: since, interval: "1d" }))
      );
      const series = {}; // ticker -> Map(dateStr -> close)
      charts.forEach((c, i) => {
        if (c.status === "fulfilled") {
          const m = new Map();
          (c.value.quotes || []).forEach((q) => { if (q.close != null) m.set(new Date(q.date).toISOString().slice(0, 10), q.close); });
          series[valued[i].ticker] = m;
        }
      });
      const have = valued.filter((v) => series[v.ticker] && series[v.ticker].size > 30);
      if (have.length) {
        // dates present in every series
        let common = null;
        have.forEach((v) => {
          const keys = new Set(series[v.ticker].keys());
          common = common ? new Set([...common].filter((d) => keys.has(d))) : keys;
        });
        const dates = [...common].sort();
        if (dates.length > 30) {
          const wTotal = have.reduce((s, v) => s + v.valueSEK, 0) || 1;
          // portfolio index value at each date (weighted, normalised to t0)
          const idx = dates.map((d) =>
            have.reduce((s, v) => s + (v.valueSEK / wTotal) * (series[v.ticker].get(d) / series[v.ticker].get(dates[0])), 0)
          );
          const rets = [];
          for (let i = 1; i < idx.length; i++) rets.push(idx[i] / idx[i - 1] - 1);
          const dailyMean = mean(rets), dailyStd = std(rets);
          annReturn = +(dailyMean * 252 * 100).toFixed(2);
          volatility = +(dailyStd * Math.sqrt(252) * 100).toFixed(2);
          sharpe = dailyStd > 0 ? +(((dailyMean * 252) - RF) / (dailyStd * Math.sqrt(252))).toFixed(2) : null;
        }
      }
    } catch { /* leave nulls */ }

    res.json({
      totalSEK: Math.round(grandTotal),
      stockTotalSEK: Math.round(stockTotalSEK),
      fundsSEK: Math.round(fundsSEK),
      byCountry: pct(byCountry, grandTotal),
      bySector: pct(bySector, grandTotal),
      sharpe, volatility, annReturn, riskFree: RF * 100,
      updated: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Claude assistant proxy — owner only, avoids CORS + keeps API key server-side.
app.post("/api/assistant", requireOwner, async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(503).json({ error: "ANTHROPIC_API_KEY not set on server." });
  try {
    const { context, messages } = req.body || {};
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        system: `You are a sharp, concise financial assistant built into William's investment OS called Meridian. Be direct and analytical. Portfolio context: ${context || ""}`,
        messages: (messages || []).filter(m => m.role === "user" || m.role === "assistant"),
      }),
    });
    const data = await r.json();
    const reply = data.content?.[0]?.text || data.error?.message || "No response.";
    res.json({ reply });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Meridian backend running on http://localhost:${PORT}`);
  console.log(`   Tracking ${Object.keys(SYMBOL_MAP).length} symbols.`);
});
