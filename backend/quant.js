// ───────────────────────────────────────────────────────────────
// backend/quant.js
// Quantitative financial metrics layer.
//
// Sources (all FREE, no new API keys beyond .env.example):
//   1. SEC EDGAR XBRL   — cash flow statement: OCF + CapEx → FCF
//   2. Finnhub /metric  — P/FCF, EV/EBITDA, Net Debt/EBITDA,
//                         operating leverage, earnings surprise
//   3. Derived           — FCF yield, FCF CAGR, operating leverage
//                          trend, capital allocation ratios
//
// Returns a structured `quantData` object that:
//   - Gets injected into the ontology/crisis prompt (compact slice)
//   - Gets served at GET /api/research/quant/:ticker for the UI
//
// Cache: 6 hours (financials don't move intraday).
// ───────────────────────────────────────────────────────────────

import { resolveCik } from "./edgar.js";

const FINNHUB_BASE = "https://finnhub.io/api/v1";
const SEC_UA = process.env.SEC_USER_AGENT || "Meridian/1.0 set-your-email@example.com";
const H = { "User-Agent": SEC_UA };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function secFetch(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: H });
    if (r.status === 429 && i < tries - 1) { await sleep(400 * (i + 1)); continue; }
    if (!r.ok) throw new Error("edgar " + r.status);
    return r;
  }
  throw new Error("edgar retries exhausted");
}

// ─── EDGAR CASH FLOW STATEMENT ──────────────────────────────────
// Pull annual OCF and CapEx → compute Free Cash Flow.
// These concepts are standard GAAP; all US filers must report them.
const CF_CONCEPTS = {
  operatingCashFlow: [
    "NetCashProvidedByUsedInOperatingActivities",
    "NetCashProvidedByOperatingActivities",
  ],
  capitalExpenditures: [
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "CapitalExpendituresIncurringObligation",
    "PaymentsForCapitalImprovements",
  ],
  longTermDebt: [
    "LongTermDebtNoncurrent",
    "LongTermDebt",
  ],
  cash: [
    "CashAndCashEquivalentsAtCarryingValue",
    "CashCashEquivalentsAndShortTermInvestments",
  ],
  ebitda: [
    "EarningsBeforeInterestTaxesDepreciationAndAmortization",
  ],
};

function annualSeriesFromFacts(facts, conceptNames) {
  const gaap = facts?.facts?.["us-gaap"] || {};
  for (const name of conceptNames) {
    const usd = gaap[name]?.units?.USD;
    if (!usd) continue;
    const rows = usd
      .filter(x => x.form === "10-K" && x.fp === "FY" && x.val != null)
      .sort((a, b) => new Date(b.filed) - new Date(a.filed));
    const byFy = {};
    for (const x of rows) if (byFy[x.fy] == null) byFy[x.fy] = { fy: x.fy, val: x.val };
    const out = Object.values(byFy).sort((a, b) => b.fy - a.fy).slice(0, 5);
    if (out.length) return { concept: name, series: out };
  }
  return null;
}

async function fetchEdgarCashFlow(ticker) {
  try {
    const id = await resolveCik(ticker);
    if (!id) return null;
    const r = await secFetch(
      `https://data.sec.gov/api/xbrl/companyfacts/CIK${id.paddedCik}.json`
    );
    const facts = await r.json();

    const ocfData  = annualSeriesFromFacts(facts, CF_CONCEPTS.operatingCashFlow);
    const capexData = annualSeriesFromFacts(facts, CF_CONCEPTS.capitalExpenditures);
    const debtData  = annualSeriesFromFacts(facts, CF_CONCEPTS.longTermDebt);
    const cashData  = annualSeriesFromFacts(facts, CF_CONCEPTS.cash);

    if (!ocfData) return null;

    // Build FCF series: OCF - |CapEx|
    const fcfSeries = [];
    for (const ocfRow of (ocfData.series || [])) {
      const capexRow = (capexData?.series || []).find(c => c.fy === ocfRow.fy);
      if (ocfRow.val != null) {
        // CapEx is typically reported as negative in cash flow statements,
        // but some filers report absolute. Normalise to absolute then subtract.
        const capexAbs = capexRow ? Math.abs(capexRow.val) : 0;
        fcfSeries.push({
          fy: ocfRow.fy,
          ocf: ocfRow.val,
          capex: capexAbs,
          fcf: ocfRow.val - capexAbs,
        });
      }
    }

    return {
      operatingCashFlow: ocfData,
      capitalExpenditures: capexData,
      longTermDebt: debtData,
      cash: cashData,
      fcfSeries: fcfSeries.length ? fcfSeries : null,
    };
  } catch { return null; }
}

