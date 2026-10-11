import { describe, expect, it } from "vitest";
import { bracketTax, computeReturn, safeHarbor, taxWithPreferential, type PersonIncome, type W2 } from "./computeReturn";
import { taxYearParams } from "./params";

const P26 = taxYearParams(2026);
const $ = (d: number) => Math.round(d * 100);

function person(over: Partial<PersonIncome> = {}, w2: Partial<W2> | null = {}): PersonIncome {
  return {
    id: "a",
    name: "A",
    w2s: w2
      ? [
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
        ]
      : [],
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

describe("federal brackets (Rev. Proc. 2025-32 tables)", () => {
  it("matches the published bracket-boundary amounts", () => {
    expect(bracketTax($(211_400), P26.federal.brackets.MFJ)).toBe($(35_932));
    expect(bracketTax($(768_700), P26.federal.brackets.MFJ)).toBe($(206_583.5));
    expect(bracketTax($(201_775), P26.federal.brackets.SINGLE)).toBe($(41_024));
    expect(bracketTax($(640_600), P26.federal.brackets.HOH)).toBe($(191_171));
  });

  it("stacks qualified dividends on top of ordinary income", () => {
    const t = taxWithPreferential($(100_000), $(10_000), P26.federal, "MFJ");
    expect(t.ordinaryTax).toBe($(10_304));
    // 8,900 fits under the 0% ceiling (98,900); the other 1,100 is taxed at 15%.
    expect(t.preferentialTax).toBe($(165));
  });
});

describe("Connecticut tax calculation schedule", () => {
  it("matches the CT-1040 TCS worked example for Table B", () => {
    const r = computeReturn({
      params: P26,
      filingStatus: "SINGLE",
      people: [person({ otherIncome: $(525_000) }, null)],
      dependents: [],
    });
    expect(r.ct.initialTax).toBe($(32_997.5));
    // Table C max for single + Table D: 2,950 + 50 × 5 steps over 500,000.
    expect(r.ct.addBack).toBe($(250));
    expect(r.ct.recapture).toBe($(3_200));
  });

  it("applies the joint add-back and recapture at $300,000", () => {
    const r = computeReturn({
      params: P26,
      filingStatus: "MFJ",
      people: [person({ otherIncome: $(300_000) }, null)],
      dependents: [],
    });
    expect(r.ct.exemption).toBe(0);
    expect(r.ct.initialTax).toBe($(15_500));
    expect(r.ct.addBack).toBe($(500));
    expect(r.ct.recapture).toBe($(450));
    expect(r.ct.totalTax).toBe($(16_450));
  });

  it("phases the personal exemption out $1,000 per $1,000", () => {
    const r = computeReturn({ params: P26, filingStatus: "SINGLE", people: [person({ otherIncome: $(30_500) }, null)], dependents: [] });
    expect(r.ct.exemption).toBe($(14_000));
  });

  it("deducts CHET contributions up to the per-return cap", () => {
    const r = computeReturn({
      params: P26,
      filingStatus: "MFJ",
      people: [person({ otherIncome: $(200_000), ctChetContributions: $(15_000) }, null)],
      dependents: [],
    });
    expect(r.ct.chetDeduction).toBe($(10_000));
    expect(r.ct.ctAgi).toBe($(190_000));
  });
});

describe("payroll surtaxes and credits", () => {
  const w2 = { box1Wages: $(315_000), box3SsWages: $(184_500), box5MedicareWages: $(340_000), box16StateWages: $(315_000) };

  it("computes additional Medicare against the joint threshold and credits what was withheld", () => {
    const r = computeReturn({
      params: P26,
      filingStatus: "MFJ",
      people: [person({}, { ...w2, medicareWithheld: $(340_000 * 0.0145 + 140_000 * 0.009) })],
      dependents: [],
    });
    expect(r.federal.additionalMedicareTax).toBe($(810));
    // The employer withholds 0.9% above $200k regardless of filing status.
    expect(r.federal.additionalMedicareWithheld).toBe($(1_260));
    expect(r.fica.socialSecurity).toBe($(11_439));
  });

  it("phases the child tax credit out $50 per $1,000 over $400k joint", () => {
    const r = computeReturn({
      params: P26,
      filingStatus: "MFJ",
      people: [person({}, { box1Wages: $(410_500), box5MedicareWages: $(410_500) })],
      dependents: [{ name: "Kid", age: 1 }],
    });
    expect(r.federal.agi).toBe($(410_500));
    expect(r.federal.childTaxCredit).toBe($(2_200 - 550));
  });

  it("charges NIIT on the lesser of investment income and MAGI over the threshold", () => {
    const r = computeReturn({
      params: P26,
      filingStatus: "MFJ",
      people: [person({ ordinaryDividends: $(10_000), qualifiedDividends: $(9_000) }, { box1Wages: $(245_000), box5MedicareWages: $(245_000) })],
      dependents: [],
    });
    expect(r.federal.niit).toBe(Math.round(0.038 * $(5_000)));
  });

  it("limits capital losses to $3,000 and carries the rest", () => {
    const r = computeReturn({
      params: P26,
      filingStatus: "MFJ",
      people: [person({ shortTermGain: $(-8_000), longTermGain: $(-500) }, { box1Wages: $(100_000) })],
      dependents: [],
    });
    expect(r.federal.capitalGainAllowed).toBe($(-3_000));
    expect(r.federal.capitalLossCarryover).toBe($(-5_500));
  });

  it("caps SALT and itemizes only when it beats the standard deduction", () => {
    const r = computeReturn({
      params: P26,
      filingStatus: "MFJ",
      people: [person({ propertyTax: $(12_000), mortgageInterest: $(20_000) }, { box1Wages: $(300_000), stateWithheld: $(18_000) })],
      dependents: [],
    });
    expect(r.federal.itemized.salt).toBe($(30_000));
    expect(r.federal.itemizes).toBe(true);
    expect(r.federal.deduction).toBe($(50_000));
  });
});

describe("safe harbor", () => {
  it("uses 110% of last year's tax when prior AGI was over $150k and that is smaller", () => {
    const s = safeHarbor({
      currentYearTax: $(90_000),
      withholding: $(70_000),
      estimatesPaid: 0,
      priorYearTax: $(60_000),
      priorYearAgi: $(300_000),
      highAgiThreshold: $(150_000),
    });
    expect(s.requiredAnnualPayment).toBe($(66_000));
    expect(s.basis).toBe("PRIOR_YEAR");
    expect(s.shortfall).toBe(0);
  });

  it("falls back to 90% of this year's tax without a prior year", () => {
    const s = safeHarbor({ currentYearTax: $(50_000), withholding: $(40_000), estimatesPaid: 0, priorYearTax: null, priorYearAgi: null, highAgiThreshold: null });
    expect(s.requiredAnnualPayment).toBe($(45_000));
    expect(s.shortfall).toBe($(5_000));
  });
});
