// ───────────────────────────────────────────────────────────────
// backend/edgar.js
// DETERMINISTIC SEC EDGAR client.
//
// Rule of the whole research engine: the agent NEVER invents a number.
// Revenue, segments, debt, margins — they come from here, as clean JSON
// pulled straight from the SEC. The LLM only reasons over them.
//
// EDGAR is free and needs no API key, BUT it requires a descriptive
// User-Agent with contact info or it returns 403. Set SEC_USER_AGENT in
// your .env, e.g.  SEC_USER_AGENT="Meridian/1.0 william@williamgrip.se"
//
// Coverage note: EDGAR only has US filers (10-K/10-Q/8-K) + foreign
// filers that file 20-F. Your Nordic holdings (INVE-B, NIBE-B…) won't
// resolve — that's expected. The pipeline falls back to web search for
// those; this file just returns null and the agent copes.
// ───────────────────────────────────────────────────────────────

const SEC_UA =
  process.env.SEC_USER_AGENT ||
  "Meridian research tool (set SEC_USER_AGENT in .env with your email)";
const H = { "User-Agent": SEC_UA };

if (!process.env.SEC_USER_AGENT) {
  console.warn("⚠  SEC_USER_AGENT not set — EDGAR may 403. Put your email in .env.");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function secFetch(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: H });
    if (r.status === 429 && i < tries - 1) { await sleep(400 * (i + 1)); continue; }
    if (!r.ok) throw new Error("edgar " + r.status + " " + url);
    return r;
  }
  throw new Error("edgar retries exhausted");
}

// ─── ticker → CIK ───────────────────────────────────────────────
// SEC publishes one big map. ~1MB, so cache it 24h.
let _map = { at: 0, byTicker: null };
async function loadTickerMap() {
  if (_map.byTicker && Date.now() - _map.at < 24 * 3600_000) return _map.byTicker;
  const r = await secFetch("https://www.sec.gov/files/company_tickers.json");
  const j = await r.json(); // { "0": { cik_str, ticker, title }, ... }
  const byTicker = {};
  for (const k in j) byTicker[j[k].ticker.toUpperCase()] = j[k];
  _map = { at: Date.now(), byTicker };
  return byTicker;
}

const pad = (cik) => String(cik).padStart(10, "0");

// Resolve "PLTR" (or "BRK-B") to { cik, paddedCik, name }. null if not US.
export async function resolveCik(ticker) {
  const map = await loadTickerMap();
  const exact = ticker.toUpperCase();
  // Try exact, then strip a Yahoo-style suffix (.ST, -B), then bare base.
  const candidates = [exact, exact.replace(/[.\-].*$/, "")];
  for (const c of candidates) {
    if (map[c]) {
      const e = map[c];
      return { cik: e.cik_str, paddedCik: pad(e.cik_str), name: e.title };
    }
  }
  return null;
}

// ─── company facts (XBRL financials) ────────────────────────────
// Different filers tag the same concept differently, so we try a list
// and take the first that resolves.
const CONCEPTS = {
  revenue: [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
  ],
  netIncome: ["NetIncomeLoss"],
  grossProfit: ["GrossProfit"],
  operatingIncome: ["OperatingIncomeLoss"],
  assets: ["Assets"],
  liabilities: ["Liabilities"],
  longTermDebt: ["LongTermDebtNoncurrent", "LongTermDebt"],
  cash: ["CashAndCashEquivalentsAtCarryingValue"],
  rAndD: ["ResearchAndDevelopmentExpense"],
};

// Pull annual (10-K, full-year) values for one concept, newest first.
function annualSeries(facts, names) {
  const gaap = facts?.facts?.["us-gaap"] || {};
  for (const name of names) {
    const usd = gaap[name]?.units?.USD;
    if (!usd) continue;
    const rows = usd
      .filter((x) => x.form === "10-K" && x.fp === "FY" && x.val != null)
      // dedupe by fiscal year, keep the most recently filed value
      .sort((a, b) => new Date(b.filed) - new Date(a.filed));
    const byFy = {};
    for (const x of rows) if (byFy[x.fy] == null) byFy[x.fy] = { fy: x.fy, end: x.end, val: x.val };
    const out = Object.values(byFy).sort((a, b) => b.fy - a.fy).slice(0, 5);
    if (out.length) return { concept: name, series: out };
  }
  return null;
}

