import { describe, expect, it } from "vitest";
import { transferDifferenceAdjustments } from "../ledger/transferFees.ts";
import { planBillPayments, type BillLeg } from "./billPayments.ts";
import { legKey } from "./matchTransfers.ts";

// Invented bill cycles and rent payments.
const cycle = (id: string, start: string, end: string, cents: number): BillLeg => ({ id, accountId: "bill", date: end, precision: "PERIOD", periodStart: start, periodEnd: end, amountCents: cents });

describe("paying a landlord's bill", () => {
  it("pairs a cycle with the rent payments in it that add up to what the bill says was paid", () => {
    const plan = planBillPayments(
      [cycle("b1", "2027-03-26", "2027-04-25", 301_500)],
      [
        { id: "early", date: "2027-03-20", amountCents: -301_500 },
        { id: "rent", date: "2027-04-01", amountCents: -301_500 },
        { id: "other", date: "2027-04-09", amountCents: -40_000 },
      ],
    );
    expect(plan).toEqual({ matches: [{ legIds: ["b1", "rent"], method: "EXACT_PAIR" }], suggestions: [], carriedIn: [] });
  });

  it("pairs a rent paid in two parts", () => {
    const plan = planBillPayments([cycle("b1", "2027-03-26", "2027-04-25", 301_500)], [
      { id: "a", date: "2027-03-30", amountCents: -100_000 },
      { id: "b", date: "2027-04-02", amountCents: -201_500 },
    ]);
    expect(plan.matches).toEqual([{ legIds: ["b1", "a", "b"], method: "AGGREGATE" }]);
  });

  it("leaves it to the owner when nothing adds up, offering the cycle's rent payments", () => {
    const plan = planBillPayments([cycle("b1", "2027-03-26", "2027-04-25", 301_500)], [{ id: "rent", date: "2027-04-01", amountCents: -291_500 }]);
    expect(plan).toEqual({ matches: [], suggestions: [{ legIds: ["b1", "rent"], differenceCents: 10_000 }], carriedIn: [] });
  });

  it("pairs nothing when two sets add up", () => {
    const plan = planBillPayments([cycle("b1", "2027-03-26", "2027-04-25", 100_000)], [
      { id: "a", date: "2027-03-30", amountCents: -100_000 },
      { id: "b", date: "2027-04-02", amountCents: -100_000 },
    ]);
    expect(plan.matches).toEqual([]);
  });

  it("respects a pairing the owner rejected", () => {
    const plan = planBillPayments([cycle("b1", "2027-03-26", "2027-04-25", 301_500)], [{ id: "rent", date: "2027-04-01", amountCents: -301_500 }], new Set([legKey(["b1", "rent"])]));
    expect(plan.matches).toEqual([]);
  });

  it("pairs a payment line the bill prints with the bank row of its amount", () => {
    const plan = planBillPayments(
      [{ id: "p", accountId: "bill", date: "2027-03-31", precision: "EXACT", periodStart: "2027-03-25", periodEnd: "2027-03-25", amountCents: 10_000 }],
      [{ id: "bank", date: "2027-03-29", amountCents: -10_000 }],
    );
    expect(plan.matches).toEqual([{ legIds: ["p", "bank"], method: "EXACT_PAIR" }]);
  });

  it("reads a payment line on the first bill that no bank payment made as credit carried in", () => {
    const line = (firstBill: boolean): BillLeg => ({ id: "p", accountId: "bill", date: "2027-03-31", precision: "EXACT", periodStart: "2027-03-25", periodEnd: "2027-03-25", amountCents: 10_000, firstBill });
    expect(planBillPayments([line(true)], []).carriedIn).toEqual(["p"]);
    expect(planBillPayments([line(false)], []).carriedIn).toEqual([]);
  });

  it("books a confirmed difference on the bill, not as a bank fee", () => {
    const legs = [
      { id: "b1", amountCents: 301_500, accountId: "bill" },
      { id: "rent", amountCents: -291_500, accountId: "chk" },
    ];
    expect([...transferDifferenceAdjustments([{ differenceCents: 10_000, legs }], new Set(["bill"]))]).toEqual([["b1", 10_000]]);
    expect([...transferDifferenceAdjustments([{ differenceCents: 10_000, legs }])]).toEqual([["rent", 10_000]]);
  });
});
