import type { Holding } from "../ingest/holdings/types.ts";

/**
 * What a security is made of, for allocation and fees. Statements say what's held but
 * not what it invests in or what it costs each year, so this is reference data: a short
 * list of well-known funds below, name rules for plan funds without tickers, and the
 * owner's own classifications (which always win). Anything else stays unclassified and
 * is shown as such, never guessed.
 */

export type AssetClass = "US_STOCK" | "INTL_STOCK" | "BOND" | "CASH" | "REAL_ASSETS" | "ALTERNATIVES" | "OPTIONS";

export const ASSET_CLASSES: { id: AssetClass; label: string }[] = [
  { id: "US_STOCK", label: "US stocks" },
  { id: "INTL_STOCK", label: "International stocks" },
  { id: "BOND", label: "Bonds" },
  { id: "CASH", label: "Cash" },
  { id: "REAL_ASSETS", label: "Real assets" },
  { id: "ALTERNATIVES", label: "Alternatives" },
  { id: "OPTIONS", label: "Options" },
];

export const classLabel = (c: AssetClass | "UNCLASSIFIED") => (c === "UNCLASSIFIED" ? "Unclassified" : ASSET_CLASSES.find((x) => x.id === c)!.label);

/** Share of the security in each class (sums to 1). */
export type Weights = Partial<Record<AssetClass, number>>;

export type SecurityInfo = {
  weights: Weights | null;
  /** Annual expense ratio (0.0003 = 0.03%), or null when unknown. */
  expenseRatio: number | null;
  /** Where the classification came from. */
  source: "STATEMENT" | "OWNER" | "REFERENCE" | "NAME_RULE" | "KIND" | "NONE";
};

const US: Weights = { US_STOCK: 1 };
const INTL: Weights = { INTL_STOCK: 1 };
const CASH: Weights = { CASH: 1 };

/** Published expense ratios of common funds (fund prospectuses, 2025–26). */
const REFERENCE: Record<string, { weights: Weights; expenseRatio: number }> = {
  VOO: { weights: US, expenseRatio: 0.0003 },
  VTI: { weights: US, expenseRatio: 0.0003 },
  VTSAX: { weights: US, expenseRatio: 0.0004 },
  VFIAX: { weights: US, expenseRatio: 0.0004 },
  SPY: { weights: US, expenseRatio: 0.000945 },
  IVV: { weights: US, expenseRatio: 0.0003 },
  SPYV: { weights: US, expenseRatio: 0.0004 },
  DIA: { weights: US, expenseRatio: 0.0016 },
  FXAIX: { weights: US, expenseRatio: 0.00015 },
  FSKAX: { weights: US, expenseRatio: 0.00015 },
  FZROX: { weights: US, expenseRatio: 0 },
  VEU: { weights: INTL, expenseRatio: 0.0004 },
  VXUS: { weights: INTL, expenseRatio: 0.0005 },
  VTIAX: { weights: INTL, expenseRatio: 0.0009 },
  FTIHX: { weights: INTL, expenseRatio: 0.0006 },
  FZILX: { weights: INTL, expenseRatio: 0 },
  BND: { weights: { BOND: 1 }, expenseRatio: 0.0003 },
  AGG: { weights: { BOND: 1 }, expenseRatio: 0.0003 },
  VBTLX: { weights: { BOND: 1 }, expenseRatio: 0.0004 },
  FXNAX: { weights: { BOND: 1 }, expenseRatio: 0.00025 },
  GLD: { weights: { REAL_ASSETS: 1 }, expenseRatio: 0.004 },
  IAU: { weights: { REAL_ASSETS: 1 }, expenseRatio: 0.0025 },
  SPAXX: { weights: CASH, expenseRatio: 0.0042 },
  FDRXX: { weights: CASH, expenseRatio: 0.0037 },
  VMFXX: { weights: CASH, expenseRatio: 0.0011 },
};

/** Plan funds and 529 portfolios carry no ticker; their names say what they hold. */
function byName(name: string): Weights | null {
  const n = name.toUpperCase();
  // A target-date fund's mix is the fund company's glide path, which no statement prints:
  // left unclassified for the owner to set from the fund's fact sheet, never guessed.
  if (/TARGET (?:RETIRE(?:MENT)?|DATE)?\s*20\d\d/.test(n) || /\b20[4-7]\d\b.*\b(TR|FUND|TRUST)\b/.test(n)) return null;
  if (/MONEY MARKET|GOVT? MONEY|FEDERAL MONEY|CASH RESERVE|HSA CASH/.test(n)) return CASH;
  if (/BOND|INCOME FUND|TREASURY|FIXED INCOME/.test(n)) return { BOND: 1 };
  if (/INT'?L|INTERNATIONAL|EX[- ]US|ALL ?WORLD EX|DEVELOPED|EMERGING/.test(n)) return INTL;
  if (/500|TOTAL (STK|STOCK) MKT|TOTAL MARKET|S&P|LARGE CAP|MID CAP|SMALL CAP|EXTENDED MARKET/.test(n)) return US;
  return null;
}

/** Key the owner's classification is stored under: the ticker, else the name. */
export const securityKey = (h: Pick<Holding, "symbol" | "name">) => (h.symbol ?? h.name).toUpperCase().replace(/\s+/g, " ").trim();

export type OwnerSecurity = { weights: Weights | null; expenseRatio: number | null };

export function describeSecurity(h: Holding, asOfYear: number, owner: Record<string, OwnerSecurity>): SecurityInfo {
  const mine = owner[securityKey(h)];
  const ref = h.symbol ? REFERENCE[h.symbol.toUpperCase()] : undefined;
  // What the statement prints wins; the owner's figure fills in where it prints none, the reference list last.
  const expenseRatio = h.expenseRatio ?? mine?.expenseRatio ?? ref?.expenseRatio ?? null;
  if (mine?.weights) return { weights: mine.weights, expenseRatio, source: "OWNER" };
  if (h.kind === "CASH") return { weights: CASH, expenseRatio, source: "KIND" };
  if (h.kind === "OPTION") return { weights: { OPTIONS: 1 }, expenseRatio: 0, source: "KIND" };
  if (ref) return { weights: ref.weights, expenseRatio, source: "REFERENCE" };
  const named = byName(h.name);
  if (named) return { weights: named, expenseRatio, source: "NAME_RULE" };
  // An individual stock is equity; where it's listed decides US vs international, which
  // the statement doesn't say — US unless the owner says otherwise.
  if (h.kind === "STOCK") return { weights: US, expenseRatio: expenseRatio ?? 0, source: "KIND" };
  return { weights: null, expenseRatio, source: "NONE" };
}