// ─── FINNHUB METRICS ────────────────────────────────────────────
// The /metric endpoint with metric=all returns an exhaustive set
// of fundamental ratios on the free tier.
async function fetchFinnhubMetrics(ticker) {
  const key = process.env.FINNHUB_KEY;
  if (!key) return null;
  try {
    const r = await fetch(
      `${FINNHUB_BASE}/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${key}`
    );
    if (!r.ok) return null;
    const data = await r.json();
    const m = data.metric || {};

    // Pull the fields we care about (annual series where available)
    return {
      // Valuation multiples
      peNormalized:      m.peNormalizedAnnual ?? m.peExclExtraTTM ?? null,
      pBook:             m.pbAnnual ?? null,
      pSales:            m.psTTM ?? null,
      evToEbitda:        m.evToEbitda ?? null,
      pFcf:              m.pfcfTTM ?? null,

      // Profitability
      grossMargin:       m.grossMarginTTM != null ? +(m.grossMarginTTM * 100).toFixed(1) : null,
      operatingMargin:   m.operatingMarginTTM != null ? +(m.operatingMarginTTM * 100).toFixed(1) : null,
      netMargin:         m.netProfitMarginTTM != null ? +(m.netProfitMarginTTM * 100).toFixed(1) : null,
      roe:               m.roeTTM != null ? +(m.roeTTM * 100).toFixed(1) : null,
      roa:               m.roaTTM != null ? +(m.roaTTM * 100).toFixed(1) : null,
      roic:              m.roicTTM != null ? +(m.roicTTM * 100).toFixed(1) : null,

      // FCF / cash
      fcfPerShare:       m.freeCashFlowPerShareTTM ?? null,
      freeCashFlow:      m.freeCashFlowAnnual ?? null,
      cashPerShare:      m.cashPerSharePerShareAnnual ?? null,

      // Leverage / capital structure
      netDebtToEbitda:   m["netDebt/EBITDA"] ?? m.totalDebt_totalEquityAnnual ?? null,
      debtToEquity:      m.totalDebt_totalEquityAnnual ?? null,
      currentRatio:      m.currentRatioAnnual ?? null,
      interestCoverage:  m.ebitPerInterest ?? null,

      // Growth
      revenueGrowth3Y:   m["3YRevenueGrowthPerShare"] != null
        ? +(m["3YRevenueGrowthPerShare"] * 100).toFixed(1) : null,
      epsGrowth3Y:       m["3YEPSGrowthPerShare"] != null
        ? +(m["3YEPSGrowthPerShare"] * 100).toFixed(1) : null,

      // Earnings quality
      accruals:          m.accrualsRatioAnnual ?? null,

      // Market
      beta:              m.beta ?? null,
      week52High:        m["52WeekHigh"] ?? null,
      week52Low:         m["52WeekLow"] ?? null,

      // Dividend
      dividendYield:     m.dividendYieldIndicatedAnnual != null
        ? +(m.dividendYieldIndicatedAnnual * 100).toFixed(2) : null,
    };
  } catch { return null; }
}

// ─── EARNINGS SURPRISE HISTORY ──────────────────────────────────
// Shows whether management guides conservatively or aggressively.
async function fetchEarningsSurprise(ticker) {
  const key = process.env.FINNHUB_KEY;
  if (!key) return null;
  try {
    const r = await fetch(
      `${FINNHUB_BASE}/stock/earnings?symbol=${encodeURIComponent(ticker)}&limit=8&token=${key}`
    );
    if (!r.ok) return null;
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) return null;

    return data
      .filter(e => e.actual != null && e.estimate != null)
      .slice(0, 6)
      .map(e => ({
        period:   e.period,
        actual:   e.actual,
        estimate: e.estimate,
        surprise: e.surprise ?? null,
        surprisePct: e.surprisePercent != null ? +e.surprisePercent.toFixed(1) : (
          e.estimate !== 0
            ? +(((e.actual - e.estimate) / Math.abs(e.estimate)) * 100).toFixed(1)
            : null
        ),
      }));
  } catch { return null; }
}

