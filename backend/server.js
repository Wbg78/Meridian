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
import { toYahoo, SYMBOL_MAP, toTradingView } from "./symbols.js";

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
    { ticker: "FLXI", name: "Franklin FTSE India UCITS ETF", shares: 9, avgCost: 41.73,  currency: "EUR", country: "IN", region: "Asia",   sector: "Index ETF" },
    { ticker: "XACT", name: "XACT OMXS30 ESG",               shares: 1, avgCost: 329.00, currency: "SEK", country: "SE", region: "Europe", sector: "Index ETF" },
  ],
  // Funds aren't on Yahoo — keep their values manual. country/region/sector
  // are best-effort tags (from the fund's mandate) for the allocation views.
  funds: [
    { ticker: "AMF-LANG",  name: "AMF Räntefond Lång",          value: 5172,  gainPct: 3.43,  country: "SE",     region: "Europe", sector: "Bonds" },
    { ticker: "AVZ-GLO",   name: "Avanza Global",               value: 50191, gainPct: 18.17, country: "Global", region: "Global", sector: "Index Fund" },
    { ticker: "AVZ-USA",   name: "Avanza USA",                  value: 4703,  gainPct: 49.32, country: "US",     region: "North America", sector: "Index Fund" },
    { ticker: "AVZ-ZERO",  name: "Avanza Zero",                 value: 22374, gainPct: 13.40, country: "SE",     region: "Europe", sector: "Index Fund" },
    { ticker: "PLUS-FAST", name: "PLUS Fastigheter Sverige",    value: 1309,  gainPct: -6.49, country: "SE",     region: "Europe", sector: "Real Estate" },
    { ticker: "SWB-ASIEN", name: "Swedbank Robur Access Asien", value: 32648, gainPct: 29.56, country: "Asia",   region: "Asia",   sector: "Index Fund" },
  ],
};

// ─── helpers ────────────────────────────────────────────────────

// Yahoo's public v8 chart endpoint needs NO API key and NO "crumb"
// cookie, so (unlike the quote endpoint) it isn't blocked from cloud
// server IPs — and it covers every exchange we hold (US, Stockholm,
// Copenhagen, Paris, Xetra). This is the backbone of all live prices.
const YH = "https://query1.finance.yahoo.com";
// Minimal headers — a plain User-Agent is what Yahoo's v8 chart wants.
// (Adding Accept/extra headers makes it more likely to 429.)
const YH_HEADERS = { "User-Agent": "Mozilla/5.0" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET a Yahoo URL as JSON, retrying a couple of times on 429 (rate limit).
async function yahooFetch(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: YH_HEADERS });
    if (r.status === 429 && i < tries - 1) { await sleep(300 * (i + 1)); continue; }
    if (!r.ok) throw new Error("yahoo chart " + r.status);
    return r.json();
  }
  throw new Error("yahoo chart 429");
}

// Run async tasks with a concurrency cap so we don't burst Yahoo.
async function pooled(items, limit, fn) {
  const ret = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      ret[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return ret;
}

// Fetch the chart "meta" block (price, currency, prev close, 52wk) for
// ONE Yahoo symbol. Throws if the symbol returns no price.
async function yahooMeta(yahooSym) {
  const j = await yahooFetch(`${YH}/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=1d&range=1d`);
  const m = j?.chart?.result?.[0]?.meta;
  if (!m || m.regularMarketPrice == null) throw new Error("no data");
  return m;
}

// Daily/weekly close history for ONE Yahoo symbol over a Yahoo range
// string (1y, 2y, 5y, 10y, max). Uses adjusted close when available.
async function yahooHistory(yahooSym, { range = "1y", interval = "1d" } = {}) {
  const j = await yahooFetch(`${YH}/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=${interval}&range=${range}`);
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error("no data");
  const ts = res.timestamp || [];
  const closes = res.indicators?.quote?.[0]?.close || [];
  const adj = res.indicators?.adjclose?.[0]?.adjclose;
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const c = (adj && adj[i] != null) ? adj[i] : closes[i];
    if (c != null) out.push({ t: new Date(ts[i] * 1000), c });
  }
  return out;
}

