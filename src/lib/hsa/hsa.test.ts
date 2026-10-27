import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { guessKind, qualifyPayee } from "./qualify.ts";
import { receiptFacts } from "./receipts.ts";
import { buildHsaReport, exactSubset, hsaFunding, payrollTaxSaved, withdrawalKind, type LedgerRowIn, type ReportInput } from "./report.ts";
import { applyHsaOp, EMPTY_SETTINGS, readHsaFile, type HsaExpense, type HsaFile } from "./store.ts";

describe("what counts as a qualified expense", () => {
  it("separates care from the medical-adjacent", () => {
    expect(qualifyPayee("SMILE BRIGHT DENTAL NEW YORK NY")).toMatchObject({ tier: "LIKELY", kind: "DENTAL" });
    expect(qualifyPayee("CVS/PHARMACY #01234")).toMatchObject({ tier: "CHECK", kind: "PHARMACY" });
    expect(qualifyPayee("LAKESIDE OPHTHALMOLOGY")).toMatchObject({ tier: "LIKELY", kind: "VISION" });
    expect(qualifyPayee("LABCORP")).toMatchObject({ tier: "LIKELY" });
    expect(qualifyPayee("EQUINOX FITNESS")).toBeNull();
    expect(qualifyPayee("AETNA PREMIUM")).toBeNull();
    expect(qualifyPayee("BANFIELD PET HOSPITAL")).toBeNull();
    expect(qualifyPayee("HILTON HOSPITALITY")).toBeNull();
    expect(qualifyPayee("SHELL 12 OAK DRIVE")).toBeNull();
    expect(qualifyPayee("MORGAN T")).toBeNull();
    expect(qualifyPayee("MORGAN T", null, { category: "Health & insurance", byOwner: true })).toMatchObject({ tier: "CHECK" });
    expect(qualifyPayee("MORGAN T", null, { category: "Health & insurance", byOwner: false })).toBeNull();
  });

  it("isn't fooled by state abbreviations, store numbers or shop names", () => {
    // "MD" as Maryland, "PT" as Point, "DR" as a shop's name, "LABS" as a brand, "DME" inside a word.
    expect(qualifyPayee("HOMEWARES.COM BALTIMORE MD")).toBeNull();
    expect(qualifyPayee("ARCADE GAMES 12345 OCEAN CITY MD")).toBeNull();
    expect(qualifyPayee("SEASIDE TACKLE 0000 PT PLEASANT NJ")).toBeNull();
    expect(qualifyPayee("DR. FROSTY'S ICE CREAM SHOP")).toBeNull();
    expect(qualifyPayee("NORTHWIND LABS PROTEIN")).toBeNull();
    expect(qualifyPayee("GOFNDME* HELP THE TEAM")).toBeNull();
    expect(qualifyPayee("GASTROPUB ON MAIN")).toBeNull();
    // …while the real things still match.
    expect(qualifyPayee("PT *HARBOR REHAB 000123 NEW YORK NY")).toMatchObject({ kind: "THERAPY", tier: "LIKELY" });
    expect(qualifyPayee("ALEX QUILL MD PC 0001 NEW YORK")).toMatchObject({ kind: "MEDICAL", tier: "LIKELY" });
    expect(qualifyPayee("RIVERSIDE GASTROENTEROLOGY")).toMatchObject({ kind: "MEDICAL" });
    expect(qualifyPayee("ACME DIAGNOSTICS")).toMatchObject({ kind: "MEDICAL" });
  });

  it("weighs the category the ledger filed the charge under", () => {
    // Filed somewhere plainly not medical by the classifier: a medical name is only worth a check.
    expect(qualifyPayee("GARAGE 9 GENERAL HOSPITAL WAY", null, { category: "Transportation", byOwner: false })).toMatchObject({ tier: "CHECK", kind: "HOSPITAL" });
    // Filed there by the owner: never medical.
    expect(qualifyPayee("CORNER CLINIC CAFE", null, { category: "Dining", byOwner: true })).toBeNull();
    // Neutral categories leave the name to decide.
    expect(qualifyPayee("LAKESIDE OPHTHALMOLOGY", null, { category: "Other", byOwner: false })).toMatchObject({ tier: "LIKELY" });
  });

  it("guesses the kind from a note", () => {
    expect(guessKind("PT session and knee x-rays")).toBe("HOSPITAL");
    expect(guessKind("Epi pen CVS")).toBe("PHARMACY");
    expect(guessKind("Eye doc")).toBe("VISION");
    expect(guessKind("Dr. Morgan")).toBe("MEDICAL");
  });
});

