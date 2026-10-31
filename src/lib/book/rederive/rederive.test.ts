import { describe, expect, it } from "vitest";
import type { LongTermTable } from "../../fire/longTerm";
import type { HsaReport } from "../../hsa/report";
import { hsaAfterTax, taxableAfterTax, type StrategyAssumptions } from "../../hsa/strategy";
import { mortgageFigures } from "../../mortgage/figures";
import { normalizeMortgageInputs, toPlan } from "../../mortgage/inputs";
import { comparePrepayVsInvest } from "../../mortgage/prepayVsInvest";
import type { Outlook } from "../../profile/outlook";
import { c, ln, type DerivedFigure } from "../derived/types";
import type { ProofValue, Rederivation } from "../proof/types";
import { rederiveCardPerks, rederiveHsa } from "./pages";
import { rederiveMortgage, rederivePlanCell, rederiveStress } from "./planning";

const ties = (r: Rederivation) => ("routes" in r ? r.routes.every((x) => x.ok) : null);

describe("mortgage: interest saved by the annuity formula, against the month-by-month model", () => {
  const run = (over: Record<string, unknown>) => {
    const eff = normalizeMortgageInputs({ principal: 420_000, rate: 0.0625, termYears: 30, extraMonthly: 600, horizonYears: 12, lumps: [], ...over });
    const m = mortgageFigures(eff);
    const adv = (rr: number) => comparePrepayVsInvest(toPlan({ ...eff, investReturn: rr })).advantage;
    return { eff, m, adv };
  };

  it("ties in nominal and in today's dollars, and catches a figure that's off", () => {
    for (const realDollars of [false, true]) {
      const { eff, m, adv } = run({ realDollars, inflation: 0.025 });
      const v = m.values["interest-saved"] as { cents: number };
      expect(ties(rederiveMortgage("interest-saved", v, eff, m, adv))).toBe(true);
      expect(ties(rederiveMortgage("interest-saved", { cents: v.cents + 5_000 }, eff, m, adv))).toBe(false);
    }
  });

  it("holds the break-even as a root and the advantage's sign to it", () => {
    const { eff, m, adv } = run({ investReturn: 0.08 });
    const be = m.values["break-even"] as { ratio: number };
    expect(ties(rederiveMortgage("break-even", be, eff, m, adv))).toBe(true);
    expect(ties(rederiveMortgage("break-even", { ratio: be.ratio }, eff, { ...m, values: { ...m.values, "break-even": { ratio: be.ratio + 0.03 } } }, adv))).toBe(false);
    const a = m.values.advantage as { cents: number };
    expect(ties(rederiveMortgage("advantage", a, eff, m, adv))).toBe(true);
    expect(ties(rederiveMortgage("advantage", { cents: -a.cents }, eff, m, adv))).toBe(false);
  });
});

describe("HSA: the edge in closed form, against the year-by-year formulas", () => {
  const a: StrategyAssumptions = { rate: 0.07, dividendYield: 0.015, taxableRate: 0.238, marginalRate: 0.35, payrollRate: 0.0765, growthCovered: false, exitRate: 0.3, years: 22 };
  const open = 1_234_500;
  const growth = { assumptions: a, path: [{ year: 2031, hsaCents: open, taxableCents: open }] } as unknown as HsaReport["growth"];
  const edge = Math.round(open * hsaAfterTax(a, a.years)) - Math.round(open * taxableAfterTax(a, a.years));
  const fig = (cents: number): DerivedFigure[] => [{ figure: "edge", describes: "Made-up edge", value: c(cents), lines: [ln("Edge", c(cents))] }];

  it("ties to the cent, and catches an edge that's off", () => {
    expect(ties(rederiveHsa({ growth }, fig(edge)).edge!)).toBe(true);
    expect(ties(rederiveHsa({ growth }, fig(edge + 500)).edge!)).toBe(false);
  });
});

