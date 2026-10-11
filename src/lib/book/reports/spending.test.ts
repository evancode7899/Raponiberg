import { describe, expect, it } from "vitest";
import type { BookRow } from "../load.ts";
import { CHARGE_BUCKETS, detectRecurring, merchantName, reversals, spendingShape } from "./spending.ts";

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
  const shape = spendingShape(rows, { ...period, spendingCents: spending }, new Set(["LANDLORD"]), (r) => r.payee === "GIFT");

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
