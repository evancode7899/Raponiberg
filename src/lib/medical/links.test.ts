import { describe, expect, it } from "vitest";
import { buildHsaReport } from "../hsa/report.ts";
import { EMPTY_SETTINGS, type HsaExpense, type HsaFile } from "../hsa/store.ts";
import { hsaPlanYear, linkExpenses, matchClaimPayments, premiumCoverage, premiumLines, sameProvider, type ClaimLite, type PaymentRowIn } from "./links.ts";
import type { HealthPlan } from "./plans.ts";
import { hsaEligibilityChecks, premiumChecks } from "./report.ts";

const claim = (id: string, o: Partial<ClaimLite> = {}): ClaimLite => ({
  id,
  coverage: "MEDICAL",
  patient: "Avery",
  provider: "LAKESIDE FAMILY MEDICINE PC",
  firstDate: "2025-03-03",
  lastDate: "2025-03-03",
  statementDate: "2025-03-20",
  file: `eob-${id}.pdf`,
  yourShareCents: 12_500,
  planCents: 30_000,
  ...o,
});
const row = (id: string, o: Partial<PaymentRowIn> = {}): PaymentRowIn => ({ id, date: "2025-04-02", amountCents: -12_500, payee: "LAKESIDE FAMILY MED ONLINE PMT", account: "Card ••0001", fromHsa: false, medical: false, ...o });

const plan = (o: Partial<HealthPlan> = {}): HealthPlan => ({
  id: "test-hdhp-2025",
  coverage: "MEDICAL",
  insurer: "Example Health",
  name: "Example HDHP",
  coverageFrom: "2025-01-01",
  coverageTo: "2025-12-31",
  accumulator: "CALENDAR_YEAR",
  hsaEligible: true,
  deductible: { inNetwork: { individualCents: 300_000, familyCents: 600_000 }, outOfNetwork: null },
  outOfPocket: { inNetwork: { individualCents: 600_000, familyCents: 1_200_000 }, outOfNetwork: null },
  services: [],
  limits: [],
  excluded: [],
  otherCovered: [],
  rules: [],
  sources: [],
  ...o,
});

describe("provider names", () => {
  it("match on a word that tells providers apart, never a generic one", () => {
    expect(sameProvider("LAKESIDE FAMILY MEDICINE PC", "LAKESIDE FAMILY MED ONLINE PMT")).toBe(true);
    expect(sameProvider("NORTH MEDICAL GROUP", "SOUTH MEDICAL GROUP")).toBe(false);
    expect(sameProvider("", "ANYTHING")).toBe(false);
  });
});

describe("matchClaimPayments", () => {
  it("ties a claim to the row of exactly what you owe that names the provider", () => {
    const { byClaim } = matchClaimPayments([claim("A")], [row("r1"), row("r2", { payee: "GROCERY MART", medical: false })]);
    expect(byClaim.get("A")).toMatchObject({ rowId: "r1", how: "NAME", fromHsa: false });
  });

  it("takes an unnamed row only when it's plainly medical and the only one of that amount", () => {
    const one = matchClaimPayments([claim("A")], [row("r1", { payee: "PAYMENTUS CORP", medical: true })]);
    expect(one.byClaim.get("A")?.how).toBe("MEDICAL");
    const two = matchClaimPayments([claim("A")], [row("r1", { payee: "PAYMENTUS CORP", medical: true }), row("r2", { payee: "INSTAMED", medical: true })]);
    expect(two.byClaim.has("A")).toBe(false);
  });

  it("ties an HSA card swipe as the HSA paying directly", () => {
    const { byClaim } = matchClaimPayments([claim("A")], [row("h1", { payee: "CARD PURCHASE", fromHsa: true })]);
    expect(byClaim.get("A")).toMatchObject({ rowId: "h1", fromHsa: true });
  });

  it("ignores rows outside the window, and claims you owe nothing on", () => {
    const { byClaim } = matchClaimPayments([claim("A"), claim("Z", { yourShareCents: 0 })], [row("early", { date: "2025-02-01" }), row("late", { date: "2026-02-01" })]);
    expect(byClaim.size).toBe(0);
  });

  it("ties one bill for several visits to the provider's claims that add up to it", () => {
    const cs = [claim("A", { yourShareCents: 4_000 }), claim("B", { yourShareCents: 6_500, firstDate: "2025-03-10", lastDate: "2025-03-10" }), claim("C", { yourShareCents: 9_900 })];
    const { byClaim } = matchClaimPayments(cs, [row("bill", { amountCents: -10_500 })]);
    expect(byClaim.get("A")?.rowId).toBe("bill");
    expect(byClaim.get("B")?.rowId).toBe("bill");
    expect(byClaim.get("A")?.how).toBe("GROUP");
    expect(byClaim.has("C")).toBe(false);
  });
});

