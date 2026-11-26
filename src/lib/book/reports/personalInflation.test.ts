import { describe, expect, it } from "vitest";
import { priceDerived } from "../derived/cashFlow";
import { personalInflation } from "./personalInflation";
import type { RecurringCharge } from "./spending";

// Invented bills.
const bill = (key: string, category: string, now: number, then: number | null, over: Partial<RecurringCharge> = {}): RecurringCharge => ({
  key, name: key, category, kind: "bill", cadence: "monthly", count: 13, monthsSeen: 13, typicalCents: now, last12Cents: now * 12, annualCents: now * 12,
  firstDate: "2025-01-05", lastDate: "2026-01-05", lastCents: now, active: true, changeCents: null, lastRowId: `${key}-now`, fixed: true,
  yearAgo: then == null ? null : { rowId: `${key}-then`, date: "2025-01-05", cents: then }, ...over,
});

describe("personal inflation", () => {
  it("weights each bill's own change by its cost, by category and in all", () => {
    const p = personalInflation([bill("Phone", "Bills", 110_00, 100_00), bill("Stream", "Bills", 20_00, 20_00), bill("Gym", "Health", 50_00, 40_00)]);
    expect(p.bills.map((b) => [b.key, b.change])).toEqual([["Gym", 0.25], ["Phone", 0.10000000000000009], ["Stream", 0]]);
    expect(p.categories.map((g) => [g.category, g.thenCents, g.nowCents])).toEqual([["Bills", 120_00, 130_00], ["Health", 40_00, 50_00]]);
    expect(p.all!.change).toBeCloseTo(180 / 160 - 1, 12);
  });

  it("leaves out bills with no charge a year before, stopped ones and habits; nothing at all is none", () => {
    expect(personalInflation([]).all).toBeNull();
    const p = personalInflation([
      bill("New", "Bills", 10_00, null),
      bill("Gone", "Bills", 10_00, 5_00, { active: false }),
      bill("Cafe", "Dining", 10_00, 5_00, { kind: "habit" }),
      bill("Power", "Bills", 90_00, 60_00, { fixed: false }),
      bill("Quarterly tax", "Taxes & fees", 900_00, 800_00),
    ]);
    expect([p.bills, p.all]).toEqual([[], null]);
  });

  it("states each change from the two charges, linked to their rows", () => {
    const d = priceDerived([bill("Phone", "Bills", 110_00, 100_00)]);
    expect(d.map((f) => f.figure)).toEqual(["price-bill", "price-category", "price-all"]);
    expect(d[0]!.lines.map((l) => l.link?.descriptor)).toEqual([{ report: "row", rowId: "Phone-now" }, { report: "row", rowId: "Phone-then" }, undefined]);
  });
});
