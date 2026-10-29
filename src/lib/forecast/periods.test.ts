import { describe, expect, it } from "vitest";
import { cashWaterfall } from "../profile/annualMath";
import type { OutlookSeeds } from "../profile/basePay";
import type { AnnualProfileReport, YearProfile } from "../profile/buildAnnualProfile";
import { DEFAULT_OUTLOOK } from "../profile/settings";
import { taxYearParams } from "../tax/params";
import { buildForecast } from "./forecast";
import { monthPeriods, yearPeriods, type Flows } from "./periods";

// All amounts below are invented.
const fp = taxYearParams(2026).federal;
const seeds: OutlookSeeds = {
  start: { asOf: "2026-06-30", year: 2026, month: 6, liquid: 100_000_00, illiquid: 50_000_00, note: "" },
  baseYear: 2025,
  currentYear: 2026,
  people: [
    {
      personId: "a",
      name: "A",
      employer: "ACME",
      perYear: 24,
      frequency: "SEMIMONTHLY",
      latest: { payDate: "2026-06-15", regular: 5_000_00, section125: 0, hsa: 0, afterTax: 0, employer: 0 },
      typical: { payDate: "2026-06-15", regular: 5_000_00, section125: 0, hsa: 0, afterTax: 0, employer: 0 },
      deferrals: { LATEST: { k401Pretax: 0, k401Roth: 0, hsa: 0 }, TYPICAL: { k401Pretax: 0, k401Roth: 0, hsa: 0 } },
      bonusHistory: [{ year: 2025, salary: 120_000_00, bonus: 24_000_00, pct: 0.2, partial: false }],
      bonusMonth: 3,
      bonusesSinceStart: [{ payDate: "2026-07-15", gross: 10_000_00 }],
      note: "",
    },
  ],
  living: { TRAILING_12: { cents: 60_000_00, label: "Last 12 months", detail: "" } },
  realizedReturn: null,
  taxYear: 2026,
  tax: { year: 2026, standardDeduction: fp.standardDeduction.MFJ, brackets: fp.brackets.MFJ },
  dependents: [],
  birthYear: 1990,
};
const f = buildForecast({ seeds, bonusFacts: { scheduled: [], patterns: [] } }, { ...DEFAULT_OUTLOOK, horizonYear: 2030, bonus: { ...DEFAULT_OUTLOOK.bonus, estimates: "NEXT_PAYOUT" } });

const year = (y: number, nw: number, saved: number, opts: Partial<YearProfile> = {}): YearProfile =>
  ({
    year: y,
    isCurrent: false,
    asOf: `${y}-12-31`,
    netWorthAsOf: `${y}-12-31`,
    people: [{ deferrals: 5_000_00 }],
    cash: {
      waterfall: cashWaterfall({ salary: saved + 40_000_00, bonus: 0, otherIncome: 0, withholding: 30_000_00, additionalTaxes: 0, refunds: 0, otherDeductions: 0, employer: 2_000_00, partnerKept: 0, living: 12_000_00, nonRecurring: 0 }),
    },
    netWorth: { netWorth: nw, liquid: nw - 20_000_00, illiquid: 20_000_00 },
    change: { cents: 0, pct: null },
    ...opts,
  }) as unknown as YearProfile;

const report = {
  currentYear: 2026,
  years: [year(2024, 80_000_00, 20_000_00, { change: null }), year(2025, 110_000_00, 25_000_00), year(2026, 150_000_00, 30_000_00, { isCurrent: true, asOf: "2026-06-30", netWorthAsOf: "2026-06-30" })],
  ytd: year(2026, 150_000_00, 30_000_00, { isCurrent: true, asOf: "2026-06-30", netWorthAsOf: "2026-06-30" }),
} as unknown as AnnualProfileReport;

const FLOW_KEYS = ["salary", "bonus", "otherIncome", "taxes", "employer", "living", "bonusSpent", "oneOffs", "saved", "toRetirement", "growth", "change"] as const;
const balanced = (x: Flows) => {
  expect(x.salary! + x.bonus! + x.otherIncome! - x.taxes! + x.employer! - x.living! - x.bonusSpent! - x.oneOffs!).toBe(x.saved);
  expect(x.saved! + x.growth!).toBe(x.change);
  expect(x.close!.netWorth - x.open!).toBe(x.change);
};

describe("yearPeriods", () => {
  const ps = yearPeriods(f, report, { actualYears: 2, throughYear: 2028 });

  it("lays out proven years, the year in progress split, then forecast years", () => {
    expect(ps.map((p) => [p.label, p.kind])).toEqual([
      ["2024", "ACTUAL"],
      ["2025", "ACTUAL"],
      ["Jan–Jun", "ACTUAL"],
      ["Jul–Dec", "FORECAST"],
      ["2026", "TOTAL"],
      ["2027", "FORECAST"],
      ["2028", "FORECAST"],
    ]);
  });

  it("adds the year to date and the rest of the year up to the year's total, row by row", () => {
    const [ytd, rest, total] = [ps[2]!, ps[3]!, ps[4]!];
    for (const k of FLOW_KEYS) expect(total.flows[k]).toBe(ytd.flows[k]! + rest.flows[k]!);
    expect(ytd.flows.open).toBe(110_000_00);
    expect(ytd.flows.close!.netWorth).toBe(150_000_00);
    expect(rest.flows.open).toBe(150_000_00);
    expect(total.flows.open).toBe(110_000_00);
    expect(total.flows.close).toEqual(rest.flows.close);
    expect(rest.flows.bonus).toBe(10_000_00);
  });

  it("balances every column: income − outflows = saved, saved + growth = change = close − open", () => {
    for (const p of ps.filter((x) => x.flows.change != null)) balanced(p.flows);
    // A year whose change isn't proven has no growth or opening either.
    expect(ps[0]!.flows).toMatchObject({ change: null, growth: null, open: null });
  });

  it("chains forecast years: each opens where the last closed", () => {
    expect(ps[5]!.flows.open).toBe(ps[4]!.flows.close!.netWorth);
    expect(ps[6]!.flows.open).toBe(ps[5]!.flows.close!.netWorth);
  });
});

describe("monthPeriods", () => {
  it("the year in progress: actual to date, each forecast month, and a total matching the year column", () => {
    const ms = monthPeriods(f, report, 2026);
    expect(ms.map((p) => p.label)).toEqual(["Jan–Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "2026"]);
    const total = yearPeriods(f, report, { actualYears: 0, throughYear: 2026 }).find((p) => p.kind === "TOTAL")!;
    expect(ms.at(-1)!.flows).toEqual(total.flows);
    for (const p of ms) balanced(p.flows);
  });

  it("a forecast year: twelve months whose flows add up to the year", () => {
    const ms = monthPeriods(f, report, 2027);
    expect(ms).toHaveLength(13);
    const y = yearPeriods(f, report, { actualYears: 0, throughYear: 2027 }).find((p) => p.id === "2027")!;
    for (const k of FLOW_KEYS) expect(ms.slice(0, 12).reduce((t, p) => t + p.flows[k]!, 0)).toBe(y.flows[k]);
    expect(ms.at(-1)!.flows).toEqual(y.flows);
  });
});