// Period performance (1W/1M/3M/6M/1Y) from 1y of daily closes, cached 1h.
// 1D comes from the live quote's change, so it isn't computed here.
const _histCache = new Map(); // ticker -> { at, series }
const HIST_TTL = 60 * 60_000;

async function periodReturns(ticker) {
  const now = Date.now();
  let entry = _histCache.get(ticker);
  if (!entry || now - entry.at > HIST_TTL) {
    let series = [];
    try { series = await yahooHistory(toYahoo(ticker), { range: "1y", interval: "1d" }); } catch { /* empty */ }
    entry = { at: now, series };
    _histCache.set(ticker, entry);
  }
  const s = entry.series;
  if (s.length < 2) return {};
  const last = s[s.length - 1].c;
  const lastT = new Date(s[s.length - 1].t).getTime();
  const retSince = (days) => {
    const target = lastT - days * 86400000;
    for (let i = s.length - 1; i >= 0; i--) {
      if (new Date(s[i].t).getTime() <= target) {
        return s[i].c ? +(((last - s[i].c) / s[i].c) * 100).toFixed(2) : null;
      }
    }
    return null;
  };
  const first = s[0].c; // oldest point in the 1y window ≈ 1 year ago
  const y1 = first ? +(((last - first) / first) * 100).toFixed(2) : null;
  return { w1: retSince(7), m1: retSince(30), m3: retSince(91), m6: retSince(182), y1 };
}

// Map chart meta -> our quote shape. Change % is derived from the
// previous close. (PE/marketCap/divYield aren't in the chart meta;
// the stock-detail route enriches those separately.)
function metaToQuote(m, fallbackName) {
  const price = m.regularMarketPrice ?? null;
  const prev = m.chartPreviousClose ?? m.previousClose ?? null;
  const change = (price != null && prev) ? ((price - prev) / prev) * 100 : null;
  return {
    price,
    change,
    currency: m.currency ?? null,
    name: m.shortName || m.longName || fallbackName,
    week52High: m.fiftyTwoWeekHigh ?? null,
    week52Low: m.fiftyTwoWeekLow ?? null,
  };
}

// Cache so we don't hammer Yahoo on every page load.
const _quoteCache = new Map(); // ticker -> { at, data }
const QUOTE_TTL = 60_000;

// Live quotes for a list of *our* tickers (mapped to Yahoo symbols).
// Fetched in parallel via the keyless v8 chart endpoint, cached 60s.
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

  // Cap concurrency at 4 so a big portfolio doesn't burst Yahoo's limit.
  await pooled(need, 4, async (t) => {
    try {
      const m = await yahooMeta(toYahoo(t));
      const data = metaToQuote(m, t);
      out[t] = data;
      _quoteCache.set(t, { at: now, data });
    } catch (e) {
      out[t] = { price: null, change: null, error: String(e.message || e) };
    }
  });
  return out;
}

// ── Yahoo fundamentals via the crumb-authenticated quoteSummary API ──
// Unlike the chart endpoint, quoteSummary carries P/E, P/B, P/S, EPS,
// dividend yield, market cap, margins, etc. — for EVERY exchange we
// hold (US + Nordic + EU), for free. It needs a cookie + "crumb"; we
// fetch those ONCE and cache them (~25 min) so we don't trip the rate
// limiter that blocked the old library.
const YH2 = "https://query2.finance.yahoo.com";
let _yc = { cookie: null, crumb: null, at: 0 };
const YC_TTL = 25 * 60_000;

