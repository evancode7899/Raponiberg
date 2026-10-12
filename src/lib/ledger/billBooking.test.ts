import { describe, expect, it } from "vitest";
import { bookBill, type BillStatement } from "./billBooking";
import { buildTimeline, decompose, valueAt } from "./timeline";

// A landlord bill cut on the 20th that already lists next month's rent (dated the 1st);
// each later bill opens at the previous closing and says what was paid in between.
const RENT = -200000;
const bills: BillStatement[] = [
  {
    periodStart: "2024-02-20",
    periodEnd: "2024-02-20",
    openingCents: 0,
    closingCents: RENT,
    rows: [{ id: "mar", date: "2024-03-01", precision: "EXACT", amountCents: RENT, lane: "EXPENSE" }],
  },
  {
    periodStart: "2024-02-21",
    periodEnd: "2024-03-20",
    openingCents: RENT,
    closingCents: RENT,
    rows: [
      { id: "paid-mar", date: "2024-03-20", precision: "PERIOD", amountCents: -RENT, lane: "TRANSFER" },
      { id: "apr", date: "2024-04-01", precision: "EXACT", amountCents: RENT, lane: "EXPENSE" },
    ],
  },
  {
    periodStart: "2024-03-21",
    periodEnd: "2024-04-20",
    openingCents: RENT,
    closingCents: RENT - 5000,
    rows: [
      { id: "paid-apr", date: "2024-04-20", precision: "PERIOD", amountCents: -RENT, lane: "TRANSFER" },
      { id: "may", date: "2024-05-01", precision: "EXACT", amountCents: RENT, lane: "EXPENSE" },
      { id: "fee", date: "2024-05-01", precision: "EXACT", amountCents: -5000, lane: "EXPENSE" },
    ],
  },
];
// March paid on time (Mar 2); April paid early (Mar 29), in two payments.
const paidBy = new Map([
  ["paid-mar", [{ date: "2024-03-02", amountCents: RENT }]],
  ["paid-apr", [{ date: "2024-03-29", amountCents: RENT / 2 }, { date: "2024-04-03", amountCents: RENT / 2 }]],
]);

describe("bookBill", () => {
  const booked = bookBill("bill", bills, paidBy, new Map());
  const t = buildTimeline("bill", booked.segments);

  it("books charges on the 1st they cover and payments on the bank's days, exact every day", () => {
    expect(valueAt(t, "2024-02-29")).toEqual({ cents: 0, quality: "EXACT", asOf: "2024-02-29" });
    expect(valueAt(t, "2024-03-01").cents).toBe(RENT); // March rent owed
    expect(valueAt(t, "2024-03-02").cents).toBe(0); // paid
    // April's first half paid Mar 29: paid ahead until April's rent posts.
    expect(valueAt(t, "2024-03-31")).toEqual({ cents: -RENT / 2, quality: "EXACT", asOf: "2024-03-31" });
    expect(valueAt(t, "2024-04-02").cents).toBe(RENT / 2);
    expect(valueAt(t, "2024-04-20")).toEqual({ cents: 0, quality: "EXACT", asOf: "2024-04-20" });
  });

  it("keeps charges dated after the last bill out of the ledger until a bill covers them", () => {
    expect(booked.rows.get("may")).toEqual({ pending: true });
    expect(booked.rows.get("fee")).toEqual({ pending: true });
    expect(t.lastDay).toBe("2024-04-20");
  });

  it("puts each month's rent in that month and nothing else", () => {
    const march = decompose(t, "2024-03-01", "2024-03-31");
    expect(march.flowsByLane.EXPENSE).toBe(RENT);
    expect(march.flowsByLane.TRANSFER).toBe(-RENT * 1.5);
    expect(march.unexplainedCents).toBe(0);
    const april = decompose(t, "2024-04-01", "2024-04-30");
    expect(april.flowsByLane.EXPENSE).toBe(RENT);
    expect(april.quality).not.toBe("ESTIMATED");
  });

  it("ties every bill and splits a payment made in pieces", () => {
    for (const s of booked.segments) {
      expect(s.openingCents + s.flows.reduce((a, f) => a + f.amountCents, 0)).toBe(s.closingCents);
    }
    for (let i = 1; i < booked.segments.length; i++) expect(booked.segments[i]!.openingCents).toBe(booked.segments[i - 1]!.closingCents);
    expect(booked.rows.get("paid-apr")).toEqual({
      pending: false,
      parts: [
        { date: "2024-03-29", amountCents: -RENT / 2, lane: "TRANSFER" },
        { date: "2024-04-03", amountCents: -RENT / 2, lane: "TRANSFER" },
      ],
    });
  });

  it("books a confirmed difference as spending on the bill's day, and an unpaired payment there too", () => {
    const b = bookBill("bill", bills, new Map([["paid-mar", [{ date: "2024-03-02", amountCents: RENT + 3000 }]]]), new Map([["paid-mar", 3000]]));
    expect(b.rows.get("paid-mar")).toEqual({
      pending: false,
      parts: [{ date: "2024-03-02", amountCents: -RENT - 3000, lane: "TRANSFER" }],
      correction: { date: "2024-03-20", amountCents: 3000, lane: "EXPENSE" },
    });
    expect(b.rows.get("paid-apr")).toEqual({ pending: false, parts: [{ date: "2024-04-20", amountCents: -RENT, lane: "TRANSFER" }] });
    const tl = buildTimeline("bill", b.segments);
    expect(valueAt(tl, "2024-04-10").quality).toBe("EXACT");
  });
});