describe("FIRE long-term table: the year's roll and the columns' chain", () => {
  const t: LongTermTable = {
    columns: ["2030", "2031E", "2032E"].map((id) => ({ id, label: id })),
    projected: [1, 2],
    highlight: [],
    rows: [
      { kind: "row", id: "salary", label: "Base salary", cells: [{ cents: 15_000_000 }, { cents: 15_450_000 }, { cents: 15_913_500 }] },
      { kind: "row", id: "raise", label: "Raise", cells: [null, { ratio: 0.03 }, { ratio: 0.03 }] },
      { kind: "row", id: "saved", label: "Total saved", cells: [{ cents: 4_000_000 }, { cents: 4_200_000 }, { cents: 4_400_000 }] },
      { kind: "row", id: "growth", label: "Growth", cells: [{ cents: 2_000_000 }, { cents: 3_100_000 }, { cents: 3_500_000 }] },
      { kind: "row", id: "net-worth", label: "Net worth, Dec 31", cells: [{ cents: 50_000_000 }, { cents: 57_300_000 }, { cents: 65_200_000 }] },
      { kind: "row", id: "liquid", label: "Liquid", cells: [{ cents: 20_000_000 }, { cents: 22_000_000 }, { cents: 25_000_000 }] },
      { kind: "row", id: "illiquid", label: "Illiquid", cells: [{ cents: 30_000_000 }, { cents: 35_300_000 }, { cents: 40_200_000 }] },
    ],
  };
  const full = { months: [], years: [{ year: 2031, months: 12, working: true, startNetWorth: 50_000_000 }, { year: 2032, months: 12, working: true, startNetWorth: 57_300_000 }] } as unknown as Outlook;
  const o = { birthYear: 1990, nwAt: () => 50_000_000 };

  it("ties a consistent table", () => {
    for (const [row, col, v] of [["net-worth", "2032E", 65_200_000], ["growth", "2031E", 3_100_000], ["liquid", "2032E", 25_000_000], ["salary", "2032E", 15_913_500], ["net-worth", "2030", 50_000_000]] as const)
      expect(ties(rederivePlanCell(t, full, row, col, { cents: v }, o)), `${row} ${col}`).toBe(true);
  });

  it("catches a Dec 31 that doesn't roll, and a year that doesn't open on the last close", () => {
    expect(ties(rederivePlanCell(t, full, "net-worth", "2032E", { cents: 65_300_000 }, o))).toBe(false);
    const broken = { ...full, years: [full.years[0]!, { ...full.years[1]!, startNetWorth: 57_000_000 }] } as Outlook;
    expect(ties(rederivePlanCell(t, broken, "net-worth", "2032E", { cents: 64_900_000 }, o))).toBe(false);
  });

  it("declares a typed rate", () => {
    expect(rederivePlanCell(t, full, "raise", "2031E", { ratio: 0.03 }, o)).toHaveProperty("none");
  });
});

describe("stress test: bounds any set of paths must satisfy", () => {
  const st = { paths: 1000, bands: [], coveredThroughout: null, fiYears: { p10: 2041, p50: 2044, p90: 2049 }, fiByYear: [2040, 2042, 2044, 2046, 2050].map((year, i) => ({ year, share: [0.05, 0.2, 0.52, 0.8, 0.95][i]! })) };
  it("holds ordered percentiles and a rising share", () => {
    expect(ties(rederiveStress("p50", { text: "2044" }, st, 2044))).toBe(true);
    expect(ties(rederiveStress("p50", { text: "2044" }, { ...st, fiYears: { p10: 2046, p50: 2044, p90: 2049 } }, 2044))).toBe(false);
    expect(ties(rederiveStress("by-fi", { ratio: 1.2 }, st, null))).toBe(false);
  });
});

describe("card perks: each card's rows and perk lines, not the year's totals", () => {
  const card = (rewards: number, used: number, missed: number, offer: number, fee: number) =>
    ({ rewards: { valueCents: rewards }, perks: [{ usedCents: used, missedCents: missed, remainingCents: 1_000 }], credits: [{ kind: "OFFER", amountCents: offer }], fee: { rows: [{ amountCents: -fee }] } }) as never;
  const report = { year: 2031, cards: [card(40_000, 20_000, 5_000, 3_000, 69_500), card(12_000, 0, 0, 0, 0)] };
  const f = (figure: string, v: ProofValue): DerivedFigure => ({ figure, key: "2031", describes: figure, value: v, lines: [] });
  it("re-adds the net value and catches a wrong one", () => {
    const net = 40_000 + 20_000 + 3_000 - 69_500 + 12_000;
    const out = rederiveCardPerks([report], [f("net-value", c(net)), f("capture", { ratio: 0.8 }), f("rewards", c(52_001))]);
    expect(ties(out["net-value|2031"]!)).toBe(true);
    expect(ties(out["capture|2031"]!)).toBe(true);
    expect(ties(out["rewards|2031"]!)).toBe(false);
  });
});
