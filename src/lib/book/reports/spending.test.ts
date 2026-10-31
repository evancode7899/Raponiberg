import { describe, expect, it } from "vitest";
import type { BookRow } from "../load.ts";
import { NO_HOUSEHOLD } from "../../household/patterns.ts";
import { expenseFingerprint } from "../../profile/annualMath.ts";
import type { Book } from "../load.ts";
import { asCashFlowRow, TAX_REFUND_CATEGORY } from "./cashFlow.ts";
import { CHARGE_BUCKETS, detectRecurring, merchantName, oneOffRules, reversals, spendingKindRule, spendingShape } from "./spending.ts";

let n = 0;
const row = (date: string, cents: number, key: string, extra: Partial<BookRow> = {}): BookRow => ({
  id: `r${++n}`,
  date,
  precision: "EXACT",
  statement: { start: date, end: date },
  bookedOn: date,
  amountCents: cents,
  lane: "EXPENSE",
  accountId: "card",
  payee: key,
  merchantKey: key,
  category: "Travel & entertainment",
  categoryGroup: "Lifestyle",
  counterpartyKind: null,
  counterpartyInstitution: null,
  counterpartyAccountHint: null,
  classifiedBy: null,
  transferMatchId: null,
  statementImportId: "st",
  documentId: "doc",
  ...extra,
});
const monthly = (key: string, cents: number[], from = 1) => cents.map((c, i) => row(`2026-${String(from + i).padStart(2, "0")}-11`, -c, key));

describe("merchantName", () => {
  it("drops web noise and title-cases", () => {
    expect(merchantName("WWW SWEETGREEN COM")).toBe("Sweetgreen");
    expect(merchantName("TMOBILE AUTO PAY")).toBe("Tmobile Auto Pay");
  });
});

describe("detectRecurring", () => {
  it("finds a fixed monthly subscription and its price change", () => {
    const [c] = detectRecurring(monthly("SPOTIFY", [1199, 1199, 1199, 1199, 1299]), "2026-06-30", "2025-07-01");
    expect(c).toMatchObject({ kind: "bill", cadence: "monthly", typicalCents: 1199, annualCents: 1199 * 12, active: true, changeCents: 100 });
  });

  it("never flags a utility whose bill varies every month", () => {
    const [c] = detectRecurring(monthly("EVERSOURCE", [13000, 14200, 12200, 13700, 15600]), "2026-06-30", "2025-07-01");
    expect(c).toMatchObject({ kind: "bill", changeCents: null });
  });

  it("marks a bill stopped once its next charge is overdue", () => {
    const [c] = detectRecurring(monthly("HULU", [1999, 1999, 1999]), "2026-06-30", "2025-07-01");
    expect(c!.active).toBe(false);
  });

  it("treats frequent varying visits as a habit, not a bill", () => {
    const rows = ["01", "03", "08", "15", "22", "29"].flatMap((d, i) => [row(`2026-0${(i % 3) + 1}-${d}`, -(1200 + i * 300), "SWEETGREEN")]);
    const [c] = detectRecurring(rows, "2026-03-31", "2025-04-01");
    expect(c).toMatchObject({ kind: "habit", cadence: null, count: 6 });
  });
});

describe("reversals", () => {
  it("pairs a charge with its exact credit on the same account within a week", () => {
    const charge = row("2026-05-29", -450001, "BPS BILT HOUSING");
    const credit = row("2026-05-30", 450001, "BILT RENT CHARGE ADJUSTMENT");
    const bank = row("2026-06-01", -450001, "BILT CARD HOUSING", { accountId: "checking" });
    expect(reversals([charge, credit, bank])).toEqual(new Set([charge.id, credit.id]));
  });
});

