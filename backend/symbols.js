// Maps the tickers shown in your app to the symbols Yahoo Finance uses.
// Swedish stocks need ".ST", Copenhagen ".CO", Paris ".PA", etc.
// If a price ever looks wrong, the fix is almost always here.

export const SYMBOL_MAP = {
  // --- Stocks ---
  GOOGL: "GOOGL",
  "BETS-B": "BETS-B.ST",   // Betsson B (Stockholm)
  BX: "BX",
  BXMT: "BXMT",
  DUOL: "DUOL",
  FLAT: "FLAT-B.ST",       // Flat Capital B (Stockholm)
  FLYE: "FLYE",
  HIMS: "HIMS",
  "INVE-B": "INVE-B.ST",   // Investor B (Stockholm)
  LMND: "LMND",
  "NIBE-B": "NIBE-B.ST",   // Nibe Industrier B (Stockholm)
  NVO: "NOVO-B.CO",        // Novo Nordisk B (Copenhagen, DKK)
  PLTR: "PLTR",
  ROOT: "ROOT",
  HO: "HO.PA",             // Thales (Paris)

  // --- ETFs ---
  FLXI: "FLXI.DE",         // Franklin FTSE India UCITS ETF (Xetra)
  XACT: "XACT-OMXS30.ST"   // XACT OMXS30 ESG (Stockholm)
};

// Reverse lookup: Yahoo symbol -> your ticker
export const REVERSE_MAP = Object.fromEntries(
  Object.entries(SYMBOL_MAP).map(([k, v]) => [v, k])
);

export function toYahoo(ticker) {
  return SYMBOL_MAP[ticker] || ticker;
}

// Maps our tickers to TradingView symbols (EXCHANGE:SYMBOL) for the
// embedded chart widget. Known holdings are pinned; anything else is
// derived from the Yahoo symbol's exchange suffix.
export const TV_MAP = {
  GOOGL: "NASDAQ:GOOGL", BX: "NYSE:BX", BXMT: "NYSE:BXMT", DUOL: "NASDAQ:DUOL",
  FLYE: "NASDAQ:FLYE", HIMS: "NYSE:HIMS", LMND: "NYSE:LMND", PLTR: "NASDAQ:PLTR", ROOT: "NASDAQ:ROOT",
  "BETS-B": "OMXSTO:BETS_B", FLAT: "OMXSTO:FLAT_B", "INVE-B": "OMXSTO:INVE_B",
  "NIBE-B": "OMXSTO:NIBE_B", NVO: "OMXCOP:NOVO_B", HO: "EURONEXT:HO",
  FLXI: "XETR:FLXI", XACT: "OMXSTO:XACTOMXS30ESG",
};

export function toTradingView(ticker) {
  if (TV_MAP[ticker]) return TV_MAP[ticker];
  const y = toYahoo(ticker);
  const base = (suffix, exch) => exch + ":" + y.slice(0, -suffix.length).replace(/-/g, "_");
  if (y.endsWith(".ST")) return base(".ST", "OMXSTO");
  if (y.endsWith(".CO")) return base(".CO", "OMXCOP");
  if (y.endsWith(".PA")) return base(".PA", "EURONEXT");
  if (y.endsWith(".DE")) return base(".DE", "XETR");
  return ticker.replace(/-/g, "."); // US listings: TradingView resolves the bare symbol
}