describe("linkExpenses", () => {
  it("links by the claim's payment, by exact amount, or flags a visit logged above what was owed", () => {
    const cs = [claim("A"), claim("B", { patient: "Rowan", yourShareCents: 8_000, firstDate: "2025-05-05", lastDate: "2025-05-05", statementDate: "2025-05-20" }), claim("C", { patient: "Avery", provider: "HARBOR PHYSICAL THERAPY", yourShareCents: 20_000, firstDate: "2025-07-07", lastDate: "2025-07-07" })];
    const { payments } = matchClaimPayments(cs, [row("r1")]);
    const links = linkExpenses(
      [
        { id: "e1", date: "2025-04-02", amountCents: 12_500, patient: "", provider: "Lakeside", paidRowId: "r1" },
        { id: "e2", date: "2025-05-06", amountCents: 8_000, patient: "Rowan", provider: "Checkup", paidRowId: null },
        { id: "e3", date: "2025-07-07", amountCents: 35_000, patient: "Avery", provider: "Harbor physical therapy", paidRowId: null },
        { id: "e4", date: "2025-05-06", amountCents: 8_000, patient: "Avery", provider: "Other", paidRowId: null },
      ],
      cs,
      payments,
    );
    expect(links.get("e1")).toMatchObject({ claimIds: ["A"], how: "PAYMENT", over: false });
    expect(links.get("e2")).toMatchObject({ claimIds: ["B"], how: "AMOUNT", over: false });
    expect(links.get("e3")).toMatchObject({ claimIds: ["C"], how: "VISIT", over: true, owedCents: 20_000 });
    // A different patient's claim of the same amount, already taken, backs nothing.
    expect(links.has("e4")).toBe(false);
  });
});

describe("premiums", () => {
  it("reads which cover a pre-tax line pays for, leaving FSAs and commuter benefits out", () => {
    expect(premiumCoverage("Medical Pre-Tax")).toBe("MEDICAL");
    expect(premiumCoverage("DENTAL PRETAX")).toBe("DENTAL");
    expect(premiumCoverage("VSP VISION")).toBe("VISION");
    expect(premiumCoverage("HEALTH CARE FSA")).toBeNull();
    expect(premiumCoverage("COMMUTER TRANSIT")).toBeNull();
  });

  it("holds each premium to a plan on file, from the first plan of that cover on", () => {
    const stubs = ["2024-12-15", "2025-06-15", "2026-01-15"].map((payDate) => ({ payDate, personId: "p1", employer: "Example Co", documentTitle: `stub ${payDate}`, lines: [{ name: "Medical Pre-Tax", kind: "SECTION125", current: 9_000 }] }));
    const lines = premiumLines(stubs);
    expect(lines).toHaveLength(3);
    const [check] = premiumChecks(lines, [plan()], "2026-02-01");
    expect(check).toMatchObject({ id: "medical.premiums:MEDICAL", ok: false, date: "2026-01-15" });
    expect(premiumChecks(lines, [plan(), plan({ id: "test-hdhp-2026", coverageFrom: "2026-01-01", coverageTo: "2026-12-31" })], "2026-02-01")[0]!.ok).toBe(true);
  });
});

describe("HSA eligibility", () => {
  it("fails HSA money from pay while only a plan that isn't HSA-eligible is in force", () => {
    const pay = [{ payDate: "2025-03-15", employer: "Example Co", cents: 20_000 }, { payDate: "2024-06-15", employer: "Example Co", cents: 20_000 }];
    expect(hsaEligibilityChecks(pay, [plan()])[0]).toMatchObject({ ok: true });
    const bad = hsaEligibilityChecks(pay, [plan({ hsaEligible: false })])[0]!;
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain("2025-03-15");
    expect(bad.detail).not.toContain("2024-06-15");
  });

  it("reads the year's coverage, months and the last-month rule from the plans", () => {
    const fam = hsaPlanYear([plan({ covers: "Employee + Family" })], 2025, () => []);
    expect(fam).toMatchObject({ coverage: "FAMILY", eligibleMonths: 12, ineligibleMonths: 0, december: true });
    const halfYear = hsaPlanYear([plan({ covers: "Employee only", coverageTo: "2025-06-30" }), plan({ id: "ppo", hsaEligible: false, coverageFrom: "2025-07-01" })], 2025, () => []);
    expect(halfYear).toMatchObject({ coverage: "SELF", eligibleMonths: 6, ineligibleMonths: 6, december: false });
    expect(hsaPlanYear([plan()], 2025, () => ["Avery", "Rowan"])?.coverage).toBe("FAMILY");
    expect(hsaPlanYear([plan()], 2023, () => [])).toBeNull();
  });
});

