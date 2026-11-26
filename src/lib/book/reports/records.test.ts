import { describe, expect, it } from "vitest";
import { recordsDerived } from "../derived/netWorth";
import type { NetWorthReport } from "./netWorth";
import type { NetWorthChange } from "./netWorthChanges";
import { markStep, netWorthRecords, provenRun, risesOf, roundMark } from "./records";

// Invented month-ends (null: a month that can't be proven) and months.
const nw = (cents: (number | null)[]): NetWorthReport =>
  ({
    periods: cents.map((c, i) => {
      const end = new Date(Date.UTC(2025, i + 1, 0)).toISOString().slice(0, 10);
      return { end, start: end.slice(0, 8) + "01", label: end.slice(0, 7), blockers: c == null ? [{ id: "x" }] : [], household: { closingCents: c ?? 0 } };
    }),
  }) as unknown as NetWorthReport;
const change = (month: string, savedCents: number, marketsCents: number, through: string | null = null): NetWorthChange =>
  ({ label: month, start: `${month}-01`, end: `${month}-28`, savedCents, marketsCents, through, firstOnFileCents: 0, proofs: {} }) as unknown as NetWorthChange;

describe("records", () => {
  it("needs three proven months", () => {
    expect(netWorthRecords(nw([]))).toBeNull();
    expect(netWorthRecords(nw([100]))).toBeNull();
    expect(netWorthRecords(nw([100, 200]))).toBeNull();
    expect(netWorthRecords(nw([100, 200, 300, null]))).toBeNull();
    expect(netWorthRecords(nw([100, 200, 300]))).not.toBeNull();
  });

  it("splits month-ends into rising runs, a level month ending one", () => {
    const run = provenRun(nw([10, 20, 30, 25, 40, 40, 50]));
    expect(risesOf(run).map((r) => [r.months, r.from.label, r.to.label])).toEqual([
      [2, "2025-01", "2025-03"],
      [1, "2025-04", "2025-05"],
      [1, "2025-06", "2025-07"],
    ]);
    expect(risesOf(provenRun(nw([30, 20, 10])))).toEqual([]);
  });

  it("names the longest run (the latest of two as long) and the one under way", () => {
    const x = netWorthRecords(nw([10, 20, 30, 5, 15, 25]))!;
    expect(x.longestRise).toMatchObject({ months: 2, from: { label: "2025-04" } });
    expect(x.currentRise).toBe(x.longestRise);
    expect(netWorthRecords(nw([10, 20, 30, 25]))!.currentRise).toBeNull();
  });

  it("never looks past a month that can't be proven", () => {
    const x = netWorthRecords(nw([900, 950, null, 100, 110, 120]), [change("2025-01", 9_000, 9_000), change("2025-05", 50, 20)])!;
    expect(x.high.label).toBe("2025-06");
    expect(x.longestRise!.months).toBe(2);
    expect(x.bestSaved!.label).toBe("2025-05");
  });

  it("picks the best whole months, and none where nothing was saved or gained", () => {
    const x = netWorthRecords(nw([1, 2, 3, 4]), [change("2025-01", 100, -5), change("2025-02", 300, 50), change("2025-03", 200, 80), change("2025-04", 900, 900, "2025-04-10")])!;
    expect([x.bestSaved!.label, x.bestMarkets!.label]).toEqual(["2025-02", "2025-03"]);
    // A month an account first appears in saved what it brought, not what was saved.
    const opened = netWorthRecords(nw([1, 2, 3]), [{ ...change("2025-01", 9_000, 0), firstOnFileCents: 8_000 }, change("2025-02", 100, 0)])!;
    expect(opened.bestSaved!.label).toBe("2025-02");
    const none = netWorthRecords(nw([1, 2, 3]), [change("2025-01", -100, 0)])!;
    expect([none.bestSaved, none.bestMarkets]).toEqual([null, null]);
  });

  it("states the round marks either side of net worth", () => {
    const x = netWorthRecords(nw([880_000_00, 890_000_00, 910_000_00]))!;
    expect(x.passed).toMatchObject({ markCents: 900_000_00, at: { label: "2025-03" } });
    expect(x.next).toEqual({ markCents: 1_000_000_00, gapCents: 90_000_00 });
    // Above it all along: when it was passed isn't known.
    expect(netWorthRecords(nw([910_000_00, 920_000_00, 930_000_00]))!.passed).toEqual({ markCents: 900_000_00, at: null });
    // In debt there's no mark below, and none at zero.
    const debt = netWorthRecords(nw([-50_000_00, -40_000_00, -30_000_00]))!;
    expect([debt.passed, debt.next]).toEqual([null, null]);
    expect([markStep(400_000_00), markStep(2_000_000_00), markStep(6_000_000_00)]).toEqual([100_000_00, 500_000_00, 1_000_000_00]);
    expect([roundMark(900_000_00), roundMark(1_500_000_00), roundMark(2_000_000_00)]).toEqual(["$900,000", "$1.5 million", "$2 million"]);
  });

  it("gives the lengths and the way to the next mark a recipe that adds up", () => {
    const d = recordsDerived(nw([880_000_00, 890_000_00, 910_000_00]), []);
    expect(d.map((f) => f.figure)).toEqual(["record-rise", "record-rise-now", "record-next"]);
    expect(d[0]!.value).toEqual({ text: "2" });
    const next = d[2]!;
    expect(next.value).toEqual({ cents: 90_000_00 });
    expect(next.lines.map((l) => ("cents" in l.value ? l.value.cents : 0))).toEqual([1_000_000_00, 910_000_00, 90_000_00]);
    expect(recordsDerived(nw([1]), [])).toEqual([]);
  });
});
