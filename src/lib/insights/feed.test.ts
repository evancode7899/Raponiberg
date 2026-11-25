import { describe, expect, it } from "vitest";
import { descriptorKey } from "../book/proof/key";
import type { NetWorthReport } from "../book/reports/netWorth";
import type { SpendingMonth, SpendingReport } from "../book/reports/spending";
import type { CalendarItem } from "../book/reports/moneyCalendar";
import { noFigure } from "../book/proof/clearance";
import { sliceRange } from "../book/reports/cashFlowWindows";
import { buildInsights, type InsightProofs } from "./cashFlow";
import { buildFeed, records, type FeedInputs } from "./feed";

// Invented month-ends and months.
const netWorth = (cents: (number | null)[]): NetWorthReport =>
  ({
    periods: cents.map((c, i) => {
      const end = new Date(Date.UTC(2025, i + 1, 0)).toISOString().slice(0, 10);
      return { end, start: end.slice(0, 8) + "01", label: end.slice(0, 7), blockers: c == null ? [{ id: "x" }] : [], household: { closingCents: c ?? 0 } };
    }),
  }) as unknown as NetWorthReport;

const text = (f: { segs: (string | { text: string })[] }) => f.segs.map((s) => (typeof s === "string" ? s : s.text)).join("");

describe("records", () => {
  it("says a new high, how long the run is, and proves the balance it names", () => {
    const [r] = records(netWorth([100_00, 120_00, 130_00, 150_00]));
    expect(text(r!)).toBe("New high: net worth closed 2025-04 at $150, up 3 months running.");
    const fig = r!.segs.find((s) => typeof s !== "string")!;
    expect(typeof fig !== "string" && "descriptor" in fig.proof && descriptorKey(fig.proof.descriptor)).toBe(descriptorKey({ report: "net-worth", metric: "balance", date: "2025-04-30" }));
  });

  it("says when it's well below a high, and nothing for a small dip", () => {
    expect(text(records(netWorth([100_00, 200_00, 150_00]))[0]!)).toMatch(/^Net worth is below its high of \$200 \(2025-02\)/);
    expect(records(netWorth([100_00, 200_00, 198_00]))).toEqual([]);
  });

  it("never looks past a month that can't be proven", () => {
    // The high in January is on the far side of the gap, so it can't be compared with.
    expect(text(records(netWorth([900_00, null, 100_00, 110_00, 120_00]))[0]!)).toMatch(/^New high/);
    expect(records(netWorth([100_00, 120_00, null]))).toEqual([]);
  });
});

const month = (i: number, over: Partial<SpendingMonth> = {}): SpendingMonth => {
  const start = new Date(Date.UTC(2025, i, 1)).toISOString().slice(0, 10);
  return { start, end: start, label: start.slice(0, 7), incomeCents: 1_000_000, spendingCents: 400_000, netCents: 600_000, oneOffCents: 0, savingsRate: 0.6, retirementEmployeeCents: 0, retirementEmployerCents: 0, spendingByCategory: [{ category: "Dining", cents: 400_000 }], incomeByCategory: [], merchants: [], payers: [], ...over } as unknown as SpendingMonth;
};
const spending = (months: SpendingMonth[]): SpendingReport => ({ months, recurring: [], oneOffs: [] }) as unknown as SpendingReport;
const proofs: InsightProofs = { proof: () => noFigure("test"), dp: () => noFigure("test") };

describe("cash flow insights", () => {
  const insights = (ms: SpendingMonth[]) => buildInsights(sliceRange(spending(ms), "12m", { from: "", to: "" }), spending(ms), proofs);

  it("leads with what changed, and puts steadiness last", () => {
    const ms = Array.from({ length: 24 }, (_, i) => month(i));
    ms[23] = month(23, { spendingByCategory: [{ category: "Dining", cents: 400_000 }, { category: "Travel & entertainment", cents: 900_000 }] as never });
    const list = insights(ms);
    expect(list[0]!.key).toMatch(/^Travel & entertainment ran high/);
    expect(list.at(-1)!.key).toBe("Spending is steady");
    expect(list.map((i) => i.rank)).toEqual([...list.map((i) => i.rank)].sort());
  });

  it("never states a typical amount that is zero or a net refund", () => {
    const refund = { spendingByCategory: [{ category: "Dining", cents: 400_000 }, { category: "Taxes & fees", cents: -1_500 }] as never };
    const ms = Array.from({ length: 24 }, (_, i) => month(i, refund));
    ms[23] = month(23, { spendingByCategory: [{ category: "Dining", cents: 400_000 }, { category: "Taxes & fees", cents: 2_500_000 }] as never });
    const spike = insights(ms).find((i) => i.key.startsWith("Taxes & fees ran high"))!;
    expect(spike.body.map((s) => (typeof s === "string" ? s : s.text)).join("")).toBe("$25,000, in a category a typical month spends nothing on.");
  });
});

describe("the feed", () => {
  const item = (over: Partial<CalendarItem>): CalendarItem => ({ id: "x", date: "2026-07-20", year: 2026, kind: "tax", title: "Example payment", detail: "", cents: 500_000, proof: null, href: "/calendar", done: false, ...over });
  const inputs = (calendar: CalendarItem[]): FeedInputs => ({ today: "2026-07-15", spending: spending([]), netWorth: netWorth([100_00, 101_00, 102_00]), change: null, calendar, goals: [] });

  it("lists deadlines close by that are still open and have an amount", () => {
    const feed = buildFeed(
      inputs([item({ id: "soon" }), item({ id: "done", done: true }), item({ id: "far", date: "2026-12-31" }), item({ id: "past", date: "2026-07-01" }), item({ id: "zero", cents: 0 })]),
    );
    expect(feed.filter((f) => f.area === "CAL").map((f) => f.id)).toEqual(["due:soon"]);
    expect(text(feed.find((f) => f.id === "due:soon")!)).toBe("Example payment: $5,000, in 5 days.");
  });

  it("puts the nearer of two equal deadlines first, and lists nothing twice", () => {
    const feed = buildFeed(inputs([item({ id: "later", date: "2026-08-20" }), item({ id: "sooner", date: "2026-07-18" }), item({ id: "sooner", date: "2026-07-18" })]));
    expect(feed.filter((f) => f.area === "CAL").map((f) => f.id)).toEqual(["due:sooner", "due:later"]);
  });

  it("is ranked, cut to its limit, and proves every number it names", () => {
    const feed = buildFeed(inputs(Array.from({ length: 30 }, (_, i) => item({ id: `d${i}`, cents: 100_000 + i }))), 8);
    expect(feed).toHaveLength(8);
    expect(feed.map((f) => f.score)).toEqual([...feed.map((f) => f.score)].sort((a, b) => b - a));
    for (const f of feed) for (const s of f.segs) if (typeof s !== "string") expect("descriptor" in s.proof).toBe(true);
  });
});