// Get a (cookie, crumb) pair, trying richer cookie sources and both
// Yahoo hosts — datacenter IPs get throttled, so we work to recover.
async function getYahooCreds(force = false) {
  if (!force && _yc.crumb && Date.now() - _yc.at < YC_TTL) return _yc;
  let cookie = "";
  for (const url of ["https://finance.yahoo.com/quote/AAPL", "https://fc.yahoo.com"]) {
    try {
      const cr = await fetch(url, { headers: YH_HEADERS });
      const sc = typeof cr.headers.getSetCookie === "function" ? cr.headers.getSetCookie() : [];
      if (sc.length) { cookie = sc.map((c) => c.split(";")[0]).join("; "); break; }
    } catch { /* try next */ }
  }
  let crumb = "";
  for (const host of [YH, YH2]) {
    try {
      const r = await fetch(`${host}/v1/test/getcrumb`, { headers: { ...YH_HEADERS, Cookie: cookie } });
      const c = (await r.text()).trim();
      if (c && !c.includes("<") && c.length <= 30) { crumb = c; break; }
    } catch { /* try next */ }
  }
  if (!crumb) throw new Error("no crumb");
  _yc = { cookie, crumb, at: Date.now() };
  return _yc;
}

// Fetch quoteSummary modules for ONE symbol. Reuses the cached crumb and
// only refreshes it ONCE on a 401 (so we don't hammer the crumb endpoint,
// which is what Yahoo rate-limits hardest from datacenter IPs). Backs off
// on 429/403. Alternates query1/query2 hosts.
async function yahooQuoteSummary(yahooSym, modules) {
  const mod = modules.join(",");
  let lastErr, refreshed = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const creds = await getYahooCreds();
      const host = attempt % 2 ? YH2 : YH;
      const url = `${host}/v10/finance/quoteSummary/${encodeURIComponent(yahooSym)}?modules=${mod}&crumb=${encodeURIComponent(creds.crumb)}`;
      const r = await fetch(url, { headers: { ...YH_HEADERS, Cookie: creds.cookie } });
      if (r.status === 401 && !refreshed) { refreshed = true; await getYahooCreds(true); continue; }
      if (r.status === 401 || r.status === 429 || r.status === 403) { lastErr = new Error("qs " + r.status); await sleep(500 * 2 ** attempt); continue; }
      if (!r.ok) throw new Error("quoteSummary " + r.status);
      const res = (await r.json())?.quoteSummary?.result?.[0];
      if (!res) throw new Error("no data");
      return res;
    } catch (e) { lastErr = e; await sleep(500 * 2 ** attempt); }
  }
  throw lastErr || new Error("quoteSummary failed");
}

// Cache full quoteSummary results per symbol (30 min) so once we get a
// good fetch through Render's flaky path, the detail page stays populated.
const _detailCache = new Map(); // yahooSym -> { at, res }
async function cachedSummary(sym, modules) {
  const c = _detailCache.get(sym);
  if (c && Date.now() - c.at < 30 * 60_000) return c.res;
  const res = await yahooQuoteSummary(sym, modules);
  _detailCache.set(sym, { at: Date.now(), res });
  return res;
}

// Yahoo wraps numbers as { raw, fmt }; pull the raw value.
const rawNum = (x) => (x && typeof x === "object" ? (x.raw ?? null) : (x ?? null));

// Fundamentals for our tickers, cached 6h (they barely move intraday).
const _fundCache = new Map(); // ticker -> { at, data }
const FUND_TTL = 6 * 3600_000;

