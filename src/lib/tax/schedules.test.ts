import { describe, expect, it } from "vitest";
import { computeReturn, type PersonIncome } from "./computeReturn";
import { taxYearParams } from "./params";
import { applyWhatIf, bestSeparate, NO_WHAT_IF } from "./scenarios";
import { returnSchedules, type Schedule } from "./schedules";

const P = taxYearParams(2026);
const $ = (d: number) => Math.round(d * 100);

function person(id: string, wages: number, over: Partial<PersonIncome> = {}): PersonIncome {
  return {
    id,
    name: id,
    w2s: [
      {
        employer: "E",
        grossPay: $(wages),
        box1Wages: $(wages),
        box3SsWages: Math.min($(wages), P.federal.socialSecurity.wageBase),
        box5MedicareWages: $(wages),
        box16StateWages: $(wages),
        federalWithheld: 0,
        ssWithheld: 0,
        medicareWithheld: 0,
        stateWithheld: 0,
      },
    ],
    taxableInterest: 0,
    ordinaryDividends: $(6_000),
    qualifiedDividends: $(4_000),
    section199aDividends: 0,
    taxExemptInterest: 0,
    usObligationIncome: 0,
    capitalGainDistributions: 0,
    shortTermGain: 0,
    longTermGain: $(2_500),
    foreignTaxPaid: 0,
    retirementTaxable: 0,
    otherIncome: 0,
    businessIncome: 0,
    adjustments: 0,
    ctChetContributions: 0,
    ctOtherSubtractions: 0,
    ctOtherAdditions: 0,
    estimatedFederal: 0,
    estimatedCt: 0,
    mortgageInterest: 0,
    propertyTax: 0,
    charitableCash: 0,
    charitableOther: 0,
    otherItemized: 0,
    dependentCareExpenses: 0,
    dependentCareFsa: 0,
    otherStateTax: 0,
    priorYearStateTaxPaid: 0,
    ...over,
  };
}

const owed = (ss: Schedule[], key: string) => {
  const s = ss.find((x) => x.key === key)!;
  return s.kind === "brackets" ? s.owed : NaN;
};

describe("bracket schedules add up to the return", () => {
  const people = [person("a", 360_000), person("b", 90_000, { ordinaryDividends: 0, qualifiedDividends: 0, longTermGain: 0 })];
  const r = computeReturn({ params: P, filingStatus: "MFJ", people, dependents: [] });
  const ss = returnSchedules(r, people, P);

  it("federal ordinary and preferential bands", () => {
    expect(Math.abs(owed(ss, "fed") - r.federal.ordinaryTax)).toBeLessThanOrEqual(5);
    expect(Math.abs(owed(ss, "pref") - r.federal.preferentialTax)).toBeLessThanOrEqual(5);
  });

  it("Medicare, Social Security and Connecticut", () => {
    expect(Math.abs(owed(ss, "medicare") - (r.fica.medicare + r.federal.additionalMedicareTax))).toBeLessThanOrEqual(5);
    expect(owed(ss, "ss-a") + owed(ss, "ss-b")).toBe(r.fica.socialSecurity);
    expect(Math.abs(owed(ss, "ct") - r.ct.initialTax)).toBeLessThanOrEqual(5);
  });
});

describe("what-if", () => {
  it("extra pre-tax 401(k) lowers box 1 but not box 5", () => {
    const [p] = applyWhatIf([person("a", 100_000)], { ...NO_WHAT_IF, people: { a: { extraWages: 0, extraPretax401k: $(5_000) } } }, P);
    expect(p!.w2s[0]!.box1Wages).toBe($(95_000));
    expect(p!.w2s[0]!.box5MedicareWages).toBe($(100_000));
  });

  it("extra wages are withheld at supplemental rates and stop Social Security at the wage base", () => {
    const [p] = applyWhatIf([person("a", 180_000)], { ...NO_WHAT_IF, people: { a: { extraWages: $(10_000), extraPretax401k: 0 } } }, P);
    expect(p!.w2s[0]!.federalWithheld).toBe($(2_200));
    expect(p!.w2s[0]!.box3SsWages).toBe(P.federal.socialSecurity.wageBase);
    expect(p!.w2s[0]!.ssWithheld).toBe(Math.round(($(184_500) - $(180_000)) * 0.062));
  });

  it("separate filing keeps the cheapest dependent claimant", () => {
    const people = [person("a", 300_000), person("b", 60_000)];
    const m = bestSeparate(P, people, [{ name: "Kid", age: 2 }], "AUTO");
    // The higher earner's child credit phases out above $200k (separate), so the other spouse claims.
    expect(m.claimant).toBe("b");
  });
});
