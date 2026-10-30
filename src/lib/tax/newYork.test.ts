import { describe, expect, it } from "vitest";
import { amountsFromLines } from "../ingest/payroll/amounts";
import { computeReturn, nycTax, nyStateTax, type NyFiling, type PersonIncome, type W2 } from "./computeReturn";
import { taxYearParams } from "./params";
import { returnSchedules } from "./schedules";

const P25 = taxYearParams(2025);
const NY = P25.ny;
const $ = (d: number) => Math.round(d * 100);

function person(over: Partial<PersonIncome> = {}, w2: Partial<W2> = {}): PersonIncome {
  return {
    id: "a",
    name: "A",
    w2s: [
      {
        employer: "Employer",
        grossPay: 0,
        box1Wages: 0,
        box3SsWages: 0,
        box5MedicareWages: 0,
        box16StateWages: 0,
        federalWithheld: 0,
        ssWithheld: 0,
        medicareWithheld: 0,
        stateWithheld: 0,
        ...w2,
      },
    ],
    taxableInterest: 0,
    ordinaryDividends: 0,
    qualifiedDividends: 0,
    section199aDividends: 0,
    taxExemptInterest: 0,
    usObligationIncome: 0,
    capitalGainDistributions: 0,
    shortTermGain: 0,
    longTermGain: 0,
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

const wages = (d: number): Partial<W2> => ({ grossPay: $(d), box1Wages: $(d), box3SsWages: $(Math.min(d, 176_100)), box5MedicareWages: $(d), box16StateWages: $(d) });
const total = (t: { schedule: number; recapture: number }) => t.schedule + t.recapture;

describe("New York State tax (IT-201 rate schedule and tax computation worksheets)", () => {
  it("uses the rate schedule up to $107,650 of AGI", () => {
    // $1,202 + 5.5% of the excess over $27,900.
    expect(nyStateTax(NY, "MFJ", $(100_000), $(83_950))).toEqual({ schedule: $(4_285), recapture: 0 });
  });

  it("phases toward the flat 5.5% between $107,650 and $157,650 of AGI (worksheet 1)", () => {
    // Schedule $5,168; flat $5,500; (120,000 − 107,650) ÷ 50,000 = .2470 of the $332 difference.
    expect(nyStateTax(NY, "MFJ", $(120_000), $(100_000))).toEqual({ schedule: $(5_168), recapture: $(82) });
  });

  it("phases a single filer toward the flat 6% (the bracket holding $107,650) in worksheet 1", () => {
    // Schedule $4,271 + 6% of $41,350; flat $7,320; (130,000 − 107,650) ÷ 50,000 = .4470 of the $568 difference.
    expect(nyStateTax(NY, "SINGLE", $(130_000), $(122_000))).toEqual({ schedule: $(6_752), recapture: $(254) });
  });

  it("adds the recapture base and the phased incremental benefit (worksheets 2 and 3)", () => {
    // 6% bracket: recapture base $333, incremental benefit $808 × .7690.
    expect(total(nyStateTax(NY, "MFJ", $(200_000), $(183_950)))).toBe($(9_897 + 333 + 621));
    // 6.85% bracket, partly phased in: $1,140 + $2,747 × .3360.
    expect(total(nyStateTax(NY, "MFJ", $(340_000), $(330_000)))).toBe($(18_718 + 1_140 + 923));
    // Fully phased in, it's 6.85% of every dollar.
    expect(total(nyStateTax(NY, "MFJ", $(450_000), $(400_000)))).toBe($(27_400));
  });

  it("taxes every dollar at the top rate above $25 million of AGI", () => {
    expect(total(nyStateTax(NY, "MFJ", $(30_000_000), $(29_000_000)))).toBe($(3_161_000));
  });

  it("drops the first five rates 0.1 point for 2026", () => {
    const rates = taxYearParams(2026).ny.brackets.MFJ.map(([, r]) => r);
    expect(rates).toEqual([0.039, 0.044, 0.0515, 0.054, 0.059, 0.0685, 0.0965, 0.103, 0.109]);
  });
});

describe("New York City resident tax", () => {
  it("uses the City's rate schedule", () => {
    // $3,264 + 3.876% of the excess over $90,000.
    expect(nycTax(NY, "MFJ", $(100_000))).toBe($(3_652));
  });

  it("uses the $50 tax-table band below $65,000", () => {
    // Taxed at the band's midpoint ($40,025): $665 + 3.762% of the excess over $21,600.
    expect(nycTax(NY, "MFJ", $(40_020))).toBe($(1_358));
  });
});

describe("New York returns", () => {
  const ny = (filing: NyFiling, over: Partial<PersonIncome> = {}, w2: Partial<W2> = {}) =>
    computeReturn({ params: P25, filingStatus: "MFJ", people: [person(over, { ...wages(300_000), ...w2 })], dependents: [], ny: filing }).ny!;

  it("a full-year City resident: State + City tax, withholding and the school credit", () => {
    const r = ny({ state: "RESIDENT", city: "RESIDENT", cityMonths: 12 }, {}, { nyWithheld: $(18_000), nycWithheld: $(10_000) });
    expect(r.taxableIncome).toBe($(283_950));
    expect(r.stateTax).toBe($(15_897 + 333 + 808));
    expect(r.city!.taxableIncome).toBe($(283_950));
    expect(r.cityTax).toBe($(10_782));
    // Rate reduction: $37 + 0.228% of the excess over $21,600; the fixed credit stops at $250k.
    expect(r.city!.schoolRateReduction).toBe($(635));
    expect(r.city!.schoolCredit).toBe(0);
    expect(r.balanceDue).toBe(r.totalTax - $(28_000 + 635));
  });

  it("a part-year resident: the tax on all income times the New York share; the City prorated by months", () => {
    const r = ny({ state: "PART_YEAR", city: "PART_YEAR", cityMonths: 6 }, { nySourceIncome: $(120_000) }, { nyWithheld: $(15_000), nycWithheld: $(6_000) });
    expect(r.baseTax).toBe($(17_038));
    expect(r.incomePercentage).toBe(0.4);
    expect(r.stateTax).toBe($(6_815));
    // City: $120,000 less half the $16,050 standard deduction.
    expect(r.city!.taxableIncome).toBe($(111_975));
    expect(r.cityTax).toBe($(4_116));
    expect(r.city!.schoolRateReduction).toBe($(243));
    expect(r.totalPayments).toBe($(15_000 + 6_000 + 243));
  });

  it("subtracts US government interest from New York AGI", () => {
    const r = ny({ state: "RESIDENT", city: "NONE", cityMonths: 0 }, { taxableInterest: $(5_000), usObligationIncome: $(5_000) });
    expect(r.federalAgi - r.nyAgi).toBe($(5_000));
    expect(r.city).toBeNull();
  });

  it("credits a nonresident's New York tax against Connecticut's on the same income", () => {
    const res = computeReturn({
      params: P25,
      filingStatus: "MFJ",
      people: [person({ nySourceIncome: $(200_000) }, wages(200_000))],
      dependents: [],
      ny: { state: "NONRESIDENT", city: "NONE", cityMonths: 0 },
    });
    expect(res.ny!.stateTax).toBe($(9_897 + 333 + 621));
    expect(res.ct.otherStateCredit).toBe(Math.min(res.ny!.stateTax, res.ct.taxBeforeCredits));
    expect(res.totalTax).toBe(res.federal.totalTax + res.ct.totalTax + res.ny!.totalTax + res.fica.socialSecurity + res.fica.medicare);
  });

  it("counts New York and City withholding as state and local tax paid (Schedule A)", () => {
    const r = computeReturn({ params: P25, filingStatus: "MFJ", people: [person({}, { ...wages(300_000), nyWithheld: $(6_000), nycWithheld: $(3_000) })], dependents: [] });
    expect(r.federal.itemized.saltPaid).toBe($(9_000));
    expect(r.ny).toBeNull();
  });
});

describe("pay stub New York lines", () => {
  it("splits New York State from New York City withholding", () => {
    const a = amountsFromLines(
      [
        { name: "NY Withholding", kind: "OTHER_STATE_TAX", current: 50_000, ytd: null },
        { name: "NY NEW YORK Withholding", kind: "LOCAL_TAX", current: 20_000, ytd: null },
        { name: "New York Cit Income Tax", kind: "LOCAL_TAX", current: 1_000, ytd: null },
      ],
      "current",
    );
    expect(a.otherStateWithheld).toBe(71_000);
    expect(a.nyWithheld).toBe(50_000);
    expect(a.nycWithheld).toBe(21_000);
  });
});

describe("New York schedules", () => {
  it("the State and City bands add up to the return's figures", () => {
    const people = [person({ nySourceIncome: $(150_000) }, wages(300_000))];
    const r = computeReturn({ params: P25, filingStatus: "MFJ", people, dependents: [], ny: { state: "PART_YEAR", city: "PART_YEAR", cityMonths: 6 } });
    const ss = returnSchedules(r, people, P25);
    const owed = (key: string) => {
      const s = ss.find((x) => x.key === key)!;
      return s.kind === "brackets" ? s.owed : 0;
    };
    expect(Math.abs(owed("ny") - r.ny!.scheduleTax)).toBeLessThanOrEqual(500);
    expect(Math.abs(owed("nyc") - r.ny!.cityTax)).toBeLessThanOrEqual(500);
    expect(ss.some((s) => s.key === "nycalc")).toBe(true);
  });
});