// ---------------------------------------------------------------------------- report

const CARD = { id: "card", name: "Amex Gold", institution: "Amex", group: "Credit cards", identifiers: ["1001"] };
const HSA = { id: "hsa", name: "HealthEquity HSA", institution: "HealthEquity", group: "Health savings", identifiers: ["555"] };
let n = 0;
const row = (date: string, amountCents: number, payee: string, accountId = "card", extra: Partial<LedgerRowIn> = {}): LedgerRowIn => ({
  id: `r${++n}`,
  date,
  amountCents,
  lane: "EXPENSE",
  accountId,
  payee,
  merchantKey: payee,
  category: "Health & insurance",
  classifiedBy: "merchant-keyword",
  ...extra,
});
const expense = (id: string, date: string, amountCents: number, extra: Partial<HsaExpense> = {}): HsaExpense => ({
  id,
  date,
  amountCents,
  provider: id,
  patient: "",
  kind: "MEDICAL",
  notes: "",
  receipt: true,
  receiptRef: "",
  source: "IMPORT",
  paidWith: null,
  reimbursement: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...extra,
});
const file = (expenses: HsaExpense[], patch: Partial<HsaFile> = {}): HsaFile => ({
  version: 1,
  expenses,
  dismissed: [],
  ignoredMerchants: [],
  settings: { ...EMPTY_SETTINGS, growthRate: 0.07, marginalRate: 0.35, planYear: 2046 },
  ...patch,
});
const input = (f: HsaFile, rows: LedgerRowIn[], extra: Partial<ReportInput> = {}): ReportInput => ({
  today: "2026-10-10",
  file: f,
  rows,
  accounts: [CARD, HSA],
  hsaAccounts: [{ name: "HealthEquity HSA", balanceCents: 2_000_000, asOf: "2026-09-30", annualizedReturn: 0.09 }],
  persons: ["Pat Doe"],
  marginalRate: null,
  ...extra,
});