async function yahooFundamentals(tickers) {
  const out = {};
  const now = Date.now();
  const need = [];
  for (const t of tickers) {
    const c = _fundCache.get(t);
    if (c && now - c.at < FUND_TTL) out[t] = c.data;
    else need.push(t);
  }
  await pooled(need, 3, async (t) => {
    try {
      const res = await yahooQuoteSummary(toYahoo(t), ["summaryDetail", "defaultKeyStatistics", "price"]);
      const sd = res.summaryDetail || {}, ks = res.defaultKeyStatistics || {}, pr = res.price || {};
      const dy = rawNum(sd.dividendYield) ?? rawNum(sd.trailingAnnualDividendYield);
      const data = {
        pe: rawNum(sd.trailingPE),
        forwardPe: rawNum(ks.forwardPE) ?? rawNum(sd.forwardPE),
        ps: rawNum(sd.priceToSalesTrailing12Months),
        pb: rawNum(ks.priceToBook),
        eps: rawNum(ks.trailingEps),
        marketCap: rawNum(sd.marketCap) ?? rawNum(pr.marketCap),
        divYield: dy != null ? dy * 100 : null,
        beta: rawNum(sd.beta) ?? rawNum(ks.beta),
      };
      out[t] = data;
      _fundCache.set(t, { at: now, data });
    } catch { out[t] = {}; }
  });
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
    const [quotes, funds, perfList] = await Promise.all([
      fetchQuotes(liveTickers),
      yahooFundamentals(HOLDINGS.stocks.map((s) => s.ticker)),
      pooled(liveTickers, 4, (t) => periodReturns(t).then((p) => [t, p]).catch(() => [t, {}])),
    ]);
    const perf = Object.fromEntries(perfList);

    const stocks = HOLDINGS.stocks.map((s) => {
      const q = quotes[s.ticker] || {};
      const f = funds[s.ticker] || {};
      const price = q.price ?? null;
      return {
        ...s,
        price,
        change: q.change ?? null,
        gainPct: price != null ? ((price - s.avgCost) / s.avgCost) * 100 : null,
        perf: { d1: q.change ?? null, ...(perf[s.ticker] || {}) },
        pe: f.pe ?? null, pb: f.pb ?? null, ps: f.ps ?? null, eps: f.eps ?? null,
        marketCap: f.marketCap ?? null, divYield: f.divYield ?? null,
        week52High: q.week52High ?? null, week52Low: q.week52Low ?? null,
        tvSymbol: toTradingView(s.ticker),
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
        perf: { d1: q.change ?? null, ...(perf[e.ticker] || {}) },
        tvSymbol: toTradingView(e.ticker),
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
    // Free-form query (used by Analytics drill-down: news for a country/
    // sector/fund slice). Returns last 7 days for that search.
    const q = (req.query.q || "").trim();
    if (q) {
      const articles = dedupe(await fetchGoogleNews(q, { hl: "en-US", gl: "US", ceid: "US:en" }, 7))
        .sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 12);
      return res.json({ categories, articles });
    }
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

// ─── SENTIMENT (free, transparent) ──────────────────────────────
// Market-wide: the REAL CNN Fear & Greed index. Per-stock: a finance-
// lexicon score over the week's news headlines, returning the headlines
// themselves as evidence so the number is never a black box. (X/Twitter
// and StockTwits APIs are paid; this is the honest free alternative.)
const BULL_WORDS = /\b(surg\w*|soar\w*|jump\w*|rall\w*|beat\w*|tops?|upgrad\w*|record|grow\w*|gains?|rise|rises|rising|risen|rose|climb\w*|outperform\w*|bullish|strong\w*|profit\w*|wins?|won|contract\w*|approv\w*|expand\w*|rais\w*|boost\w*|optimis\w*|breakthrough|rebound\w*|higher|surpass\w*|rocket\w*|soars?|best)\b/gi;
const BEAR_WORDS = /\b(fall\w*|fell|drop\w*|plung\w*|slump\w*|miss\w*|downgrad\w*|loss\w*|lawsuit\w*|prob\w*|investigat\w*|cuts?|warn\w*|weak\w*|declin\w*|sink\w*|sell-?off\w*|bearish|recall\w*|fraud|scrutiny|layoff\w*|halts?|tumbl\w*|crash\w*|fears?|risks?|disappoint\w*|slash\w*|lower|downturn|bankrupt\w*|delay\w*|worst|slow\w*|woes?|sluggish|cools?)\b/gi;

function leanOf(text) {
  const t = " " + (text || "") + " ";
  const b = (t.match(BULL_WORDS) || []).length;
  const r = (t.match(BEAR_WORDS) || []).length;
  return b > r ? "bull" : r > b ? "bear" : "neutral";
}

let _fgCache = { at: 0, data: null };
async function fearGreed() {
  if (_fgCache.data && Date.now() - _fgCache.at < 3600_000) return _fgCache.data;
  try {
    const r = await fetch("https://production.dataviz.cnn.io/index/fearandgreed/current", {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", "Referer": "https://www.cnn.com/markets/fear-and-greed" },
    });
    if (!r.ok) throw new Error("cnn " + r.status);
    const d = await r.json();
    const data = {
      score: Math.round(d.score),
      rating: d.rating,
      previousClose: Math.round(d.previous_close),
      week: Math.round(d.previous_1_week),
      month: Math.round(d.previous_1_month),
      year: Math.round(d.previous_1_year),
    };
    _fgCache = { at: Date.now(), data };
    return data;
  } catch { return null; }
}

let _sentCache = { at: 0, data: null };
const SENT_TTL = 30 * 60_000;

app.get("/api/sentiment", requireAuth, async (req, res) => {
  try {
    if (_sentCache.data && Date.now() - _sentCache.at < SENT_TTL) return res.json(_sentCache.data);
    const fg = await fearGreed();
    const entries = Object.entries(HOLDINGS_NEWS_TERMS); // [ticker, searchTerm]
    const scored = await pooled(entries, 4, async ([ticker, term]) => {
      let articles = [];
      try {
        articles = (await fetchGoogleNews(`${term} stock`, { hl: "en-US", gl: "US", ceid: "US:en" }, 7)).slice(0, 8);
      } catch { /* leave empty */ }
      const headlines = articles.map((a) => ({ headline: a.headline, source: a.source, link: a.link, time: a.time, lean: leanOf(a.headline) }));
      const bull = headlines.filter((h) => h.lean === "bull").length;
      const bear = headlines.filter((h) => h.lean === "bear").length;
      const denom = headlines.length || 1;
      const name = (HOLDINGS.stocks.find((s) => s.ticker === ticker) || {}).name || term;
      return {
        ticker, name, mentions: headlines.length,
        bullish: Math.round((bull / denom) * 100),
        bearish: Math.round((bear / denom) * 100),
        neutral: Math.round(((denom - bull - bear) / denom) * 100),
        label: bull > bear ? "Bullish" : bear > bull ? "Bearish" : "Neutral",
        net: bull - bear,
        headlines,
      };
    });
    scored.sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || b.mentions - a.mentions);
    const data = { fearGreed: fg, tickers: scored, updated: new Date().toISOString() };
    _sentCache = { at: Date.now(), data };
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: "Sentiment unavailable: " + String(e) });
  }
});

