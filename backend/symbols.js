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
