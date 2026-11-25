import { describe, expect, it } from "vitest";
import { monthStory, latestClosed } from "./monthStory";
import { highlightText, type NetWorthChange } from "./netWorthChanges";
import { compose } from "../proof/composite";

// An invented month: every amount is made up.
const d = (k: string) => ({ report: "cash-flow", metric: k, granularity: "month", start: "2025-06-01", end: "2025-06-30" }) as never;
const month = (over: Partial<NetWorthChange> = {}): NetWorthChange =>
  ({
    label: "Jun 2025",
    start: "2025-06-01",
    end: "2025-06-30",
    through: null,
    openingCents: 100_000_00,
    closingCents: 104_000_00,
    changeCents: 4_000_00,
    savedCents: 3_000_00,
    firstOnFileCents: 0,
    marketsCents: 1_000_00,
    incomeCents: 10_000_00,
    spendingCents: 7_500_00,
    portfolioReturn: 0.012,
    steps: [],
    typical: { periods: 3, changeCents: 2_000_00, savedCents: 2_500_00, marketsCents: -500_00, incomeCents: 9_000_00, spendingCents: 6_000_00, of: ["Mar", "Apr", "May"] },
    spendingMovers: [{ category: "Travel", cents: 2_000_00, typicalCents: 500_00, deltaCents: 1_500_00, proof: d("spending") }],
    incomeMovers: [],
    highlights: [],
    proofs: { opening: d("o"), closing: d("c"), change: d("change"), saved: d("saved"), markets: d("markets"), income: d("income"), spending: d("spending") },
    ...over,
  }) as NetWorthChange;

describe("the month in five lines", () => {
  it("says pay, spending, saving, markets and what stood out", () => {
    const s = monthStory(month());
    expect(s.sentences.map(highlightText)).toEqual([
      "Income came to $10,000, $1,000 more than a typical month ($9,000).",
      "Spending was $7,500, $1,500 more than a typical month ($6,000), led by Travel.",
      "You kept 25% of it, $2,500; with retirement money from pay, saving added $3,000 to net worth.",
      "Markets added $1,000, a 1.2% return, and net worth rose $4,000.",
      "What stood out: spending on Travel, $2,000 against a typical $500.",
    ]);
    expect(s.bars.map((b) => [b.key, b.now, b.typical])).toEqual([
      ["income", 10_000, 9_000],
      ["spending", 7_500, 6_000],
      ["saved", 3_000, 2_500],
      ["markets", 1_000, -500],
    ]);
  });

  it("states every number as a figure whose recipe works out to it", () => {
    for (const seg of monthStory(month()).sentences.flat()) {
      if (typeof seg === "string") continue;
      expect(seg.descriptor).toBeDefined();
      const desc = seg.descriptor as { report: string; op?: "diff" | "share" };
      if (desc.report !== "composite") continue;
      // A composite's value from its parts: income less spending, and that over income.
      const v = compose(desc.op!, desc.op === "diff" ? [{ cents: 10_000_00 }, { cents: 7_500_00 }] : [{ cents: 2_500_00 }, { cents: 10_000_00 }]);
      if (seg.text === "$2,500") expect(v).toEqual({ cents: seg.cents });
      if (seg.text === "25%") expect(v).toEqual({ ratio: seg.ratio });
    }
  });

  it("compares with nothing in a first month, and says a short month and a fall plainly", () => {
    const s = monthStory(month({ typical: null, spendingMovers: [], incomeCents: 0, spendingCents: 1_000_00, changeCents: -2_000_00, marketsCents: -1_000_00, portfolioReturn: null }));
    expect(s.sentences.map(highlightText)).toEqual([
      "No income came in.",
      "Spending was $1,000.",
      "Spending ran $1,000 past income; with retirement money from pay, saving added $3,000 to net worth.",
      "Markets took away $1,000, and net worth fell $2,000.",
      "The first proven month: nothing before it to compare with.",
    ]);
    expect(s.bars.every((b) => b.typical == null)).toBe(true);
  });

  it("only tells the story of a whole month", () => {
    expect(latestClosed([])).toBeNull();
    expect(latestClosed([month(), month({ through: "2025-07-10" })])).toBeNull();
    expect(latestClosed([month()])!.label).toBe("Jun 2025");
  });
});
