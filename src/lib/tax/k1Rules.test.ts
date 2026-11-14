import { describe, expect, it } from "vitest";
import type { K1Form } from "../taxdocs/types";
import { cappedBracketTax, computeReturn, qbiBusinessComponent, taxWithPreferential, type PersonIncome, type QbiBusiness, type W2 } from "./computeReturn";
import { expectedK1, k1Adds, k1Items } from "./k1";
import type { K1Detail } from "./k1DetailStore";
import { taxYearParams } from "./params";
import { passiveCarryforwards, passiveLimit } from "./passive";

// Every name and figure here is made up. Each rule is checked against the form it comes from.
const P25 = taxYearParams(2025);
const P26 = taxYearParams(2026);
const $ = (d: number) => Math.round(d * 100);

const w2 = (over: Partial<W2> = {}): W2 => ({ employer: "Employer", grossPay: 0, box1Wages: 0, box3SsWages: 0, box5MedicareWages: 0, box16StateWages: 0, federalWithheld: 0, ssWithheld: 0, medicareWithheld: 0, stateWithheld: 0, ...over });
const wagesOf = (n: number) => [w2({ box1Wages: $(n), box3SsWages: $(Math.min(n, 176_100)), box5MedicareWages: $(n) })];

function person(over: Partial<PersonIncome> = {}): PersonIncome {
  return {
    id: "a",
    name: "A",
    w2s: [],
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
const fed = (p: PersonIncome, params = P25) => computeReturn({ params, filingStatus: "MFJ", people: [p], dependents: [] }).federal;

describe("Schedule E: partnership income on the return", () => {
  it("is income like any other, on the other-income line", () => {
    const base = fed(person({ w2s: wagesOf(100_000) }));
    const f = fed(person({ w2s: wagesOf(100_000), partnershipIncome: $(10_000), royalties: $(2_000), portfolioOtherIncome: $(500) }));
    expect(f.scheduleE).toBe($(12_000));
    expect(f.otherIncome).toBe($(12_500));
    expect(f.agi - base.agi).toBe($(12_500));
  });

  it("a loss the year allows lowers income", () => {
    expect(fed(person({ w2s: wagesOf(100_000), partnershipIncome: -$(4_000) })).agi).toBe($(96_000));
  });
});

describe("Form 8960: net investment income with a partnership's", () => {
  const high = { w2s: wagesOf(400_000) };

  it("counts passive and trading-fund income, royalties and other portfolio income", () => {
    const f = fed(person({ ...high, partnershipIncome: $(20_000), partnershipNii: $(20_000), royalties: $(1_000), portfolioOtherIncome: $(500) }));
    expect(f.netInvestmentIncome).toBe($(21_500));
    expect(f.niit).toBe(Math.round($(21_500) * 0.038));
  });

  it("leaves out income from a business the partner works in", () => {
    expect(fed(person({ ...high, partnershipIncome: $(20_000) })).niit).toBe(0);
  });
});

describe("Schedule SE", () => {
  it("taxes 92.35% of net earnings at 12.4% and 2.9%, and deducts half", () => {
    const f = fed(person({ seEarnings: $(100_000), partnershipIncome: $(100_000) }));
    const net = Math.round($(100_000) * 0.9235);
    const tax = Math.round(net * 0.124) + Math.round(net * 0.029);
    expect(f.selfEmploymentNet).toBe(net);
    expect(f.selfEmploymentTax).toBe(tax);
    expect(f.selfEmploymentDeduction).toBe(Math.round(tax / 2));
    expect(f.agi).toBe($(100_000) - Math.round(tax / 2));
    expect(f.totalTax).toBe(f.incomeTaxAfterCredits + tax);
  });

  it("charges Social Security only up to what the wage base leaves after W-2 wages", () => {
    const net = Math.round($(50_000) * 0.9235);
    // 2025 wage base $176,100: wages already at it leave only Medicare.
    expect(fed(person({ w2s: wagesOf(200_000), seEarnings: $(50_000) })).selfEmploymentTax).toBe(Math.round(net * 0.029));
    // $150,000 of wages leaves $26,100 of the base.
    expect(fed(person({ w2s: wagesOf(150_000), seEarnings: $(50_000) })).selfEmploymentTax).toBe(Math.round($(26_100) * 0.124) + Math.round(net * 0.029));
  });

  it("owes nothing under $400 of net earnings", () => {
    expect(fed(person({ seEarnings: $(430) })).selfEmploymentTax).toBe(0);
    expect(fed(person({ seEarnings: $(440) })).selfEmploymentTax).toBeGreaterThan(0);
  });

  it("counts toward the Additional Medicare tax after wages (Form 8959)", () => {
    const f = fed(person({ w2s: wagesOf(240_000), seEarnings: $(100_000) }));
    expect(f.additionalMedicareTax).toBe(Math.round(($(240_000) + f.selfEmploymentNet - $(250_000)) * 0.009));
  });
});

describe("Form 8995-A: the business income deduction", () => {
  const fp = P25.federal;
  const biz = (over: Partial<QbiBusiness> = {}): QbiBusiness => ({ name: "EXAMPLE PARTNERS LP", income: $(100_000), w2Wages: $(20_000), ubia: 0, sstb: false, active: true, ...over });
  // 2025 joint: threshold $394,600, range $100,000.
  const below = $(300_000);
  const halfway = $(444_600);
  const above = $(600_000);

  it("is 20% of the income at or below the threshold, whatever the wages", () => {
    expect(qbiBusinessComponent(fp, "MFJ", below, [biz({ w2Wages: 0 })]).component).toBe($(20_000));
  });

  it("above the range is held to the greater of 50% of wages or 25% of wages plus 2.5% of property", () => {
    expect(qbiBusinessComponent(fp, "MFJ", above, [biz()]).component).toBe($(10_000));
    expect(qbiBusinessComponent(fp, "MFJ", above, [biz({ w2Wages: $(8_000), ubia: $(400_000) })]).component).toBe($(12_000));
    expect(qbiBusinessComponent(fp, "MFJ", above, [biz({ w2Wages: $(60_000) })]).component).toBe($(20_000));
  });

  it("phases the cut in across the range (Part III)", () => {
    // Halfway through: half of the $10,000 excess over the wage limit comes off.
    expect(qbiBusinessComponent(fp, "MFJ", halfway, [biz()]).component).toBe($(15_000));
  });

  it("phases a service business out across the range and drops it above", () => {
    // Halfway: half the income, wages and property count; then the same phased-in cut.
    expect(qbiBusinessComponent(fp, "MFJ", halfway, [biz({ sstb: true })]).component).toBe($(7_500));
    expect(qbiBusinessComponent(fp, "MFJ", above, [biz({ sstb: true })]).component).toBe(0);
    expect(qbiBusinessComponent(fp, "MFJ", below, [biz({ sstb: true })]).component).toBe($(20_000));
  });

  it("nets one business's loss against the others' income", () => {
    expect(qbiBusinessComponent(fp, "MFJ", below, [biz(), biz({ name: "EXAMPLE REALTY LP", income: -$(40_000) })]).component).toBe($(12_000));
    expect(qbiBusinessComponent(fp, "MFJ", below, [biz({ income: -$(5_000) })]).component).toBe(0);
  });

  it("uses the wider range from 2026 (Rev. Proc. 2025-32: $150,000 joint)", () => {
    // 2026 joint: threshold $403,500; $75,000 over is halfway.
    expect(qbiBusinessComponent(P26.federal, "MFJ", $(478_500), [biz()]).component).toBe($(15_000));
  });

  it("on the return: capped at 20% of taxable income less net capital gain, and from 2026 never under the minimum for a business you work in", () => {
    const f = fed(person({ w2s: wagesOf(100_000), partnershipIncome: $(100_000), qbiBusinesses: [biz()] }));
    expect(f.qbiDeduction).toBe($(20_000));
    expect(f.qbi).toMatchObject({ business: $(20_000), reit: 0 });
    const small = (params: typeof P25) => fed(person({ w2s: wagesOf(50_000), partnershipIncome: $(1_500), qbiBusinesses: [biz({ income: $(1_500), w2Wages: 0 })] }), params).qbiDeduction;
    expect(small(P25)).toBe($(300));
    expect(small(P26)).toBe($(400));
    expect(fed(person({ w2s: wagesOf(50_000), partnershipIncome: $(1_500), qbiBusinesses: [biz({ income: $(1_500), w2Wages: 0, active: false })] }), P26).qbiDeduction).toBe($(300));
  });
});

describe("Schedule D Tax Worksheet: gain taxed at up to 25% and 28%", () => {
  const fp = P26.federal;
  const b = fp.brackets.MFJ;

  it("taxes it at the bracket rate while that is lower", () => {
    // Nothing else: $10,000 of unrecaptured section 1250 gain sits in the 10% bracket.
    const t = taxWithPreferential($(10_000), $(10_000), fp, "MFJ", { unrecaptured1250: $(10_000), collectibles: 0 });
    expect(t.rateGainTax).toBe($(1_000));
    expect(t.preferentialTax).toBe($(1_000));
  });

  it("caps it at 25% and 28% once ordinary income is past those brackets", () => {
    const ordinary = b[4]! + $(1_000); // in the 35% bracket
    const t = taxWithPreferential(ordinary + $(30_000), $(30_000), fp, "MFJ", { unrecaptured1250: $(10_000), collectibles: $(10_000) });
    expect(t.rateGainTax).toBe($(2_500) + $(2_800));
    // The other $10,000 is ordinary long-term gain, above the 15% band's top here.
    expect(t.preferentialTax - t.rateGainTax).toBe(Math.round($(10_000) * (ordinary + $(20_000) >= fp.capitalGains.MFJ.fifteenMax ? 0.2 : 0.15)));
  });

  it("splits a gain that straddles the 24% bracket's top", () => {
    const ordinary = b[3]! - $(4_000); // $4,000 of room left at 24%
    expect(cappedBracketTax(ordinary, ordinary + $(10_000), b, 0.25)).toBe(Math.round($(4_000) * 0.24 + $(6_000) * 0.25));
  });

  it("changes nothing when there is none", () => {
    const plain = taxWithPreferential($(200_000), $(50_000), fp, "MFJ");
    expect(plain.rateGainTax).toBe(0);
    expect(taxWithPreferential($(200_000), $(50_000), fp, "MFJ", { unrecaptured1250: 0, collectibles: 0 })).toEqual(plain);
  });

  it("on the return: only as much as the year's net long-term gain", () => {
    const f = fed(person({ w2s: wagesOf(500_000), longTermGain: $(8_000), unrecaptured1250Gain: $(20_000) }));
    expect(f.rateGain).toMatchObject({ unrecaptured1250: $(8_000), collectibles: 0, tax: $(2_000) });
  });
});

describe("Form 4952: investment interest", () => {
  const itemizer = { w2s: wagesOf(300_000), mortgageInterest: $(40_000) };

  it("is deductible up to the year's investment income, qualified dividends and net capital gain aside", () => {
    const f = fed(person({ ...itemizer, taxableInterest: $(3_000), ordinaryDividends: $(10_000), qualifiedDividends: $(9_000), longTermGain: $(50_000), investmentInterestExpense: $(6_000) }));
    expect(f.investmentInterest).toEqual({ paid: $(6_000), investmentIncome: $(4_000), allowed: $(4_000) });
    expect(f.itemized.investmentInterest).toBe($(4_000));
    expect(f.itemizes).toBe(true);
  });

  it("comes off net investment income when deducted, and does nothing on a standard-deduction return", () => {
    const itemized = fed(person({ ...itemizer, taxableInterest: $(10_000), investmentInterestExpense: $(6_000) }));
    expect(itemized.netInvestmentIncome).toBe($(4_000));
    const standard = fed(person({ w2s: wagesOf(300_000), taxableInterest: $(10_000), investmentInterestExpense: $(6_000) }));
    expect(standard.itemizes).toBe(false);
    expect(standard.netInvestmentIncome).toBe($(10_000));
    expect(standard.deduction).toBe(standard.standardDeduction);
  });
});

describe("Form 1116: the foreign tax credit limit", () => {
  const base = { w2s: wagesOf(300_000), ordinaryDividends: $(20_000) };

  it("credits up to $600 on a joint return without the form", () => {
    const f = fed(person({ ...base, foreignTaxPaid: $(600), foreignTaxSourced: $(600), foreignSourceIncome: $(100) }));
    expect(f.foreignTax.limit).toBeNull();
    expect(f.foreignTaxCredit).toBe($(600));
  });

  it("above that, holds a K-1's foreign tax to US tax × foreign-source ÷ taxable income", () => {
    const f = fed(person({ ...base, foreignTaxPaid: $(5_000), foreignTaxSourced: $(5_000), foreignSourceIncome: $(10_000) }));
    const limit = Math.round(f.regularTax * ($(10_000) / f.taxableIncome));
    expect(f.foreignTax.limit).toBe(limit);
    expect(f.foreignTaxCredit).toBe(Math.min($(5_000), limit));
    expect(f.foreignTaxCredit).toBeLessThan($(5_000));
  });

  it("credits tax whose foreign income isn't known (a brokerage 1099) as paid, beside the limited part", () => {
    const f = fed(person({ ...base, foreignTaxPaid: $(5_000), foreignTaxSourced: $(2_000), foreignSourceIncome: $(100_000) }));
    expect(f.foreignTaxCredit).toBe($(5_000));
    expect(fed(person({ ...base, foreignTaxPaid: $(5_000) })).foreignTaxCredit).toBe($(5_000));
  });
});

describe("state pass-through entity tax credits", () => {
  it("Connecticut's is a payment (CT-1040 line 20c)", () => {
    const plain = computeReturn({ params: P25, filingStatus: "MFJ", people: [person({ w2s: wagesOf(200_000) })], dependents: [] }).ct;
    const ct = computeReturn({ params: P25, filingStatus: "MFJ", people: [person({ w2s: wagesOf(200_000), ctPeCredit: $(1_750) })], dependents: [] }).ct;
    expect(ct.peCredit).toBe($(1_750));
    expect(ct.totalTax).toBe(plain.totalTax);
    expect(ct.balanceDue).toBe(plain.balanceDue - $(1_750));
  });

  it("New York's is added back to income, then credited as paid (IT-653, IT-225)", () => {
    const ny = { state: "RESIDENT", city: "NONE", cityMonths: 0 } as const;
    const plain = computeReturn({ params: P25, filingStatus: "MFJ", people: [person({ w2s: wagesOf(200_000) })], dependents: [], ny }).ny!;
    const withCredit = computeReturn({ params: P25, filingStatus: "MFJ", people: [person({ w2s: wagesOf(200_000), nyPtetCredit: $(2_000) })], dependents: [], ny }).ny!;
    expect(withCredit.nyAgi).toBe(plain.nyAgi + $(2_000));
    expect(withCredit.totalPayments).toBe(plain.totalPayments + $(2_000));
  });
});

describe("Form 8582: the passive-loss limit", () => {
  const act = (key: string, net: number, over: { publiclyTraded?: boolean; final?: boolean } = {}) => ({ key, net: $(net), publiclyTraded: false, final: false, ...over });

  it("suspends a loss with no passive income to absorb it", () => {
    expect(passiveLimit([act("a", -9_000)], {})).toEqual({ a: { carryIn: 0, allowed: 0, suspended: $(9_000) } });
  });

  it("lets passive income from one partnership absorb another's loss", () => {
    const r = passiveLimit([act("a", -9_000), act("b", 5_000)], {});
    expect(r.a).toEqual({ carryIn: 0, allowed: -$(5_000), suspended: $(4_000) });
    expect(r.b).toEqual({ carryIn: 0, allowed: $(5_000), suspended: 0 });
  });

  it("shares what income there is among the losses in proportion", () => {
    const r = passiveLimit([act("a", -6_000), act("b", -2_000), act("c", 4_000)], {});
    expect([r.a!.allowed, r.b!.allowed]).toEqual([-$(3_000), -$(1_000)]);
    expect([r.a!.suspended, r.b!.suspended]).toEqual([$(3_000), $(1_000)]);
  });

  it("uses a loss carried in against this year's income, the same partnership's or another's", () => {
    expect(passiveLimit([act("a", 7_000)], { a: $(9_000) }).a).toEqual({ carryIn: $(9_000), allowed: 0, suspended: $(2_000) });
    // A partnership with no K-1 this year still carries its loss.
    expect(passiveLimit([act("b", 3_000)], { a: $(9_000) })).toEqual({ a: { carryIn: $(9_000), allowed: -$(3_000), suspended: $(6_000) }, b: { carryIn: 0, allowed: $(3_000), suspended: 0 } });
  });

  it("releases every suspended loss with a final K-1", () => {
    expect(passiveLimit([act("a", -1_000, { final: true })], { a: $(9_000) }).a).toEqual({ carryIn: $(9_000), allowed: -$(10_000), suspended: 0 });
  });

  it("keeps a publicly traded partnership's loss for its own later income", () => {
    const r = passiveLimit([act("ptp", -4_000, { publiclyTraded: true }), act("b", 10_000)], {});
    expect(r.ptp).toEqual({ carryIn: 0, allowed: 0, suspended: $(4_000) });
    expect(r.b!.allowed).toBe($(10_000));
    expect(passiveLimit([act("ptp", 6_000, { publiclyTraded: true })], { ptp: $(4_000) }).ptp).toEqual({ carryIn: $(4_000), allowed: $(2_000), suspended: 0 });
  });

  describe("from year to year", () => {
    const EIN = "00-1234567";
    const k1 = (over: Partial<K1Form>): { form: K1Form; personId: string | null } => ({ form: { ...expectedK1(null, "EXAMPLE FUND LP", EIN, {}), ...over }, personId: "pat" });

    it("carries each year's suspended loss into the next, until income or a final K-1 uses it", () => {
      const carry = passiveCarryforwards(
        [
          { year: 2025, k1s: [k1({ ordinaryBusiness: -$(9_000) })] },
          { year: 2026, k1s: [k1({ ordinaryBusiness: $(2_000) })] },
          { year: 2027, k1s: [k1({ ordinaryBusiness: -$(500), final: true })] },
        ],
        null,
      );
      expect(carry(2025)).toEqual({});
      expect(carry(2026)).toEqual({ [EIN]: $(9_000) });
      expect(carry(2027)).toEqual({ [EIN]: $(7_000) });
      expect(carry(2028)).toEqual({});
    });

    it("starts from a loss carried in from before the app's records, and skips a fund that isn't passive", () => {
      const detail = (over: Partial<K1Detail>): K1Detail => ({ ein: EIN, year: 2025, lines: [], ...over });
      const years = [{ year: 2025, k1s: [k1({ ordinaryBusiness: -$(1_000) })] }];
      expect(passiveCarryforwards(years, { version: 1, k1s: [detail({ openingSuspendedLoss: $(4_000) })] })(2026)).toEqual({ [EIN]: $(5_000) });
      expect(passiveCarryforwards(years, { version: 1, k1s: [detail({ activity: "TRADER_FUND" })] })(2026)).toEqual({});
    });
  });
});

describe("what one K-1 adds to its owner's return", () => {
  const items = (over: Partial<K1Form>, detail: K1Detail | null = null) => k1Items({ ...expectedK1(null, "EXAMPLE FUND LP", "00-1234567", {}), ...over }, detail);

  it("puts the allowed activity on Schedule E, as investment income when passive or a trading fund's", () => {
    const k = items({ ordinaryBusiness: $(8_000), guaranteedPayments: $(1_000), interest: $(300) });
    expect(k1Adds("EXAMPLE FUND LP", k, $(8_000), false).adds).toEqual({ taxableInterest: $(300), partnershipIncome: $(9_000), partnershipNii: $(8_000) });
    const working = { ...k, passive: false };
    expect(k1Adds("EXAMPLE FUND LP", working, $(8_000), false).adds.partnershipNii).toBeUndefined();
    expect(k1Adds("EXAMPLE FUND LP", working, $(8_000), true).adds.partnershipNii).toBe($(8_000));
  });

  it("holds foreign tax to the limit only once its Schedule K-3 income is read", () => {
    expect(k1Adds("X", items({ foreignTax: $(900) }), 0, false).adds).toEqual({ foreignTaxPaid: $(900) });
    const read: K1Detail = { ein: "00-1234567", year: 2025, lines: [{ box: "K3", label: "Example", cents: $(4_000), treatment: "FOREIGN_SOURCE_PASSIVE" }] };
    expect(k1Adds("X", items({ foreignTax: $(900) }, read), 0, false).adds).toEqual({ foreignTaxPaid: $(900), foreignTaxSourced: $(900), foreignSourceIncome: $(4_000) });
  });

  it("sends each state's items where that state's return takes them", () => {
    const line = (treatment: K1Detail["lines"][number]["treatment"], state: string, cents: number) => ({ box: "STATE", label: "Example", cents, treatment, state });
    const d: K1Detail = { ein: "00-1234567", year: 2025, lines: [line("PTE_TAX_CREDIT", "CT", $(700)), line("PTE_TAX_CREDIT", "NY", $(300)), line("STATE_TAX_WITHHELD", "NJ", $(120)), line("STATE_ADDITION", "CT", $(50)), line("STATE_TAX_WITHHELD", "CT", $(80))] };
    expect(k1Adds("X", items({}, d), 0, false).adds).toEqual({ ctPeCredit: $(700), nyPtetCredit: $(300), otherStateTax: $(120), ctOtherAdditions: $(50), estimatedCt: $(80) });
  });

  it("names its business for the 20% deduction, active unless the partner is passive", () => {
    const d: K1Detail = { ein: "00-1234567", year: 2025, passive: false, lines: [{ box: "20", code: "Z", label: "Example", cents: $(30_000), treatment: "QBI_INCOME" }, { box: "20", code: "Z", label: "Example", cents: $(8_000), treatment: "QBI_W2_WAGES" }] };
    expect(k1Adds("EXAMPLE FUND LP", items({}, d), 0, false).qbi).toEqual({ name: "EXAMPLE FUND LP", income: $(30_000), w2Wages: $(8_000), ubia: 0, sstb: false, active: true });
    expect(k1Adds("EXAMPLE FUND LP", items({}), 0, false).qbi).toBeNull();
  });
});