describe("the HSA report", () => {
  it("ties logged expenses to the charge that paid them and suggests only the rest", () => {
    const rows = [
      row("2026-02-12", -412_500, "HARTLEY MD PC"), // the logged surgery, charged 2 days later
      row("2026-04-02", -71_500, "LAKESIDE OPHTHALMOLOGY"), // not logged: suggested
      row("2026-05-01", -2_500, "CVS/PHARMACY"), // drug store: check
      row("2026-06-01", -9_900, "EQUINOX"), // gym: never
      row("2026-07-01", -15_000, "CITYMD URGENT CARE"), // refunded below
      row("2026-07-20", 15_000, "CITYMD URGENT CARE"),
      row("2026-08-01", -50_000, "HEALTHEQUITY CARD SPEND", "hsa"), // paid from the HSA
    ];
    const r = buildHsaReport(input(file([expense("surgery", "2026-02-10", 412_500)]), rows));
    const surgery = r.expenses.find((e) => e.id === "surgery")!;
    expect(surgery.paid?.payee).toBe("HARTLEY MD PC");
    expect(surgery.paidAuto).toBe(true);
    expect(r.suggestions.map((s) => [s.payee, s.tier])).toEqual([
      ["LAKESIDE OPHTHALMOLOGY", "LIKELY"],
      ["CVS/PHARMACY", "CHECK"],
    ]);
  });

  it("doesn't guess between two equally close charges, but offers them to pick", () => {
    const rows = [row("2026-03-08", -4_000, "SMITH FAMILY MEDICINE"), row("2026-03-12", -4_000, "SMITH FAMILY MEDICINE")];
    const r = buildHsaReport(input(file([expense("visit", "2026-03-10", 4_000)]), rows));
    const v = r.expenses[0]!;
    expect(v.paid).toBeNull();
    expect(v.candidates).toHaveLength(2);
    // …and neither is suggested as a new expense either.
    expect(r.suggestions).toEqual([]);
  });

  it("leaves out dismissed charges, ignored merchants and anything before the HSA opened", () => {
    const rows = [row("2026-02-01", -10_000, "ONE MEDICAL GROUP"), row("2026-02-02", -20_000, "TWO DENTAL"), row("2024-12-01", -30_000, "THREE DENTAL")];
    const dismissed = [{ institution: "Amex", identifiers: ["1001"], date: "2026-02-01", amountCents: -10_000, payee: "ONE MEDICAL GROUP" }];
    const r = buildHsaReport(
      input(file([expense("old", "2024-11-01", 5_000)], { dismissed, ignoredMerchants: ["TWO DENTAL"], settings: { ...EMPTY_SETTINGS, openedOn: "2025-01-01" } }), rows),
    );
    expect(r.suggestions).toEqual([]);
    expect(r.expenses[0]!.flags).toContain("BEFORE_OPEN");
    expect(r.totals.unreimbursedCents).toBe(0);
    // Unset rates come from the HSA's measured return and the default bracket.
    expect(r.growth).toMatchObject({ rate: 0.09, rateSource: "MEASURED", marginalRate: 0.32, marginalSource: "DEFAULT", planYear: 2046 });
  });

  it("counts a receipt found in the receipts folder as saved, and lists the folder's unmatched files", () => {
    const f = file([
      expense("found", "2026-03-02", 8_412, { receipt: false }),
      expense("photo", "2026-05-01", 1_999, { receipt: false }),
      expense("none", "2026-06-01", 5_000, { receipt: false }),
    ]);
    const receipts = {
      dir: "R",
      files: [
        receiptFacts("2026.2.20.pdf", "Statement\n2/14/26 Office visit $84.12"),
        receiptFacts("2026.5.1.jpeg", null),
        receiptFacts("2026.9.9.pdf", "9/1/26 Lab $12.34"),
      ],
    };
    const r = buildHsaReport(input(f, [], { receipts }));
    const by = (id: string) => r.expenses.find((e) => e.id === id)!;
    expect(by("found")).toMatchObject({ hasReceipt: true, receiptFiles: [{ file: "2026.2.20.pdf", how: "AMOUNT", date: "2026-02-14" }] });
    expect(by("found").flags).not.toContain("NO_RECEIPT");
    // A photo only suggests the receipt: it isn't counted until it's tied.
    expect(by("photo")).toMatchObject({ hasReceipt: false, receiptFiles: [{ how: "DATE" }] });
    expect(r.totals).toMatchObject({ readyCents: 8_412, missingReceiptCount: 2 });
    expect(r.receiptsFolder).toEqual({ dir: "R", fileCount: 3, unmatched: [{ file: "2026.9.9.pdf", date: "2026-09-09" }] });
    // Tied by the owner: on file.
    const tied = buildHsaReport(input(file([expense("photo", "2026-05-01", 1_999, { receipt: true, receiptRef: "2026.5.1.jpeg" })]), [], { receipts }));
    expect(tied.expenses[0]).toMatchObject({ hasReceipt: true, receiptFiles: [{ how: "LINKED" }] });
    expect(buildHsaReport(input(f, [])).receiptsFolder).toBeNull();
  });

  it("totals what's reimbursable, flags duplicates and missing receipts, and estimates growth from waiting", () => {
    const f = file([
      expense("a", "2025-10-10", 100_000),
      expense("b", "2026-02-10", 412_500, { receipt: false }),
      expense("c", "2026-02-10", 412_500),
      expense("d", "2025-09-01", 21_475, { reimbursement: { date: "2026-03-01", withdrawal: null, note: "" } }),
    ]);
    const r = buildHsaReport(input(f, []));
    expect(r.totals).toMatchObject({ count: 4, unreimbursedCents: 925_000, unreimbursedCount: 3, reimbursedCents: 21_475, readyCents: 512_500, missingReceiptCount: 1, oldestUnreimbursed: "2025-10-10" });
    expect(r.expenses.filter((e) => e.flags.includes("DUPLICATE")).map((e) => e.id).sort()).toEqual(["b", "c"]);
    // $1,000 waiting a year (365 of 365.25 days) at 7%.
    expect(r.expenses.find((e) => e.id === "a")!.growthCents).toBe(6_995);
    expect(r.years.find((y) => y.year === 2026)).toMatchObject({ count: 2, reimbursedInYearCents: 21_475 });
    // Defaults fill the rest: 1.5% dividends, 20% on taxable gains, 1.45% payroll tax, growth covered by bills.
    expect(r.growth.assumptions).toMatchObject({ rate: 0.07, dividendYield: 0.015, taxableRate: 0.2, marginalRate: 0.35, payrollRate: 0.0145, growthCovered: true, exitRate: 0.35, years: 20 });
    // The HSA is maxed either way; waiting beats paying now by exactly the HSA-vs-taxable gap on the $1,000.
    const [now, later] = r.growth.strategy;
    expect(now!.aheadCents).toBe(0);
    const perDollarEdge = (r.growth.futureValueCents - r.growth.taxableValueCents) / r.totals.unreimbursedCents;
    expect(later!.aheadCents).toBeCloseTo(100_000 * perDollarEdge, -1);
    expect(r.growth.futureValueCents).toBeGreaterThan(r.growth.taxableValueCents);
  });

  it("offers the receipts a distribution could have paid back, never for an HSA card payment", () => {
    const f = file([expense("x", "2026-01-01", 13_140), expense("y", "2026-02-01", 21_475), expense("z", "2026-03-01", 4_000), expense("late", "2026-09-01", 34_615)]);
    const r = buildHsaReport(
      input(f, [
        row("2026-04-01", -34_615, "Online distribution", "hsa", { lane: "TRANSFER" }),
        // The HSA's own card paying a provider: same amount, but nothing came back to the owner.
        row("2026-05-01", -34_615, "Card: Lakeside Clinic, CT", "hsa"),
      ]),
    );
    const byKind = Object.fromEntries(r.withdrawals.map((w) => [w.kind, w]));
    expect(byKind.DISTRIBUTION!.exactMatch?.sort()).toEqual(["x", "y"]);
    expect(byKind.DIRECT!.exactMatch).toBeNull();
    expect(exactSubset([{ id: "a", amountCents: 3 }], 4)).toBeNull();
  });

  it("tells a distribution from the HSA paying a provider", () => {
    expect(withdrawalKind({ lane: "EXPENSE", payee: "Card: Lakeside Clinic, CT" })).toBe("DIRECT");
    expect(withdrawalKind({ lane: "TRANSFER", payee: "Card: Lakeside Clinic, CT" })).toBe("DIRECT");
    expect(withdrawalKind({ lane: "EXPENSE", payee: "Distribution to checking" })).toBe("DISTRIBUTION");
    expect(withdrawalKind({ lane: "EXTERNAL_TRANSFER", payee: "Online withdrawal" })).toBe("DISTRIBUTION");
    expect(withdrawalKind({ lane: "EXPENSE", payee: "Lakeside Ortho" })).toBe("DIRECT");
  });

  it("flags reimbursements tied to an HSA card payment", () => {
    const card = row("2026-05-01", -30_000, "Card: Lakeside Clinic, CT", "hsa");
    const fp = { institution: "HealthEquity", identifiers: ["555"], date: card.date, amountCents: card.amountCents, payee: card.payee };
    const f = file([
      expense("a", "2026-01-10", 10_000, { reimbursement: { date: "2026-05-01", withdrawal: fp, note: "" } }),
      expense("b", "2026-02-10", 20_000, { reimbursement: { date: "2026-05-01", withdrawal: null, note: "" } }),
    ]);
    const r = buildHsaReport(input(f, [card]));
    const a = r.expenses.find((e) => e.id === "a")!;
    expect(a.flags).toContain("BAD_TIE");
    expect(a.doubt).toMatch(/card payment/);
    expect(r.expenses.find((e) => e.id === "b")!.flags).not.toContain("BAD_TIE");
    expect(r.withdrawals[0]).toMatchObject({ kind: "DIRECT", linkedIds: ["a"] });
  });

  it("flags expenses added from charges that don't look medical, until the owner keeps them", () => {
    const grocer = row("2026-03-02", -6_400, "HARBOR FOODS 0001 SPRINGFIELD", "card", { category: "Groceries" });
    const clinic = row("2026-03-05", -9_000, "LAKESIDE CLINIC");
    const fpOf = (x: LedgerRowIn) => ({ institution: "Amex", identifiers: ["1001"], date: x.date, amountCents: x.amountCents, payee: x.payee });
    const f = file([
      expense("g", grocer.date, 6_400, { source: "LEDGER", paidWith: fpOf(grocer) }),
      expense("c", clinic.date, 9_000, { source: "LEDGER", paidWith: fpOf(clinic) }),
    ]);
    const r = buildHsaReport(input(f, [grocer, clinic]));
    expect(r.expenses.find((e) => e.id === "g")!.flags).toContain("NOT_MEDICAL");
    expect(r.expenses.find((e) => e.id === "c")!.flags).not.toContain("NOT_MEDICAL");
    // Left out of what's reimbursable.
    expect(r.totals.unreimbursedCents).toBe(9_000);
    const kept = buildHsaReport(input(file([{ ...f.expenses[0]!, kept: true }, f.expenses[1]!]), [grocer, clinic]));
    expect(kept.expenses.find((e) => e.id === "g")!.flags).not.toContain("NOT_MEDICAL");
    expect(kept.totals.unreimbursedCents).toBe(15_400);
  });
});