// Congressional trades — US Senate + House STOCK Act disclosures, via
// Financial Modeling Prep's free /stable API (key-based, server-friendly).
app.get("/api/capitol", requireAuth, async (req, res) => {
  const key = process.env.FMP_API_KEY;
  if (!key) return res.status(503).json({ error: "FMP_API_KEY not set on server." });
  try {
    const [sen, house] = await Promise.allSettled([
      fetch(`https://financialmodelingprep.com/stable/senate-latest?apikey=${key}`).then((r) => r.json()),
      fetch(`https://financialmodelingprep.com/stable/house-latest?apikey=${key}`).then((r) => r.json()),
    ]);
    const norm = (arr, chamber) => (Array.isArray(arr) ? arr : []).map((t) => ({
      name: `${t.firstName || ""} ${t.lastName || ""}`.trim() || t.office || "Unknown",
      chamber,
      party: "",   // FMP doesn't expose party; frontend falls back to chamber.
      ticker: t.symbol || "—",
      action: /sale|sold/i.test(t.type || "") ? "SELL"
            : /purchase|buy/i.test(t.type || "") ? "BUY"
            : (t.type || "—"),
      amount: t.amount || "—",
      date: t.transactionDate || t.disclosureDate || null,
      asset: t.assetDescription || "",
    }));
    const feed = [
      ...(sen.status === "fulfilled" ? norm(sen.value, "Senate") : []),
      ...(house.status === "fulfilled" ? norm(house.value, "House") : []),
    ]
      .filter((x) => x.date)
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 30);
    if (!feed.length) throw new Error("no disclosures returned");
    res.json(feed);
  } catch (e) {
    res.status(502).json({ error: "Congress trades unavailable: " + String(e) });
  }
});

