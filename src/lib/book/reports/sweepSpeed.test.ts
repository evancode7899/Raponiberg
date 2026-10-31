import { describe, expect, it } from "vitest";
import { daysBetween } from "../../dates/isoDate";
import type { BookRow } from "../load";
import { paidYearDescriptor, yearPayDescriptor } from "./bonusFigures";
import type { BonusYear } from "./bonuses";
import { reversals } from "./spending";

/** The pairing as it was first written (a scan of every row per credit): the reference the indexed one must match. */
function reversalsByScan(rows: BookRow[]): Set<string> {
  const out = new Set<string>();
  for (const c of rows) {
    if (c.lane !== "EXPENSE" || c.amountCents <= 0) continue;
    const charge = rows.find((r) => !out.has(r.id) && r.lane === "EXPENSE" && r.accountId === c.accountId && r.amountCents === -c.amountCents && Math.abs(daysBetween(r.date, c.date)) <= 7);
    if (!charge) continue;
    out.add(charge.id);
    out.add(c.id);
  }
  return out;
}

/** A small seeded generator, so a failure reproduces. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("reversals: indexed by account and amount, the same pairs as a full scan", () => {
  it("matches the scan on many made-up books, refunds and repeats included", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed);
      const rows = Array.from({ length: 120 }, (_, i): BookRow => {
        const amount = [1_250, 4_000, 999, 15_000][Math.floor(r() * 4)]!;
        const sign = r() < 0.3 ? 1 : -1;
        return {
          id: `row-${seed}-${i}`,
          date: `2031-03-${String(1 + Math.floor(r() * 28)).padStart(2, "0")}`,
          lane: r() < 0.9 ? "EXPENSE" : "INCOME",
          accountId: ["card-1", "card-2"][Math.floor(r() * 2)]!,
          amountCents: sign * amount,
        } as BookRow;
      });
      expect([...reversals(rows)].sort(), `seed ${seed}`).toEqual([...reversalsByScan(rows)].sort());
    }
  });
});

describe("Bonuses pay recipes stop where the page does: the report's as-of date", () => {
  it("a year still under way runs through the as-of date; a past year runs whole", () => {
    expect(yearPayDescriptor("pat", 2031, ["base"], "2031-06-30")).toMatchObject({ through: "2031-06-30" });
    expect(yearPayDescriptor("pat", 2030, ["base"], "2031-06-30")).not.toHaveProperty("through");
    expect(yearPayDescriptor("pat", 2031, ["base"], "2031-12-31")).not.toHaveProperty("through");
  });

  it("a year's bonus paychecks end at a gap in the stubs, else at the as-of date", () => {
    const y = { year: 2031, personId: "pat", employerKeys: ["EXAMPLE PARTNERS"], through: null } as unknown as BonusYear;
    expect(paidYearDescriptor(y, "2031-06-30")).toMatchObject({ start: "2031-01-01", end: "2031-06-30" });
    expect(paidYearDescriptor({ ...y, year: 2030 }, "2031-06-30")).toMatchObject({ end: "2030-12-31" });
    expect(paidYearDescriptor({ ...y, through: "2031-04-14" }, "2031-06-30")).toMatchObject({ end: "2031-04-14" });
  });
});