describe("spendingShape", () => {
  const period = { start: "2026-04-01", end: "2026-04-30" };
  const rows = [
    row("2026-04-01", -200000, "LANDLORD"),
    row("2026-04-03", -1250, "COFFEE"),
    row("2026-04-03", -4800, "GROCER"),
    row("2026-04-18", -310000, "FURNITURE"),
    row("2026-04-20", 1250, "COFFEE"),
    row("2026-04-22", -9900, "GIFT", { category: "Shopping & gifts" }),
    row("2026-04-22", 50000, "PAYCHECK", { lane: "INCOME" }),
  ];
  const spending = 200000 + 1250 + 4800 + 310000 - 1250 + 9900;
  // As oneOffRules' candidate test: tagged (the gift), or a charge of $1,500 or more that isn't a bill.
  const shape = spendingShape(rows, { ...period, spendingCents: spending }, (r) => (r.payee === "LANDLORD" ? "bill" : r.payee === "GIFT" || -r.amountCents >= 150_000 ? "big" : "everyday"));

  it("splits spending into bills, big one-offs and everyday that add up to the total", () => {
    expect(shape.kinds).toEqual({ billCents: 200000, bigCents: 310000 + 9900, everydayCents: 1250 + 4800 - 1250 });
    expect(shape.kinds.billCents + shape.kinds.bigCents + shape.kinds.everydayCents).toBe(spending);
  });

  it("buckets spending by day of the month, refunds netted", () => {
    expect(shape.daily.allCents).toHaveLength(30);
    expect(shape.daily.billCents[0]).toBe(200000);
    expect(shape.daily.everydayCents[2]).toBe(1250 + 4800);
    expect(shape.daily.everydayCents[19]).toBe(-1250);
    expect(shape.daily.allCents.reduce((s, v) => s + v, 0)).toBe(spending);
  });

  it("counts charges by size and leaves refunds and income out", () => {
    const at = (cents: number) => shape.chargeSizes[CHARGE_BUCKETS.findIndex((hi) => cents < hi)]!;
    expect(at(1250)).toEqual({ count: 1, cents: 1250 });
    expect(at(310000).count).toBe(2);
    expect(shape.chargeSizes.reduce((s, b) => s + b.count, 0)).toBe(5);
  });
});

describe("oneOffRules: the one test Annual and Cash flow both use", () => {
  // An old premium billed every month in 2024 (none in the last year), a big one-off, a small tagged one, a refund.
  const premium = [3, 4, 5, 6].map((m) => row(`2024-0${m}-05`, -180000, "EXAMPLE INSURANCE"));
  const sofa = row("2026-03-14", -250000, "FURNITURE BARN");
  const gift = row("2026-03-20", -9900, "GIFT SHOP");
  const refund = row("2026-03-25", 250000, "FURNITURE BARN", { reimbursement: { source: "row" } as BookRow["reimbursement"] });
  const rows = [...premium, sofa, gift, refund];
  const book = { rows, rowById: new Map(rows.map((r) => [r.id, r])), household: NO_HOUSEHOLD } as unknown as Book;
  const settings = { oneOffs: { [expenseFingerprint(gift)]: "Birthday" }, nonRecurringCategories: [] };
  const { tagged, candidate } = oneOffRules(book, settings);

  it("offers a big single charge and anything tagged, never a bill (judged over all history) or a reimbursement credit", () => {
    expect(candidate(sofa)).toBe(true);
    expect(candidate(gift) && tagged(gift)).toBe(true);
    expect(tagged(sofa)).toBe(false);
    expect(premium.some(candidate)).toBe(false);
    expect(candidate(refund)).toBe(false);
  });
});