// ---------------------------------------------------------------------------- store

describe("the HSA log file", () => {
  let dir = "";
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const fresh = () => {
    dir = mkdtempSync(path.join(tmpdir(), "hsa-"));
    return path.join(dir, "hsa-expenses.json");
  };

  it("adds, reimburses and un-reimburses, journaling every change", () => {
    const f = fresh();
    applyHsaOp({ op: "add", expenses: [{ date: "2026-02-10", amountCents: 412_500, provider: "Surgery", kind: "HOSPITAL" }] }, f);
    const [e] = readHsaFile(f).expenses;
    expect(e).toMatchObject({ provider: "Surgery", kind: "HOSPITAL", source: "MANUAL", reimbursement: null, receipt: false });
    applyHsaOp({ op: "reimburse", ids: [e!.id], date: "2026-10-01", note: "cash for car" }, f);
    expect(readHsaFile(f).expenses[0]!.reimbursement).toEqual({ date: "2026-10-01", withdrawal: null, note: "cash for car", markedAt: expect.any(String) });
    expect(applyHsaOp({ op: "unreimburse", ids: [e!.id] }, f).changed).toBe(1);
    expect(readHsaFile(f).expenses[0]!.reimbursement).toBeNull();
    const journal = readFileSync(f.replace(/\.json$/, ".journal.jsonl"), "utf8").trim().split("\n");
    expect(journal.map((l) => (JSON.parse(l) as { op: string }).op)).toEqual(["add", "reimburse", "unreimburse"]);
  });

  it("refuses bad input and never treats a damaged file as empty", () => {
    const f = fresh();
    expect(() => applyHsaOp({ op: "add", expenses: [{ date: "2026-13-01", amountCents: 100, provider: "x" }] }, f)).toThrow(/date/);
    expect(() => applyHsaOp({ op: "add", expenses: [{ date: "2026-01-01", amountCents: -5, provider: "x" }] }, f)).toThrow(/amount/);
    expect(existsSync(f)).toBe(false);
    writeFileSync(f, "{not json");
    expect(() => readHsaFile(f)).toThrow(/damaged/);
  });

  it("removes an expense as not HSA, dismissing its charge, and keeps a flagged one", () => {
    const f = fresh();
    const fp = { institution: "Amex", identifiers: ["1001"], date: "2026-02-01", amountCents: -6_400, payee: "HARBOR FOODS" };
    applyHsaOp({ op: "add", expenses: [{ date: "2026-02-01", amountCents: 6_400, provider: "Harbor Foods", source: "LEDGER", paidWith: fp }, { date: "2026-02-02", amountCents: 100, provider: "Clinic" }] }, f);
    const [g, c] = readHsaFile(f).expenses;
    expect(applyHsaOp({ op: "keep", ids: [c!.id] }, f).changed).toBe(1);
    expect(applyHsaOp({ op: "keep", ids: [c!.id] }, f).changed).toBe(0);
    applyHsaOp({ op: "delete", ids: [g!.id], dismiss: true }, f);
    expect(readHsaFile(f)).toMatchObject({ expenses: [{ provider: "Clinic", kept: true }], dismissed: [fp] });
  });

  it("remembers dismissed charges and ignored merchants once each", () => {
    const f = fresh();
    const fp = { institution: "Amex", identifiers: ["1001"], date: "2026-02-01", amountCents: -10_000, payee: "DR ONE" };
    expect(applyHsaOp({ op: "dismiss", rows: [fp, fp] }, f).changed).toBe(1);
    expect(applyHsaOp({ op: "ignoreMerchant", merchant: "CVS" }, f).changed).toBe(1);
    expect(applyHsaOp({ op: "ignoreMerchant", merchant: "CVS" }, f).changed).toBe(0);
    expect(readHsaFile(f)).toMatchObject({ dismissed: [fp], ignoredMerchants: ["CVS"] });
    applyHsaOp({ op: "undismiss", rows: [fp] }, f);
    expect(readHsaFile(f).dismissed).toEqual([]);
  });
});

