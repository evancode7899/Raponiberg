import { describe, expect, it } from "vitest";
import { normalizeGoals } from "../goals/settings.ts";
import type { Holding } from "../ingest/holdings/types.ts";
import { describeSecurity, securityKey } from "./securities.ts";
import { normalizeInvestmentSettings } from "./settings.ts";

const h = (p: Partial<Holding>): Holding => ({ symbol: null, name: "", kind: "FUND", quantity: null, price: null, valueCents: 100, costBasisCents: null, expenseRatio: null, ...p });

describe("security classification", () => {
  it("uses the reference list for known tickers, with their expense ratio", () => {
    expect(describeSecurity(h({ symbol: "VOO", kind: "ETF" }), 2026, {})).toEqual({ weights: { US_STOCK: 1 }, expenseRatio: 0.0003, source: "REFERENCE" });
  });

  it("prefers a ratio printed on the statement over the reference", () => {
    expect(describeSecurity(h({ symbol: "FXAIX", expenseRatio: 0.0002 }), 2026, {}).expenseRatio).toBe(0.0002);
  });

  it("reads plan funds without tickers from their names, target-date funds by glide path", () => {
    const far = describeSecurity(h({ name: "Example Target Retire 2065 Tr P" }), 2026, {}).weights!;
    expect((far.US_STOCK ?? 0) + (far.INTL_STOCK ?? 0)).toBeCloseTo(0.9, 2);
    const near = describeSecurity(h({ name: "Example Target Retirement 2030 Fund" }), 2026, {}).weights!;
    expect(near.BOND).toBeGreaterThan(0.4);
    expect(describeSecurity(h({ name: "EX INTERNATIONAL INDEX" }), 2026, {}).weights).toEqual({ INTL_STOCK: 1 });
  });

  it("never guesses an unknown fund; the owner's classification always wins", () => {
    const etf = h({ symbol: "ZZZZ", kind: "ETF", name: "SOMETHING THEMATIC" });
    expect(describeSecurity(etf, 2026, {})).toMatchObject({ weights: null, source: "NONE" });
    const mine = { [securityKey(etf)]: { weights: { ALTERNATIVES: 1 }, expenseRatio: 0.0075 } };
    expect(describeSecurity(etf, 2026, mine)).toEqual({ weights: { ALTERNATIVES: 1 }, expenseRatio: 0.0075, source: "OWNER" });
  });

  it("files cash, options and individual stocks by what the statement calls them", () => {
    expect(describeSecurity(h({ kind: "CASH", name: "CORE" }), 2026, {}).weights).toEqual({ CASH: 1 });
    expect(describeSecurity(h({ kind: "OPTION", symbol: "X270115C5" }), 2026, {}).weights).toEqual({ OPTIONS: 1 });
    expect(describeSecurity(h({ kind: "STOCK", symbol: "EXCO" }), 2026, {})).toMatchObject({ weights: { US_STOCK: 1 }, expenseRatio: 0 });
  });
});

describe("settings", () => {
  it("rescales a target allocation to sum to one and drops unknown classes", () => {
    const s = normalizeInvestmentSettings({ target: { US_STOCK: 60, BOND: 40, MOON: 5 }, securities: { X: { weights: {}, expenseRatio: 2 } } });
    expect(s.target).toEqual({ US_STOCK: 0.6, BOND: 0.4 });
    expect(s.securities).toEqual({});
  });

  it("keeps well-formed goals and defaults an emergency fund to six months", () => {
    const g = normalizeGoals({ goals: [{ id: "a", kind: "EMERGENCY_FUND", groups: ["Cash", "Credit cards", "Nope"] }, { name: "no id" }] });
    expect(g.goals).toHaveLength(1);
    expect(g.goals[0]).toMatchObject({ months: 6, groups: ["Cash"], targetCents: null, name: "Untitled goal" });
  });
});
