// ───────────────────────────────────────────────────────────────
// backend/institutions.js
// Institutional positioning analysis for the signal engine.
//
// For a ticker, reads each major holder's CURRENT position and their
// quarter-over-quarter change from Yahoo's keyless quoteSummary modules
// (institutionOwnership, fundOwnership, majorHoldersBreakdown,
// netSharePurchaseActivity, insiderTransactions), then weights each
// institution by:
//    stake size      (% of shares outstanding held)
//  × recency         (how fresh the 13F report is)
//  × direction       (accumulating vs trimming, from pctChange)
//
// Output:
//   - a rich `positioning` object (top holders, accumulators, distributors,
//     insider net buying) for display + the crisis prompt
//   - a `signals[]` array (one per notable holder move + insider net) in the
//     SAME shape as the other sources in signals.js, scored as SEC-tier
//     "ground truth" so they dominate the aggregate appropriately.
//
// Self-contained: mirrors server.js's proven crumb logic so it works from
// Render's datacenter IP without importing the (entry-point) server.js.
// ───────────────────────────────────────────────────────────────

const YH = "https://query1.finance.yahoo.com";
const YH2 = "https://query2.finance.yahoo.com";
const YH_HEADERS = { "User-Agent": "Mozilla/5.0" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rawNum = (x) => (x && typeof x === "object" && "raw" in x ? x.raw : typeof x === "number" ? x : null);

// ── crumb-authenticated quoteSummary (mirrors server.js) ──
let _yc = { cookie: null, crumb: null, at: 0 };
const YC_TTL = 25 * 60_000;

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

async function quoteSummary(yahooSym, modules) {
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

const _cache = new Map();
async function cachedSummary(sym, modules) {
  const k = sym + "::" + modules.join(",");
  const c = _cache.get(k);
  if (c && Date.now() - c.at < 30 * 60_000) return c.res;
  const res = await quoteSummary(sym, modules);
  _cache.set(k, { at: Date.now(), res });
  return res;
}

// ── recency weight: a fresh 13F matters more than a stale one ──
function recencyWeight(reportTs) {
  if (!reportTs) return 0.5;
  const ageDays = (Date.now() - reportTs * 1000) / 86400_000;
  if (ageDays < 45) return 1.0;   // within the current quarter's filing window
  if (ageDays < 90) return 0.85;  // last quarter
  if (ageDays < 135) return 0.6;
  if (ageDays < 180) return 0.4;
  return 0.25;                     // stale
}

const isoDate = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null);

// Normalise a Yahoo ownership row into a clean holder object.
function normHolder(o) {
  const pctHeld = rawNum(o.pctHeld);            // fraction of shares outstanding
  const pctChange = rawNum(o.pctChange);        // Q/Q change in the position
  const reportTs = rawNum(o.reportDate);
  return {
    name: o.organization || "Unknown",
    pctHeld: pctHeld != null ? +(pctHeld * 100).toFixed(2) : null,
    shares: rawNum(o.position),
    value: rawNum(o.value),
    reportDate: isoDate(reportTs),
    pctChange: pctChange != null ? +(pctChange * 100).toFixed(1) : null,
    direction: pctChange == null ? "held" : pctChange > 0.005 ? "accumulating" : pctChange < -0.005 ? "trimming" : "held",
    _pctHeldFrac: pctHeld || 0,
    _pctChangeFrac: pctChange || 0,
    _recency: recencyWeight(reportTs),
  };
}

// ── MAIN: institutional positioning for one ticker ──
// `yahooSym` is the Yahoo symbol (for US tickers, identical to the ticker).
export async function fetchInstitutionalPositioning(yahooSym) {
  let s;
  try {
    s = await cachedSummary(yahooSym, [
      "institutionOwnership", "fundOwnership", "majorHoldersBreakdown",
      "netSharePurchaseActivity", "insiderTransactions",
    ]);
  } catch { return null; }

  const instList = (s.institutionOwnership?.ownershipList || []).map(normHolder);
  const fundList = (s.fundOwnership?.ownershipList || []).map(normHolder);
  // Merge, de-dupe by name (institution list wins), keep the biggest stakes.
  const byName = new Map();
  [...instList, ...fundList].forEach((h) => { if (!byName.has(h.name)) byName.set(h.name, h); });
  const holders = [...byName.values()].sort((a, b) => (b.value || 0) - (a.value || 0));
  if (holders.length === 0) return null;

  const mhb = s.majorHoldersBreakdown || {};
  const nspa = s.netSharePurchaseActivity || {};

  // Net institutional flow: each holder's stake-weighted, recency-weighted
  // direction. Big holders adding carry more weight than small holders trimming.
  let flowNum = 0, flowDen = 0;
  holders.forEach((h) => {
    const w = h._pctHeldFrac * h._recency;
    flowNum += w * Math.sign(h._pctChangeFrac) * Math.min(Math.abs(h._pctChangeFrac) * 4, 1);
    flowDen += w;
  });
  const netInstitutionalScore = flowDen > 0 ? +(flowNum / flowDen).toFixed(3) : 0;
  const netInstitutionalDirection = netInstitutionalScore > 0.08 ? "bullish" : netInstitutionalScore < -0.08 ? "bearish" : "neutral";

  // Insider net buying (% of insider shares net purchased over the window).
  const insiderNetPct = rawNum(nspa.netPercentInsiderShares);
  const insiderNetPercent = insiderNetPct != null ? +(insiderNetPct * 100).toFixed(2) : null;
  const insiderDirection = insiderNetPct == null ? "neutral" : insiderNetPct > 0.001 ? "bullish" : insiderNetPct < -0.001 ? "bearish" : "neutral";

  const recentInsiderTx = (s.insiderTransactions?.transactions || []).slice(0, 8).map((t) => ({
    filer: t.filerName || "—",
    relation: t.filerRelation || "",
    action: /purchase|buy|acqui/i.test(t.transactionText || "") ? "BUY"
          : /sale|sold|disp/i.test(t.transactionText || "") ? "SELL"
          : (t.transactionText || "—"),
    shares: rawNum(t.shares),
    value: rawNum(t.value),
    date: isoDate(rawNum(t.startDate)),
  }));

  const accumulating = holders.filter((h) => h.direction === "accumulating").slice(0, 6);
  const distributing = holders.filter((h) => h.direction === "trimming").slice(0, 6);

  const positioning = {
    symbol: yahooSym,
    institutionsPercentHeld: rawNum(mhb.institutionsPercentHeld) != null ? +(rawNum(mhb.institutionsPercentHeld) * 100).toFixed(1) : null,
    institutionsCount: rawNum(mhb.institutionsCount),
    insidersPercentHeld: rawNum(mhb.insidersPercentHeld) != null ? +(rawNum(mhb.insidersPercentHeld) * 100).toFixed(2) : null,
    topHolders: holders.slice(0, 10).map(({ _pctHeldFrac, _pctChangeFrac, _recency, ...rest }) => rest),
    accumulating: accumulating.map(({ _pctHeldFrac, _pctChangeFrac, _recency, ...r }) => r),
    distributing: distributing.map(({ _pctHeldFrac, _pctChangeFrac, _recency, ...r }) => r),
    netInstitutionalScore,
    netInstitutionalDirection,
    insiderNetPercent,
    insiderDirection,
    recentInsiderTx,
    summary:
      `Institutions hold ${rawNum(mhb.institutionsPercentHeld) != null ? (rawNum(mhb.institutionsPercentHeld) * 100).toFixed(0) + "%" : "—"} of ${yahooSym}` +
      ` across ${rawNum(mhb.institutionsCount) || "?"} filers; ` +
      `${accumulating.length} of the top holders are accumulating, ${distributing.length} trimming` +
      (insiderNetPercent != null ? `; insiders net ${insiderNetPercent >= 0 ? "+" : ""}${insiderNetPercent}% over the recent window.` : "."),
  };

  // ── Turn the notable moves into SEC-tier signals for the signal pool ──
  const signals = [];
  accumulating.slice(0, 4).forEach((h) => signals.push({
    source: "SEC 13F", headline: `${h.name} increased its ${yahooSym} stake ${h.pctChange != null ? "+" + h.pctChange + "%" : ""} (now ${h.pctHeld}% of shares)`.trim(),
    url: null, sentiment: 0.6, publishedAt: h.reportDate, engagement: 0, cluster: "institutionPositionChange",
  }));
  distributing.slice(0, 4).forEach((h) => signals.push({
    source: "SEC 13F", headline: `${h.name} trimmed its ${yahooSym} stake ${h.pctChange != null ? h.pctChange + "%" : ""} (now ${h.pctHeld}% of shares)`.trim(),
    url: null, sentiment: -0.6, publishedAt: h.reportDate, engagement: 0, cluster: "institutionPositionChange",
  }));
  if (insiderDirection !== "neutral") signals.push({
    source: "SEC Form 4", headline: `Insiders net ${insiderNetPercent >= 0 ? "bought" : "sold"} (${insiderNetPercent}% of insider shares) over the recent window`,
    url: null, sentiment: insiderDirection === "bullish" ? 0.7 : -0.7, publishedAt: nspa.period || null, engagement: 0, cluster: "insiderActivity",
  });

  return { positioning, signals };
}
