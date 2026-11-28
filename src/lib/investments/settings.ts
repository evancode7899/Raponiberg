import { asObject, isNum } from "../settingsStore.ts";
import { ASSET_CLASSES, type AssetClass, type OwnerSecurity, type Weights } from "./securities.ts";

/**
 * The owner's investment inputs: how to classify securities the reference list doesn't
 * know (or override it), and a target allocation to measure drift against. Neither
 * changes a balance; they only shape how holdings are grouped.
 */
export type InvestmentSettings = {
  version: 1;
  /** securityKey → classification. */
  securities: Record<string, OwnerSecurity>;
  /** Target share per asset class (sums to 1), or null for none. */
  target: Weights | null;
  /** Count bank cash (checking, savings) in the household allocation. */
  includeBankCash: boolean;
};

export const INVESTMENT_SETTINGS_KEY = "investments.v1";

const CLASS_IDS = new Set<string>(ASSET_CLASSES.map((c) => c.id));

export function normalizeWeights(raw: unknown): Weights | null {
  const entries = Object.entries(asObject(raw)).filter(([k, v]) => CLASS_IDS.has(k) && isNum(v) && v > 0) as [AssetClass, number][];
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (!entries.length || total <= 0) return null;
  return Object.fromEntries(entries.map(([k, v]) => [k, Math.round((v / total) * 10_000) / 10_000]));
}

export function normalizeInvestmentSettings(raw: unknown): InvestmentSettings {
  const r = asObject(raw);
  const securities: Record<string, OwnerSecurity> = {};
  for (const [k, v] of Object.entries(asObject(r.securities))) {
    const o = asObject(v);
    const weights = normalizeWeights(o.weights);
    const expenseRatio = isNum(o.expenseRatio) && o.expenseRatio >= 0 && o.expenseRatio < 0.1 ? o.expenseRatio : null;
    if (weights || expenseRatio != null) securities[k.slice(0, 120)] = { weights, expenseRatio };
  }
  return { version: 1, securities, target: normalizeWeights(r.target), includeBankCash: r.includeBankCash === true };
}