// Screener — top movers from Financial Modeling Prep (free /stable API).
// Key-based, so it works from any server IP (unlike Finviz scraping).
//   ?view=topgainers (default) | losers | mostactive
app.get("/api/screener", requireAuth, async (req, res) => {
  const key = process.env.FMP_API_KEY;
  if (!key) return res.status(503).json({ error: "FMP_API_KEY not set on server." });
  try {
    const map = { topgainers: "biggest-gainers", losers: "biggest-losers", mostactive: "most-actives" };
    const endpoint = map[req.query.view] || "biggest-gainers";
    const r = await fetch(`https://financialmodelingprep.com/stable/${endpoint}?apikey=${key}`);
    if (!r.ok) throw new Error("fmp " + r.status);
    const data = await r.json();
    if (!Array.isArray(data)) throw new Error(data?.["Error Message"] || "unexpected response");
    const rows = data.slice(0, 20).map((d) => ({
      ticker: d.symbol,
      name: d.name || d.symbol,
      price: d.price ?? null,
      change: d.changesPercentage ?? null,   // already a percent
      exchange: d.exchange || null,
    }));
    res.json({ rows, source: "financialmodelingprep" });
  } catch (e) {
    res.status(502).json({ error: "Screener unavailable: " + String(e) });
  }
});