describe("who funded the HSA", () => {
  const hsaOnly = (id: string) => id === "hsa";
  const t = { lane: "TRANSFER" };

  it("reads the split off the HSA's statements, for the latest contribution year", () => {
    const rows = [
      // Last year's, with an employer catch-up lump (one deposited in January): left out.
      row("2025-11-01", 10_000, "Employee Contribution for 2025", "hsa", t),
      row("2025-12-01", 90_000, "Employer Contribution for 2025", "hsa", t),
      row("2026-01-09", 40_000, "Employer Contribution for 2025", "hsa", t),
      row("2026-01-15", 10_000, "Employee Contribution for 2026", "hsa", t),
      row("2026-01-15", 30_000, "Employer Contribution for 2026", "hsa", t),
      row("2026-05-01", 15_000, "Employee Contribution for 2026", "hsa", t),
      row("2026-05-01", 45_000, "Employer Contribution for 2026", "hsa", t),
      row("2026-07-01", 3_000, "Interest", "hsa", t), // not a contribution
      row("2026-07-01", 99_000, "Payroll deposit", "card", t), // not the HSA
    ];
    const f = hsaFunding(rows, hsaOnly, { year: 2026, employeeCents: 1, employerCents: 1, payrollRate: null });
    expect(f).toMatchObject({ source: "STATEMENTS", year: 2026, from: "2026-01-15", through: "2026-05-01", employeeCents: 25_000, employerCents: 75_000, employeeShare: 0.25 });
  });

  it("falls back to the pay stubs, then to all you", () => {
    expect(hsaFunding([], hsaOnly, { year: 2025, employeeCents: 30_000, employerCents: 70_000, payrollRate: null })).toMatchObject({ source: "PAY_STUBS", employeeShare: 0.3 });
    expect(hsaFunding([], hsaOnly, null)).toMatchObject({ source: "NONE", employeeShare: 1 });
  });

  it("reads the split, and leaves the strategy table alone: the HSA is maxed either way", () => {
    const rows = [row("2026-05-01", 20_000, "Employee Contribution", "hsa", t), row("2026-05-01", 80_000, "Employer Contribution", "hsa", t)];
    const r = buildHsaReport(input(file([]), rows));
    expect(r.growth.funding.employeeShare).toBe(0.2);
    expect(r.growth.strategy).toEqual(buildHsaReport(input(file([]), [])).growth.strategy);
  });
});

