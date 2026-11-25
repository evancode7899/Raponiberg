import { describe, expect, it } from "vitest";
import { FEDERAL_RATES, startedTaxYears, TAX_YEARS, taxYearParams, type FilingStatus } from "./params";

const STATUSES: FilingStatus[] = ["SINGLE", "MFJ", "MFS", "HOH"];
const dollars = (cents: number) => cents / 100;

/** Tax below a bracket's top, as the IRS tables print it ("$X plus 35% of the excess over $Y"). */
function taxAt(bounds: number[], upTo: number): number {
  let tax = 0;
  for (let i = 0, from = 0; i < upTo; i++) {
    tax += (bounds[i]! - from) * FEDERAL_RATES[i]!;
    from = bounds[i]!;
  }
  return Math.round(tax) / 100;
}

describe("2027 law", () => {
  const f = taxYearParams(2027).federal;

  it("reproduces the base tax Rev. Proc. 2026-35 prints for the top bracket", () => {
    expect(taxAt(f.brackets.MFJ, 6)).toBe(213_290.5);
    expect(taxAt(f.brackets.SINGLE, 6)).toBe(199_237.75);
    expect(taxAt(f.brackets.MFS, 6)).toBe(106_645.25);
    expect(taxAt(f.brackets.HOH, 6)).toBe(197_360);
  });

  it("phases the AMT exemption out where the Rev. Proc. says it ends", () => {
    const end = (s: FilingStatus) => dollars(f.amt.phaseoutStart[s] + f.amt.exemption[s] / f.amt.phaseoutRate);
    expect(end("MFJ")).toBe(1_321_300);
    expect(end("SINGLE")).toBe(701_950);
    expect(end("MFS")).toBe(660_650);
  });

  it("ends the QBI phase-in where the Rev. Proc. says", () => {
    expect(dollars(f.qbiThreshold.MFJ + f.qbiPhaseIn.MFJ)).toBe(566_600);
    expect(dollars(f.qbiThreshold.SINGLE + f.qbiPhaseIn.SINGLE)).toBe(283_300);
    expect(dollars(f.qbiThreshold.MFS + f.qbiPhaseIn.MFS)).toBe(283_325);
  });

  it("raises the SALT cap 1% over 2026's", () => {
    const before = taxYearParams(2026).federal.salt;
    for (const s of STATUSES) {
      expect(f.salt.cap[s]).toBe(Math.round(before.cap[s] * 1.01));
      expect(f.salt.phaseoutStart[s]).toBe(Math.round(before.phaseoutStart[s] * 1.01));
    }
  });

  it("cuts New York's first five rates to 0.2 points below 2025's and no others", () => {
    const now = taxYearParams(2027).ny.brackets.MFJ.map(([, r]) => r);
    expect(now).toEqual([0.038, 0.043, 0.0505, 0.053, 0.058, 0.0685, 0.0965, 0.103, 0.109]);
    expect(taxYearParams(2026).ny.brackets.MFJ.slice(0, 5).map(([, r]) => r)).toEqual([0.039, 0.044, 0.0515, 0.054, 0.059]);
  });
});

describe("every year's law", () => {
  it("has rising brackets and limits that never fall from the year before", () => {
    for (const y of Object.keys(TAX_YEARS).map(Number)) {
      const now = taxYearParams(y).federal;
      for (const s of STATUSES) expect([...now.brackets[s]].sort((a, b) => a - b), `${y} ${s}`).toEqual(now.brackets[s]);
      const prev = TAX_YEARS[y - 1]?.federal;
      if (!prev) continue;
      for (const s of STATUSES) now.brackets[s].forEach((b, i) => expect(b, `${y} ${s} ${i}`).toBeGreaterThan(prev.brackets[s][i]!));
      expect(now.limits.k401).toBeGreaterThanOrEqual(prev.limits.k401);
      expect(now.socialSecurity.wageBase).toBeGreaterThan(prev.socialSecurity.wageBase);
    }
  });
});

describe("startedTaxYears", () => {
  it("opens a year on January 1 and not a day sooner, though its law is on file", () => {
    expect(TAX_YEARS[2027]).toBeDefined();
    expect(startedTaxYears("2026-12-31").at(-1)).toBe(2026);
    expect(startedTaxYears("2027-01-01").at(-1)).toBe(2027);
    expect(startedTaxYears("2026-12-31")).toEqual([2022, 2023, 2024, 2025, 2026]);
  });
});