// Market overview — indices, commodities, crypto (batched, one request).
// Each entry: [yahooSymbol, label, tradingViewSymbol]. TV symbols use the
// freely-viewable OANDA CFD / TVC feeds (the real exchange index symbols
// like SP:SPX are gated behind a paid TradingView subscription).
const MARKET_GROUPS = {
  indices: [["^GSPC", "S&P 500", "OANDA:SPX500USD"], ["^IXIC", "Nasdaq", "OANDA:NAS100USD"], ["^DJI", "Dow Jones", "OANDA:US30USD"], ["^OMX", "OMXS30", "OANDA:SE30SEK"], ["^GDAXI", "DAX", "OANDA:DE30EUR"], ["^FTSE", "FTSE 100", "OANDA:UK100GBP"], ["^VIX", "VIX", "TVC:VIX"]],
  commodities: [["GC=F", "Gold", "TVC:GOLD"], ["CL=F", "Crude Oil", "TVC:USOIL"], ["BZ=F", "Brent", "TVC:UKOIL"], ["SI=F", "Silver", "TVC:SILVER"], ["NG=F", "Nat Gas", "OANDA:NATGASUSD"], ["HG=F", "Copper", "OANDA:XCUUSD"]],
  crypto: [["BTC-USD", "Bitcoin", "BINANCE:BTCUSDT"], ["ETH-USD", "Ethereum", "BINANCE:ETHUSDT"]],
  fx: [["USDSEK=X", "USD/SEK", "FX:USDSEK"], ["EURSEK=X", "EUR/SEK", "FX:EURSEK"]],
};
app.get("/api/market", requireAuth, async (req, res) => {
  try {
    const all = Object.values(MARKET_GROUPS).flat().map((x) => x[0]);
    const q = await fetchQuotes(all);
    const build = (list) => list.map(([sym, label, tv]) => ({
      symbol: sym, label, tvSymbol: tv, price: q[sym]?.price ?? null,
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
    const r = await fetch(`${YH}/v1/finance/search?q=${encodeURIComponent(qstr)}&quotesCount=8&newsCount=0`, { headers: YH_HEADERS });
    if (!r.ok) throw new Error("yahoo search " + r.status);
    const j = await r.json();
    const out = (j.quotes || []).filter((x) => x.symbol).map((x) => ({
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
    const rangeMap = {
      "1y":  { range: "1y",  interval: "1d"  },
      "3y":  { range: "5y",  interval: "1wk" },
      "5y":  { range: "5y",  interval: "1wk" },
      "10y": { range: "10y", interval: "1wk" },
    };
    const rg = rangeMap[req.query.range] || rangeMap["5y"];

    // Price/52wk + history from the keyless chart endpoint (all exchanges).
    // Fundamentals/profile/earnings/owners from quoteSummary (crumb-based,
    // also all exchanges). Everything is best-effort: if quoteSummary is
    // unavailable the page still shows price + chart.
    const [metaR, histR, sumR] = await Promise.allSettled([
      yahooMeta(sym),
      yahooHistory(sym, rg),
      cachedSummary(sym, [
        "price", "summaryDetail", "defaultKeyStatistics", "financialData",
        "calendarEvents", "summaryProfile", "institutionOwnership",
      ]),
    ]);

    const m    = metaR.status === "fulfilled" ? metaR.value : {};
    const hist = histR.status === "fulfilled" ? histR.value : [];
    const s    = sumR.status === "fulfilled" ? sumR.value : {};
    const sd = s.summaryDetail || {}, ks = s.defaultKeyStatistics || {};
    const fd = s.financialData || {}, pr = s.price || {};
    const prof = s.summaryProfile || {}, cal = s.calendarEvents || {};

    const price = m.regularMarketPrice ?? rawNum(pr.regularMarketPrice) ?? null;
    const prev  = m.chartPreviousClose ?? m.previousClose ?? null;
    const change = (price != null && prev) ? ((price - prev) / prev) * 100
                 : rawNum(pr.regularMarketChangePercent) != null ? rawNum(pr.regularMarketChangePercent) * 100 : null;
    const pctOf = (x) => { const v = rawNum(x); return v != null ? v * 100 : null; };

    const owners = (s.institutionOwnership?.ownershipList || []).slice(0, 8).map((o) => ({
      organization: o.organization,
      pctHeld: pctOf(o.pctHeld),
      value: rawNum(o.value),
      reportDate: rawNum(o.reportDate) ? new Date(rawNum(o.reportDate) * 1000).toISOString().slice(0, 10) : null,
    }));
    const earningsDates = cal.earnings?.earningsDate || [];

    res.json({
      ticker,
      tvSymbol: toTradingView(ticker),
      name: pr.longName || pr.shortName || m.longName || m.shortName || ticker,
      currency: m.currency || pr.currency || null,
      price,
      change,
      sector: prof.sector || null,
      industry: prof.industry || null,
      country: prof.country || null,
      website: prof.website || null,
      summary: prof.longBusinessSummary || null,
      stats: {
        peTrailing: rawNum(sd.trailingPE),
        peForward: rawNum(ks.forwardPE) ?? rawNum(sd.forwardPE),
        ps: rawNum(sd.priceToSalesTrailing12Months),
        pb: rawNum(ks.priceToBook),
        eps: rawNum(ks.trailingEps),
        marketCap: rawNum(sd.marketCap) ?? rawNum(pr.marketCap),
        beta: rawNum(sd.beta) ?? rawNum(ks.beta),
        dividendYield: pctOf(sd.dividendYield),
        profitMargin: pctOf(fd.profitMargins),
        revenueGrowth: pctOf(fd.revenueGrowth),
        roe: pctOf(fd.returnOnEquity),
        week52High: m.fiftyTwoWeekHigh ?? rawNum(sd.fiftyTwoWeekHigh),
        week52Low: m.fiftyTwoWeekLow ?? rawNum(sd.fiftyTwoWeekLow),
        recommendation: fd.recommendationKey ?? null,
      },
      nextEarnings: rawNum(earningsDates[0]) ? new Date(rawNum(earningsDates[0]) * 1000).toISOString().slice(0, 10) : null,
      exDividend: rawNum(cal.exDividendDate) ? new Date(rawNum(cal.exDividendDate) * 1000).toISOString().slice(0, 10) : null,
      dividendDate: rawNum(cal.dividendDate) ? new Date(rawNum(cal.dividendDate) * 1000).toISOString().slice(0, 10) : null,
      owners,
      history: hist.map((p) => ({ t: p.t, c: p.c })),
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
      try { const m = await yahooMeta(sym); rates[cur] = m.regularMarketPrice; } catch { /* leave undefined */ }
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

    // Build one flat list of EVERY holding (stocks + ETFs + funds) tagged
    // with the dimensions we slice by, then compute allocations + drill-down.
    const fundsSEK = HOLDINGS.funds.reduce((s, f) => s + (f.value || 0), 0);
    const grandTotal = stockTotalSEK + fundsSEK || 1;
    const REGION = { US: "North America", CA: "North America", SE: "Europe", DK: "Europe", FR: "Europe", DE: "Europe", GB: "Europe", NO: "Europe", FI: "Europe", NL: "Europe", CH: "Europe", IN: "Asia", CN: "Asia", JP: "Asia", HK: "Asia" };
    const regionOf = (c, fb) => REGION[c] || fb || "Other";

    const priceSEK = (h) => (quotes[h.ticker]?.price ?? h.avgCost) * h.shares * (fx[h.currency] ?? 1);
    const allHoldings = [
      ...HOLDINGS.stocks.map((s) => ({ ticker: s.ticker, name: s.name, valueSEK: priceSEK(s), assetClass: "Stocks", sector: s.sector || "Other", country: s.country || "—", region: regionOf(s.country) })),
      ...HOLDINGS.etfs.map((e)   => ({ ticker: e.ticker, name: e.name, valueSEK: priceSEK(e), assetClass: "ETFs",   sector: e.sector || "Index ETF", country: e.country || "—", region: e.region || regionOf(e.country, "Global") })),
      ...HOLDINGS.funds.map((f)  => ({ ticker: f.ticker, name: f.name, valueSEK: f.value || 0,  assetClass: "Funds",  sector: f.sector || "Funds & ETFs", country: f.country || "—", region: f.region || "Global" })),
    ];

    // Group holdings by a dimension -> [{ key, valueSEK, pct, holdings:[…] }]
    const allocate = (dim) => {
      const groups = {};
      allHoldings.forEach((h) => { (groups[h[dim]] ||= []).push(h); });
      return Object.entries(groups).map(([key, hs]) => {
        const valueSEK = hs.reduce((s, h) => s + h.valueSEK, 0);
        return {
          key,
          valueSEK: Math.round(valueSEK),
          pct: +(valueSEK / grandTotal * 100).toFixed(1),
          holdings: hs
            .map((h) => ({ ticker: h.ticker, name: h.name, valueSEK: Math.round(h.valueSEK), pct: +(h.valueSEK / grandTotal * 100).toFixed(1) }))
            .sort((a, b) => b.valueSEK - a.valueSEK),
        };
      }).sort((a, b) => b.valueSEK - a.valueSEK);
    };
    const allocations = {
      assetClass: allocate("assetClass"),
      sector: allocate("sector"),
      country: allocate("country"),
      region: allocate("region"),
    };

    // Sharpe / volatility from 1y daily history (aligned by date)
    let sharpe = null, volatility = null, annReturn = null;
    try {
      const charts = await pooled(valued, 4, (v) =>
        yahooHistory(toYahoo(v.ticker), { range: "1y", interval: "1d" }).catch(() => null)
      );
      const series = {}; // ticker -> Map(dateStr -> close)
      charts.forEach((arr, i) => {
        if (arr) {
          const m = new Map();
          arr.forEach((p) => { if (p.c != null) m.set(new Date(p.t).toISOString().slice(0, 10), p.c); });
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
      allocations,
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
