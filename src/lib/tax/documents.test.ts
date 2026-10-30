import { describe, expect, it } from "vitest";
import type { FederalReturnSummary, FiledReturn, W2Form } from "../taxdocs/types";
import type { TaxReport } from "./buildTaxReport";
import { computeReturn, type PersonIncome, type ReturnResult } from "./computeReturn";
import { ctResidentShares, filedBalance, k1Income, matchW2s, safeHarborTax, w2FromForm, type YearDocs } from "./documents";
import { taxPaymentsFrom } from "./facts/payments";
import { w2FromAmounts, ZERO_AMOUNTS } from "./facts/payroll";
import { checkFiled, documentTies } from "./filedCheck";
import { taxYearParams } from "./params";
import { DEFAULT_PAY_FORECAST, EMPTY_EXTRAS, emptyYear } from "./profile";

// Every name and figure here is made up.
const P25 = taxYearParams(2025);
const $ = (d: number) => Math.round(d * 100);

const form = (over: Partial<W2Form> = {}): W2Form => ({
  employer: "EXAMPLE PAYROLL LLC",
  ein: null,
  employee: "PAT EXAMPLE",
  wages: $(90_000),
  federalWithheld: $(15_000),
  ssWages: $(100_000),
  ssWithheld: $(6_200),
  medicareWages: $(100_000),
  medicareWithheld: $(1_450),
  dependentCare: 0,
  box12: [
    { code: "D", amount: $(10_000) },
    { code: "W", amount: $(3_000) },
  ],
  states: [
    { state: "CT", wages: $(60_000), withheld: $(3_000) },
    { state: "NY", wages: $(30_000), withheld: $(1_500) },
  ],
  locals: [{ name: "NYC", wages: $(30_000), withheld: $(900) }],
  ...over,
});