describe("the HSA page and the EOBs", () => {
  const expense = (o: Partial<HsaExpense>): HsaExpense => ({
    id: "x",
    date: "2025-03-03",
    amountCents: 12_500,
    provider: "Lakeside",
    patient: "Avery",
    kind: "MEDICAL",
    notes: "",
    receipt: false,
    receiptRef: "",
    source: "MANUAL",
    paidWith: null,
    reimbursement: null,
    createdAt: "2025-03-04T00:00:00.000Z",
    updatedAt: "2025-03-04T00:00:00.000Z",
    ...o,
  });
  const file = (expenses: HsaExpense[]): HsaFile => ({ version: 1, expenses, dismissed: [], ignoredMerchants: [], settings: { ...EMPTY_SETTINGS } });
  const accounts = [
    { id: "card", name: "Card ••0001", institution: "EXAMPLE", group: "Credit cards", identifiers: ["0001"] },
    { id: "hsa", name: "HSA ••0002", institution: "EXAMPLE", group: "Health savings", identifiers: ["0002"] },
  ];
  const base = { today: "2025-12-31", accounts, hsaAccounts: [], persons: [], marginalRate: null };
  const ledgerRow = (id: string, accountId: string, payee: string, amountCents: number, date: string) => ({ id, date, amountCents, lane: "EXPENSE", accountId, payee, merchantKey: null, category: "Shopping", classifiedBy: null });

  it("counts an EOB that says you owed exactly the expense as its receipt, and flags one logged above it", () => {
    const cs = [claim("A"), claim("C", { provider: "HARBOR PHYSICAL THERAPY", yourShareCents: 20_000, firstDate: "2025-07-07", lastDate: "2025-07-07" })];
    const r = buildHsaReport({
      ...base,
      rows: [],
      file: file([expense({ id: "ok" }), expense({ id: "over", date: "2025-07-07", amountCents: 35_000, provider: "Harbor physical therapy" })]),
      eob: { claims: cs, payments: [] },
    });
    const ok = r.expenses.find((e) => e.id === "ok")!;
    expect(ok.hasReceipt).toBe(true);
    expect(ok.flags).not.toContain("NO_RECEIPT");
    const over = r.expenses.find((e) => e.id === "over")!;
    expect(over.flags).toContain("OVER_EOB");
    expect(over.hasReceipt).toBe(false);
    expect(over.doubt).toContain("you owed $200.00");
  });

  it("suggests a charge that paid an EOB's claim even when its name doesn't look medical, with the EOB's patient", () => {
    const rows = [ledgerRow("r1", "card", "LAKESIDE ONLINE PMT", -12_500, "2025-04-02")];
    const { payments } = matchClaimPayments([claim("A")], [row("r1", { payee: "LAKESIDE ONLINE PMT" })]);
    const r = buildHsaReport({ ...base, rows, file: file([]), eob: { claims: [claim("A")], payments } });
    expect(r.suggestions).toEqual([expect.objectContaining({ rowId: "r1", tier: "LIKELY", patient: "Avery", provider: "LAKESIDE FAMILY MEDICINE PC" })]);
  });

  it("says which claims an HSA card swipe paid", () => {
    const rows = [ledgerRow("h1", "hsa", "CARD PURCHASE LAKESIDE", -12_500, "2025-03-25")];
    const { payments } = matchClaimPayments([claim("A")], [row("h1", { payee: "CARD PURCHASE LAKESIDE", fromHsa: true })]);
    const r = buildHsaReport({ ...base, rows, file: file([]), eob: { claims: [claim("A")], payments } });
    expect(r.withdrawals[0]).toMatchObject({ kind: "DIRECT", claims: [expect.objectContaining({ id: "A" })] });
  });
});
