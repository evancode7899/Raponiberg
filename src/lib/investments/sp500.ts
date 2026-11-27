/**
 * Which holdings are S&P 500 index funds, the benchmark Investments › Returns measures the
 * portfolio against (owner's choice, 2026-11-27: the S&P 500, chained from the S&P 500 funds
 * the household has held, account to account, with no outside data).
 */

/** Tickers of S&P 500 index funds and ETFs. */
const SP500_TICKERS = new Set(["VOO", "VFIAX", "VFINX", "IVV", "SPY", "SPLG", "SPYM", "FXAIX", "SWPPX", "SNXFX", "USSPX", "PREIX"]);
/** An S&P 500 fund by its name ("S&P 500", "500 Index", "500 Idx"). */
const SP500_NAME = /\bS ?& ?P ?500\b|\b500 (INDEX|IDX)\b/i;
/** Not the S&P 500 itself, whatever else its name says (a style slice, a leveraged or equal-weight fund, an option on it). */
const NOT_SP500 = /\bVALUE\b|\bGROWTH\b|\bEQUAL\b|\bLEVERAGED\b|\b[23]X\b|\bULTRA\b|\bINVERSE\b|\bSHORT\b|\bDIVIDEND\b|\bLOW VOL|\bESG\b|\bCALL\b|\bPUT\b/i;

export function isSp500Fund(h: { symbol: string | null; name: string; kind: string }): boolean {
  if (h.kind !== "FUND" && h.kind !== "ETF" && h.kind !== "STOCK") return false;
  if (NOT_SP500.test(h.name)) return false;
  if (h.symbol && SP500_TICKERS.has(h.symbol.toUpperCase())) return true;
  return h.kind !== "STOCK" && SP500_NAME.test(h.name);
}

/**
 * A collective trust or plan unit (Empower's "DC CIT", Vanguard's "Instl 500 Idx Tr"): it
 * pays nothing out, its dividends stay in its unit value, so the value of one unit from one
 * statement to the next is its whole return. A mutual fund or ETF pays dividends out, so its
 * price alone runs low.
 */
export function isUnitTrust(h: { name: string }): boolean {
  return /\bCIT\b|\bTRUST\b|\bTr\b|\bCOLLECTIVE\b|\bSEPARATE ACCOUNT\b/i.test(h.name);
}