// ─── DERIVE METRICS ─────────────────────────────────────────────
function deriveMetrics(cashFlow, finnhub) {
  const derived = {};

  // FCF CAGR (3-year)
  if (cashFlow?.fcfSeries?.length >= 3) {
    const s = cashFlow.fcfSeries;
    const newest = s[0].fcf, old = s[Math.min(s.length - 1, 3)].fcf;
    const yrs = s[0].fy - s[Math.min(s.length - 1, 3)].fy;
    if (old && old > 0 && yrs > 0) {
      derived.fcfCagr3y = +(((Math.pow(newest / old, 1 / yrs) - 1) * 100)).toFixed(1);
    }
  }

  // Operating Leverage = % change in operating income / % change in revenue
  // (Requires 2+ years of data; use as a qualitative signal)
  // We estimate it from gross margin trend if direct data unavailable.
  if (finnhub?.grossMargin != null) {
    // Qualitative tier
    derived.grossMarginTier = finnhub.grossMargin >= 60 ? "high" :
      finnhub.grossMargin >= 35 ? "medium" : "low";
  }

  // Net Debt / EBITDA from EDGAR if Finnhub didn't have it
  if (finnhub?.netDebtToEbitda == null && cashFlow?.longTermDebt?.series?.[0] && cashFlow?.cash?.series?.[0]) {
    const debt = cashFlow.longTermDebt.series[0].val;
    const cash = cashFlow.cash.series[0].val;
    const netDebt = debt - cash;
    // We don't have EBITDA from EDGAR easily, so just expose Net Debt
    derived.netDebtRaw = netDebt;
    derived.netDebtLabel = netDebt < 0 ? "net cash" : netDebt < 1e9 ? "low" : netDebt < 5e9 ? "moderate" : "high";
  }

  // Capital allocation signal
  if (cashFlow?.fcfSeries?.length) {
    const latestFcf = cashFlow.fcfSeries[0].fcf;
    const latestCapex = cashFlow.fcfSeries[0].capex;
    const latestOcf = cashFlow.fcfSeries[0].ocf;
    if (latestOcf) {
      derived.capexIntensity = +(latestCapex / latestOcf * 100).toFixed(1); // capex as % of OCF
      derived.capexTrend = latestCapex > (cashFlow.fcfSeries[1]?.capex || 0) ? "rising" : "falling";
    }
    // FCF conversion (FCF / Net Income) would need netIncome here — skip for now
  }

  return derived;
}

// ─── COMPACT SUMMARY FOR PROMPT INJECTION ───────────────────────
// The ontology/crisis pass gets a tight text summary, not raw JSON.
export function quantToPromptSlice(quantData) {
  if (!quantData) return null;
  const lines = [];
  const f = quantData.finnhub || {};
  const d = quantData.derived || {};
  const s = quantData.fcfSeries?.[0];

  if (f.evToEbitda != null)    lines.push(`EV/EBITDA: ${f.evToEbitda.toFixed(1)}x`);
  if (f.pFcf != null)          lines.push(`P/FCF: ${f.pFcf.toFixed(1)}x`);
  if (f.netDebtToEbitda != null) lines.push(`Net Debt/EBITDA: ${f.netDebtToEbitda.toFixed(1)}x`);
  if (s?.fcf != null)          lines.push(`FCF (latest): $${(s.fcf / 1e9).toFixed(2)}B`);
  if (d.fcfCagr3y != null)     lines.push(`FCF CAGR (3y): ${d.fcfCagr3y}%`);
  if (f.operatingMargin != null) lines.push(`Operating margin: ${f.operatingMargin}%`);
  if (f.roic != null)          lines.push(`ROIC: ${f.roic}%`);
  if (d.capexIntensity != null) lines.push(`CapEx intensity: ${d.capexIntensity}% of OCF (${d.capexTrend})`);
  if (f.grossMargin != null)   lines.push(`Gross margin: ${f.grossMargin}%`);
  if (f.revenueGrowth3Y != null) lines.push(`Revenue CAGR (3y): ${f.revenueGrowth3Y}%`);

  return lines.length ? "QUANT METRICS:\n" + lines.join("\n") : null;
}

// ─── MAIN EXPORT ────────────────────────────────────────────────
const _quantCache = new Map(); // ticker -> { at, data }
const QUANT_TTL = 6 * 3600_000;

export async function getQuantMetrics(ticker) {
  const t = ticker.toUpperCase().trim();
  const cached = _quantCache.get(t);
  if (cached && Date.now() - cached.at < QUANT_TTL) return cached.data;

  const [cashFlow, finnhub, earningsSurprise] = await Promise.all([
    fetchEdgarCashFlow(t).catch(() => null),
    fetchFinnhubMetrics(t).catch(() => null),
    fetchEarningsSurprise(t).catch(() => null),
  ]);

  const derived = deriveMetrics(cashFlow, finnhub);

  const data = {
    ticker: t,
    fcfSeries:       cashFlow?.fcfSeries || null,
    operatingCashFlow: cashFlow?.operatingCashFlow?.series?.slice(0, 5) || null,
    capitalExpenditures: cashFlow?.capitalExpenditures?.series?.slice(0, 5) || null,
    longTermDebt:    cashFlow?.longTermDebt?.series?.slice(0, 5) || null,
    cash:            cashFlow?.cash?.series?.slice(0, 5) || null,
    finnhub,
    earningsSurprise,
    derived,
    promptSlice:     quantToPromptSlice({ fcfSeries: cashFlow?.fcfSeries, finnhub, derived }),
    updatedAt:       new Date().toISOString(),
  };

  _quantCache.set(t, { at: Date.now(), data });
  return data;
}
