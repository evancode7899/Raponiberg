import { describe, expect, it } from "vitest";
import type { Ledger, LedgerAccount } from "./loadLedger";
import { buildNetWorthReport, monthlyDietz, monthReturn } from "./netWorthReport";
import { buildTimeline, chainedReturn, dietzParts } from "./timeline";

// A made-up household: two brokerage accounts, monthly statements, a big deposit mid-quarter.

type Month = [start: string, end: string, open: number, close: number, growth: number, deposit?: { date: string; cents: number }];

function account(id: string, months: Month[]): LedgerAccount {
  const timeline = buildTimeline(
    id,
    months.map(([periodStart, periodEnd, openingCents, closingCents, growthCents, deposit]) => ({
      accountId: id,
      periodStart,
      periodEnd,
      openingCents,
      closingCents,
      growthCents,
      feesCents: 0,
      flows: deposit ? [{ date: deposit.date, precision: "EXACT" as const, amountCents: deposit.cents, lane: "TRANSFER" as const }] : [],
    })),
  );
  return { id, name: id, institution: null, type: "INVESTMENT", subtype: null, group: "Taxable investments", isInvestment: true, timeline, statementCount: months.length, closed: false };
}

// Jan +5%, Feb −10% then a deposit as large as the account, Mar +8%: a quarter where one Dietz and the months chained differ.
const a = account("a", [
  ["2025-01-01", "2025-01-31", 10_000_000, 10_500_000, 500_000],
  ["2025-02-01", "2025-02-28", 10_500_000, 19_450_000, -1_050_000, { date: "2025-02-27", cents: 10_000_000 }],
  ["2025-03-01", "2025-03-31", 19_450_000, 21_006_000, 1_556_000],
  ["2025-04-01", "2025-04-30", 21_006_000, 21_216_060, 210_060],
]);
// Opens in February with too little to measure, then grows into a measured account.
const b = account("b", [
  ["2025-02-01", "2025-02-28", 50_000, 50_500, 500],
  ["2025-03-01", "2025-03-31", 50_500, 5_100_500, 50_000, { date: "2025-03-01", cents: 5_000_000 }],
  ["2025-04-01", "2025-04-30", 5_100_500, 5_049_495, -51_005],
]);
const ledger: Ledger = { accounts: [a, b], mergeDate: "2025-01-01", completeThrough: "2025-04-30", firstDay: "2025-01-01" };

const report = (granularity: "month" | "quarter" | "year", through?: string) => buildNetWorthReport(ledger, { granularity, from: "2025-01-01", to: "2025-04-30", ...(through ? { through } : {}) });

describe("span returns chain their months", () => {
  const months = report("month").periods;

  it("a quarter's portfolio return is its months' returns chained, not one Dietz over the quarter", () => {
    const q1 = report("quarter").periods[0]!;
    const rs = months.slice(0, 3).map((m) => m.household.portfolioReturn);
    expect(rs.every((r) => r != null)).toBe(true);
    expect(q1.household.portfolioReturn).toBe(chainedReturn(rs));
    expect(q1.household.portfolioReturn).toBeCloseTo(rs.reduce((g: number, r) => g * (1 + r!), 1) - 1, 12);
    // One Modified Dietz over the whole quarter weighs the late deposit by a few days only, and comes out different.
    const ga = dietzParts(a.timeline, "2025-01-01", "2025-03-31");
    const gb = dietzParts(b.timeline, "2025-02-01", "2025-03-31");
    const oneDietz = (ga.gainCents + gb.gainCents) / (ga.capitalCents + gb.capitalCents);
    expect(Math.abs(q1.household.portfolioReturn! - oneDietz)).toBeGreaterThan(0.001);
  });

  it("each account's quarter return chains its own months, leaving out a month under $1,000", () => {
    const q1 = report("quarter").periods[0]!;
    const of = (p: (typeof months)[number], id: string) => p.byAccount.find((x) => x.accountId === id)!.returnRatio;
    expect(of(q1, "a")).toBe(chainedReturn(months.slice(0, 3).map((m) => of(m, "a"))));
    // b's February ($500 invested) has no return; its quarter is March alone.
    expect(of(months[1]!, "b")).toBeNull();
    expect(of(q1, "b")).toBeCloseTo(of(months[2]!, "b")!, 12);
  });

  it("a year cut at the proven-through date chains the months up to it, as the monthly report cuts them", () => {
    const y = report("year", "2025-04-20").periods[0]!;
    const cut = report("month", "2025-04-20").periods;
    expect(cut.at(-1)!.end).toBe("2025-04-20");
    expect(y.household.portfolioReturn).toBe(chainedReturn(cut.map((m) => m.household.portfolioReturn)));
  });

  it("a month's return is still its own Modified Dietz", () => {
    const jan = months[0]!;
    expect(jan.household.portfolioReturn).toBe(monthReturn(dietzParts(a.timeline, "2025-01-01", "2025-01-31")));
    expect(monthlyDietz(b.timeline, "2025-01-01", "2025-04-30").map((m) => m.start)).toEqual(["2025-02-01", "2025-03-01", "2025-04-01"]);
  });

  it("chainedReturn leaves unmeasured months out and has none when no month is measured", () => {
    expect(chainedReturn([0.1, null, -0.1])).toBeCloseTo(1.1 * 0.9 - 1, 12);
    expect(chainedReturn([null, null])).toBeNull();
    expect(chainedReturn([])).toBeNull();
  });
});

describe("a closing balance on a statement's last day is exact, whatever the month's change", () => {
  // One quarterly statement: its market change is spread over the quarter's days.
  const q = account("q", [["2025-04-01", "2025-06-30", 10_000_000, 10_300_000, 300_000]]);
  const r = buildNetWorthReport({ accounts: [q], mergeDate: "2025-01-01", completeThrough: "2025-06-30", firstDay: "2025-04-01" }, { granularity: "month", from: "2025-04-01", to: "2025-06-30" });

  it("estimates April's and May's month-end values and the split of the quarter's change, but not the June 30 balance", () => {
    const [apr, may, jun] = r.periods;
    expect(apr!.household.closingQuality).toBe("ESTIMATED");
    expect(may!.household.closingQuality).toBe("ESTIMATED");
    expect(jun!.household.quality).toBe("ESTIMATED");
    expect(jun!.household.closingQuality).toBe("EXACT");
    expect(jun!.byAccount[0]!.closingQuality).toBe("EXACT");
    expect(jun!.household.closingCents).toBe(10_300_000);
  });
});