describe("payroll tax a payroll HSA dollar avoids", () => {
  const p = { wageBaseCents: 18_450_000, ssRate: 0.062, medicareRate: 0.0145, additionalMedicareRate: 0.009, surtaxThresholdCents: 25_000_000 };
  it("is Social Security and Medicare under the wage base", () => {
    expect(payrollTaxSaved({ ...p, personWagesCents: 9_000_000, householdWagesCents: 15_000_000 })).toBeCloseTo(0.0765, 6);
  });
  it("drops Social Security over the wage base (the cap is hit either way)", () => {
    expect(payrollTaxSaved({ ...p, personWagesCents: 20_000_000, householdWagesCents: 22_000_000 })).toBeCloseTo(0.0145, 6);
  });
  it("adds the Additional Medicare surtax when the household is over its threshold", () => {
    expect(payrollTaxSaved({ ...p, personWagesCents: 30_000_000, householdWagesCents: 38_000_000 })).toBeCloseTo(0.0235, 6);
  });
});

describe("the rates behind the strategy table", () => {
  const stubs = { year: 2026, employeeCents: 20_000, employerCents: 80_000, payrollRate: 0.0235, surtaxRate: 0.009 };
  const taxes = { year: 2026, incomeRate: 0.394, payrollRate: 0.0145, source: "TAX_REPORT" as const };
  const blank = () => file([], { settings: { ...EMPTY_SETTINGS, growthRate: 0.07, planYear: 2046 } });

  it("takes the Taxes page's income rate, and leaves its surtax out of payroll so it isn't counted twice", () => {
    const g = buildHsaReport(input(blank(), [], { payrollHsa: stubs, taxMarginal: taxes })).growth;
    expect(g).toMatchObject({ marginalSource: "TAX_REPORT", payrollSource: "PAY_STUBS" });
    expect(g.assumptions.marginalRate).toBe(0.394);
    expect(g.assumptions.payrollRate).toBeCloseTo(0.0145, 6);
  });

  it("keeps the surtax in payroll when the income rate is typed in", () => {
    const g = buildHsaReport(input(blank(), [], { payrollHsa: stubs, taxMarginal: taxes, marginalRate: 0.3 })).growth;
    expect(g).toMatchObject({ marginalSource: "RETIREMENT", payrollSource: "PAY_STUBS" });
    expect(g.assumptions.payrollRate).toBeCloseTo(0.0235, 6);
  });
});