describe("spendingKindRule: credits count in the band of what they pay back", () => {
  const sofa = row("2026-03-14", -250000, "FURNITURE BARN");
  const sofaReturn = row("2026-04-02", 250000, "FURNITURE BARN");
  const relocation = row("2026-04-10", -320000, "EXAMPLE MOVERS");
  const payback = row("2026-04-28", 320000, "EXAMPLE MOVERS", { reimbursement: { linkId: "l1", side: "credit", source: "stub", expenseId: "" } });
  const taxPaid = row("2026-01-15", -90000, "IRS USATAXPYMT", { category: "Taxes & fees", accountId: "checking" });
  const taxRefund = row("2026-04-20", 1177500, "IRS TREAS 310 TAX REF", { category: "Taxes & fees", accountId: "checking" });
  const coffee = row("2026-04-03", -650, "COFFEE");
  const coffeeRefund = row("2026-04-04", 650, "COFFEE");
  const streaming = monthly("STREAMFLIX", [1599, 1599, 1599]);
  const streamingCredit = row("2026-04-12", 1599, "STREAMFLIX");
  payback.reimbursement!.expenseId = relocation.id;
  const rows = [sofa, sofaReturn, relocation, payback, taxPaid, taxRefund, coffee, coffeeRefund, ...streaming, streamingCredit];
  const book = { rows, rowById: new Map(rows.map((r) => [r.id, r])), accounts: [], household: NO_HOUSEHOLD } as unknown as Book;
  const kindOf = spendingKindRule(book, { oneOffs: {}, nonRecurringCategories: [] }, [{ key: "STREAMFLIX", kind: "bill" }]);

  it("puts a big refund and a reimbursed big charge's payback with big spending, not everyday", () => {
    expect([sofa, sofaReturn, relocation, payback].map(kindOf)).toEqual(["big", "big", "big", "big"]);
  });

  it("never counts a tax payment as everyday, whatever its size", () => {
    expect(kindOf(taxPaid)).toBe("big");
  });

  it("keeps small refunds with their everyday charges and a bill's credit with bills", () => {
    expect([coffee, coffeeRefund].map(kindOf)).toEqual(["everyday", "everyday"]);
    expect(kindOf(streamingCredit)).toBe("bill");
  });

  it("so a month with a big refund keeps everyday at its day-to-day level", () => {
    const april = [sofaReturn, relocation, payback, taxRefund, coffee].map(asCashFlowRow);
    const spendingCents = -april.filter((r) => r.lane === "EXPENSE").reduce((t, r) => t + r.amountCents, 0);
    const { kinds } = spendingShape(april, { start: "2026-04-01", end: "2026-04-30", spendingCents }, kindOf);
    expect(kinds.everydayCents).toBe(650);
    expect(kinds.bigCents).toBe(spendingCents - 650);
  });
});

describe("asCashFlowRow: a tax refund is income, never less spending", () => {
  const taxPaid = row("2026-01-15", -90000, "IRS USATAXPYMT", { category: "Taxes & fees", accountId: "checking" });
  const taxRefund = row("2026-04-20", 1177500, "IRS TREAS 310 TAX REF", { category: "Taxes & fees", accountId: "checking" });
  const sofaReturn = row("2026-04-02", 250000, "FURNITURE BARN");

  it("moves a tax authority's credit to income, keeping the row's id and amount", () => {
    const r = asCashFlowRow(taxRefund);
    expect(r).toMatchObject({ id: taxRefund.id, lane: "INCOME", category: TAX_REFUND_CATEGORY, amountCents: 1177500 });
  });

  it("leaves tax payments and merchant refunds as spending", () => {
    expect(asCashFlowRow(taxPaid)).toBe(taxPaid);
    expect(asCashFlowRow(sofaReturn)).toBe(sofaReturn);
  });

  it("so a refund month's spending is gross of it and net saved doesn't move", () => {
    const rows = [taxPaid, taxRefund, sofaReturn, row("2026-04-05", -40000, "GROCER")];
    const sum = (rs: BookRow[], lane: string) => rs.filter((r) => r.lane === lane).reduce((t, r) => t + r.amountCents, 0);
    const before = { income: sum(rows, "INCOME"), spending: -sum(rows, "EXPENSE") };
    const after = { income: sum(rows.map(asCashFlowRow), "INCOME"), spending: -sum(rows.map(asCashFlowRow), "EXPENSE") };
    expect(after.spending).toBe(before.spending + 1177500);
    expect(after.income - after.spending).toBe(before.income - before.spending);
  });
});