// Returns a compact, model-ready financial spine — or null if not a US filer.
export async function getFinancials(ticker) {
  const id = await resolveCik(ticker);
  if (!id) return null;
  let facts;
  try {
    const r = await secFetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${id.paddedCik}.json`);
    facts = await r.json();
  } catch {
    return { cik: id.cik, name: id.name, note: "companyfacts unavailable" };
  }

  const out = { cik: id.cik, name: id.name, concepts: {} };
  for (const key in CONCEPTS) {
    const got = annualSeries(facts, CONCEPTS[key]);
    if (got) out.concepts[key] = got;
  }

  // Derive a couple of obvious ratios when both legs exist (no LLM math).
  const rev = out.concepts.revenue?.series?.[0]?.val;
  const gp = out.concepts.grossProfit?.series?.[0]?.val;
  const ni = out.concepts.netIncome?.series?.[0]?.val;
  out.derived = {
    grossMarginPct: rev && gp != null ? +((gp / rev) * 100).toFixed(1) : null,
    netMarginPct: rev && ni != null ? +((ni / rev) * 100).toFixed(1) : null,
    revenueCagr3yPct: revCagr(out.concepts.revenue?.series),
  };
  return out;
}

function revCagr(series) {
  if (!series || series.length < 3) return null;
  const newest = series[0].val, old = series[Math.min(series.length - 1, 3)].val;
  const yrs = series[0].fy - series[Math.min(series.length - 1, 3)].fy;
  if (!old || old <= 0 || !yrs) return null;
  return +(((Math.pow(newest / old, 1 / yrs) - 1) * 100)).toFixed(1);
}

// ─── recent filings (events) ────────────────────────────────────
// 8-Ks are event-driven — exactly what a crisis analysis wants to see.
export async function getRecentFilings(ticker, { forms = ["10-K", "10-Q", "8-K"], limit = 12 } = {}) {
  const id = await resolveCik(ticker);
  if (!id) return null;
  const r = await secFetch(`https://data.sec.gov/submissions/CIK${id.paddedCik}.json`);
  const j = await r.json();
  const rec = j.filings?.recent;
  if (!rec) return [];
  const out = [];
  for (let i = 0; i < rec.accessionNumber.length && out.length < limit; i++) {
    if (!forms.includes(rec.form[i])) continue;
    const acc = rec.accessionNumber[i].replace(/-/g, "");
    out.push({
      form: rec.form[i],
      date: rec.filingDate[i],
      title: rec.primaryDocDescription?.[i] || rec.form[i],
      url: `https://www.sec.gov/Archives/edgar/data/${id.cik}/${acc}/${rec.primaryDocument[i]}`,
    });
  }
  return out;
}

// ─── filing text (Business + Risk Factors) ──────────────────────
// Filings are big HTML. We strip tags and return a bounded slice that
// covers the narrative the ontology pass needs, without blowing tokens.
export async function getFilingText(url, maxChars = 45000) {
  const r = await secFetch(url);
  const html = await r.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Prefer the window around "Risk Factors" if we can find it; else head.
  const rfIdx = text.search(/Item\s*1A[.\s]*Risk Factors/i);
  if (rfIdx > 0) {
    const head = text.slice(0, Math.floor(maxChars * 0.45));
    const risk = text.slice(rfIdx, rfIdx + Math.floor(maxChars * 0.55));
    return head + " […] " + risk;
  }
  return text.slice(0, maxChars);
}

// Convenience: everything deterministic about a US ticker in one shot.
export async function buildEdgarSpine(ticker) {
  const [financials, filings] = await Promise.all([
    getFinancials(ticker).catch(() => null),
    getRecentFilings(ticker).catch(() => null),
  ]);
  if (!financials && !filings) return null;
  let filingText = null;
  const tenK = (filings || []).find((f) => f.form === "10-K");
  if (tenK) filingText = await getFilingText(tenK.url).catch(() => null);
  return { financials, filings, filingText, source10K: tenK?.url || null };
}