function person(over: Partial<PersonIncome> = {}): PersonIncome {
  return {
    id: "pat",
    name: "Pat",
    w2s: [w2FromForm(form(), null)],
    taxableInterest: $(1_000.4),
    ordinaryDividends: $(2_000.6),
    qualifiedDividends: $(1_500.2),
    section199aDividends: $(100),
    taxExemptInterest: 0,
    usObligationIncome: 0,
    capitalGainDistributions: 0,
    shortTermGain: 0,
    longTermGain: $(3_000.25),
    foreignTaxPaid: 0,
    retirementTaxable: 0,
    otherIncome: 0,
    businessIncome: 0,
    adjustments: 0,
    ctChetContributions: 0,
    ctOtherSubtractions: 0,
    ctOtherAdditions: 0,
    estimatedFederal: $(2_000),
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

describe("W-2 forms in place of pay stubs", () => {
  it("keeps Connecticut's withholding apart from other states' and cities'", () => {
    const w = w2FromForm(form(), null);
    expect(w).toMatchObject({ box1Wages: $(90_000), box16StateWages: $(60_000), stateWithheld: $(3_000), otherStateWithheld: $(2_400), box12: { D: $(10_000), W: $(3_000) } });
  });

  it("pairs each form with the payroll whose wages it matches", () => {
    const stub = (employer: string, wages: number) => ({ employer, w2Ytd: w2FromAmounts(employer, { ...ZERO_AMOUNTS, gross: wages }, P25.federal) });
    const a = stub("A", $(50_000));
    const b = stub("B", $(20_000));
    const forms = [form({ wages: $(20_010) }), form({ wages: $(49_950) }), form({ wages: $(5_000) })].map((f, i) => ({ doc: { id: String(i), file: `${i}.pdf` }, personId: "pat", form: f }));
    const { pairs, formsOnly, stubsOnly } = matchW2s([a, b], forms);
    expect(pairs.map(([p, f]) => [p.employer, f.doc.id])).toEqual([
      ["A", "1"],
      ["B", "0"],
    ]);
    expect(formsOnly.map((f) => f.doc.id)).toEqual(["2"]);
    expect(stubsOnly).toEqual([]);
  });
});

describe("K-1s", () => {
  it("passes portfolio income through and nets the passive boxes", () => {
    const k = k1Income({
      partnership: "EXAMPLE FUND LP",
      ein: null,
      partner: "PAT EXAMPLE",
      limitedPartner: true,
      final: false,
      periodStart: null,
      periodEnd: null,
      ordinaryBusiness: -700,
      rentalRealEstate: -1_900,
      otherRental: 0,
      guaranteedPayments: 0,
      interest: 2_100,
      ordinaryDividends: 3_600,
      qualifiedDividends: 3_600,
      royalties: 0,
      shortTermGain: 0,
      longTermGain: -900,
      section1231: 0,
      foreignTax: 0,
    });
    expect(k).toMatchObject({ interest: 2_100, ordinaryDividends: 3_600, longTermGain: -900, passive: -2_600 });
  });
});

describe("filed returns settle the spring payments", () => {
  const rows = [{ id: "t1", date: "2025-03-17", amountCents: -$(5_000), payee: "IRS USATAXPYMT", authority: "FEDERAL" as const }];

  it("a payment can't be last year's balance due when last year's return showed a refund", () => {
    const [p] = taxPaymentsFrom(rows, {}, { 2024: { FEDERAL: -$(1_000) } });
    expect(p).toMatchObject({ attribution: { kind: "ESTIMATE", taxYear: 2025 }, basis: "FILED_RETURN" });
  });

  it("stays last year's balance due when that return showed tax owed", () => {
    const [p] = taxPaymentsFrom(rows, {}, { 2024: { FEDERAL: $(5_000) } });
    expect(p).toMatchObject({ attribution: { kind: "BALANCE_DUE", taxYear: 2024 }, basis: "FILED_RETURN" });
    expect(taxPaymentsFrom(rows, {})[0]).toMatchObject({ attribution: { kind: "BALANCE_DUE", taxYear: 2024 }, basis: "DATE" });
  });
});

describe("part-year Connecticut (CT-1040NR/PY)", () => {
  it("cuts the full-year tax to the Connecticut-source share, rounded to four decimals", () => {
    const full = computeReturn({ params: P25, filingStatus: "MFJ", people: [person()], dependents: [] });
    const part = computeReturn({ params: P25, filingStatus: "MFJ", people: [person({ ctSourceIncome: $(30_000) })], dependents: [] });
    const pct = Math.round(($(30_000) / full.ct.ctAgi) * 10_000) / 10_000;
    expect(part.ct.incomePercentage).toBe(pct);
    expect(part.ct.taxBeforeAllocation).toBe(full.ct.taxBeforeCredits);
    expect(part.ct.taxBeforeCredits).toBe(Math.round(full.ct.taxBeforeCredits * pct));
    expect(part.federal.totalTax).toBe(full.federal.totalTax);
  });

  it("takes the resident share of investment income from the filed CT-1040AW", () => {
    const ct = { lines: [2, 3, 6].map((n) => ({ form: "CT-1040AW", page: 1, line: String(n), label: "", values: [1000, 650, 350] })) } as unknown as FiledReturn;
    expect(ctResidentShares(ct).investment).toBeCloseTo(0.65);
  });
});

/** A filed 1040's figures as the return prints them (whole dollars) from a computed return. */
function filed(r: ReturnResult, over: Partial<FederalReturnSummary> = {}): FiledReturn {
  const f = r.federal;
  const d = (c: number) => Math.round(c / 100) * 100;
  const s: Partial<FederalReturnSummary> = {
    wages: d(f.wages),
    taxableInterest: d(f.interest),
    qualifiedDividends: d(f.qualifiedDividends),
    ordinaryDividends: d(f.ordinaryDividends),
    capitalGain: d(f.capitalGainAllowed),
    additionalIncome: d(f.otherIncome),
    totalIncome: d(f.totalIncome),
    adjustments: 0,
    agi: d(f.agi),
    deduction: d(f.deduction),
    qbiDeduction: d(f.qbiDeduction),
    taxableIncome: d(f.taxableIncome),
    tax: d(f.regularTax),
    additionalMedicareTax: d(f.additionalMedicareTax),
    niit: d(f.niit),
    totalTax: d(f.totalTax),
    w2Withholding: d(f.withholding),
    otherWithholding: d(f.additionalMedicareWithheld),
    estimatedPayments: d(f.estimatedPayments),
    excessSsCredit: d(f.excessSsCredit),
    totalPayments: d(f.totalPayments),
  };
  const owed = d(f.totalTax) - d(f.totalPayments);
  if (owed > 0) s.amountOwed = owed;
  else s.refund = -owed;
  Object.assign(s, over);
  return { jurisdiction: "FEDERAL", form: "1040", filingStatus: "MFJ", printedOn: null, movedOn: null, lines: [], otherIncome: [{ label: "EXAMPLE OTHER INCOME", amount: $(1_500) }], federal: s as FederalReturnSummary, state: null };
}

function report(income: PersonIncome, settled: ReturnResult | null = null): TaxReport {
  const mfj = computeReturn({ params: P25, filingStatus: "MFJ", people: [income], dependents: [] });
  // What the bank shows: the estimates, and the balance settled at filing.
  const pay = (date: string, amount: number, kind: string) => ({ transactionId: date, date, amount, payee: "IRS", authority: "FEDERAL", attribution: { kind, taxYear: 2025 }, overridden: false, basis: "DATE" });
  const owed = settled ? Math.round(settled.federal.totalTax / 100) * 100 - Math.round(settled.federal.totalPayments / 100) * 100 : 0;
  const payments = [pay("2025-06-15", income.estimatedFederal, "ESTIMATE"), ...(settled ? [owed > 0 ? pay("2026-04-10", owed, "BALANCE_DUE") : pay("2026-03-10", owed, "REFUND")] : [])];
  const inputs = { ...emptyYear(), people: { pat: { extras: { ...EMPTY_EXTRAS }, pay: { ...DEFAULT_PAY_FORECAST } } } };
  return {
    year: 2025,
    people: [{ id: "pat", name: "Pat", income, payroll: [], k1s: [], ctSource: null }],
    accounts: [],
    payments,
    dependents: [],
    inputs,
    profile: { persons: [{ id: "pat", name: "Pat", match: ["PAT"] }] },
    residency: { ct: "FULL", movedIn: null, investmentShare: 1, sourceIncome: null, source: "DEFAULT" },
    filingStatus: "MFJ",
    scenarios: { mfj },
  } as unknown as TaxReport;
}

const docs = (federal: FiledReturn): YearDocs => ({ year: 2025, federal: { ...federal, doc: { id: "r", file: "2025/return.pdf" } }, ct: null, ny: null, w2s: [], brokerage: [], ints: [], rs: [], k1s: [], other: [], all: [] });

describe("the model against the filed return", () => {
  const truth = computeReturn({ params: P25, filingStatus: "MFJ", people: [person({ otherIncome: $(1_500) })], dependents: [] });

  it("matches every line to the dollar, the return's way (each amount rounded first)", () => {
    const c = checkFiled(report(person({ otherIncome: $(1_500) }), truth), docs(filed(truth)));
    expect(c.federal.filter((l) => l.status !== "MATCH").map((l) => `${l.key} ${l.filed} ${l.model}`)).toEqual([]);
    expect(c.summary).toMatchObject({ federal: "MATCH", differences: 0 });
    expect(c.suggestions).toEqual([]);
  });

  it("explains income the app doesn't have, with the input that would fix it", () => {
    const c = checkFiled(report(person()), docs(filed(truth)));
    const other = c.federal.find((l) => l.key === "additionalIncome")!;
    expect(other).toMatchObject({ status: "DIFFERENT", filed: $(1_500), model: 0 });
    expect(other.note).toMatch(/EXAMPLE OTHER INCOME/);
    expect(c.suggestions).toEqual([expect.objectContaining({ id: "otherIncome", set: [{ path: ["years", "2025", "people", "pat", "extras", "otherIncome"], value: $(1_500) }] })]);
    expect(c.federal.find((l) => l.key === "agi")!.note).toMatch(/Follows/);
  });

  it("a balance owed and a refund read as plus and minus", () => {
    expect(filedBalance(filed(truth, { amountOwed: $(500), refund: null }))).toBe($(500));
    expect(filedBalance(filed(truth, { amountOwed: null, refund: $(700) }))).toBe(-$(700));
    expect(safeHarborTax(filed(truth, { totalTax: $(10_000), refundableCredits: $(300), excessSsCredit: $(300) }))).toBe($(10_000));
  });
});

describe("a brokerage 1099 against the statements", () => {
  const figures = (o: Partial<Record<string, number>>) => ({ ordinaryDividends: 0, qualifiedDividends: 0, moneyMarketDividends: 0, interest: 0, capGainDistShort: 0, capGainDistLong: 0, shortTermGain: 0, longTermGain: 0, ...o });
  const form = (o: { fees?: number; payments: { date: string; amount: number }[] }) => ({ doc: { id: "b", file: "2023/1099.pdf" }, form: { proceedsInvestmentExpenses: o.fees ?? 0, dividendPayments: o.payments } });
  // The 1099 prints $1,000.00 of dividends and $500.00 of gains; the statements also hold a
  // $20.00 January dividend and net $15.00 of trust fees into gains.
  const report = (jan: { date: string; amount: number }[]) =>
    ({
      year: 2023,
      people: [],
      payments: [],
      bankInterest: { parts: [] },
      accounts: [
        {
          source: "1099",
          label: "Brokerage ••1234",
          doc: { id: "b", file: "2023/1099.pdf" },
          ytd: figures({ ordinaryDividends: 100_000, shortTermGain: 50_000 }),
          fromStatements: figures({ ordinaryDividends: 102_000, shortTermGain: 48_500 }),
          januaryDividends: jan,
        },
      ],
    }) as unknown as TaxReport;
  const tie = (r: TaxReport, f: ReturnType<typeof form>) => documentTies(r, { ...docs({} as FiledReturn), federal: null, brokerage: [f] } as unknown as YearDocs);
  const jan20 = [{ date: "2023-01-17", amount: 2_000 }];

  it("explains a January dividend the 1099 leaves to the prior year and the fees the statements net into gains", () => {
    const ties = tie(report(jan20), form({ fees: -1_500, payments: [{ date: "2023-02-13", amount: 700 }] }));
    expect(ties.map((t) => [t.label.split(" · ")[1], t.status])).toEqual([["ordinary dividends", "MATCH"], ["qualified dividends", "MATCH"], ["interest", "MATCH"], ["realized gains", "MATCH"]]);
    expect(ties[0]!.note).toContain("$20.00");
    expect(ties[3]!.note).toContain("$15.00");
  });

  it("still flags a January dividend that the 1099 prints, and gaps the fees don't explain", () => {
    const ties = tie(report(jan20), form({ fees: -400, payments: [{ date: "2023-01-17", amount: 2_000 }] }));
    expect(ties.find((t) => /ordinary/.test(t.label))!.status).toBe("DIFFERENT");
    expect(ties.find((t) => /realized/.test(t.label))!.status).toBe("DIFFERENT");
  });

  it("does not guess when the 1099 lists no dated payments", () => {
    expect(tie(report(jan20), form({ payments: [] })).find((t) => /ordinary/.test(t.label))!.status).toBe("DIFFERENT");
  });
});
