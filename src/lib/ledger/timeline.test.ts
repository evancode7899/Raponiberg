import { describe, expect, it } from "vitest";
import { buildTimeline, chainBreaks, coverageGaps, decompose, modifiedDietz, valueAt } from "./timeline";

describe("timeline: bank account on a mid-month cycle", () => {
  // Chase-like statements: Jul 25 – Aug 26, Aug 27 – Sep 25.
  const t = buildTimeline("chase", [
    {
      accountId: "chase",
      periodStart: "2026-07-25",
      periodEnd: "2026-08-26",
      openingCents: 100_000,
      closingCents: 150_000,
      growthCents: 0,
      feesCents: 0,
      flows: [
        { date: "2026-07-31", precision: "EXACT", amountCents: 500_000, lane: "INCOME" },
        { date: "2026-08-05", precision: "EXACT", amountCents: -450_000, lane: "TRANSFER" },
      ],
    },
    {
      accountId: "chase",
      periodStart: "2026-08-27",
      periodEnd: "2026-09-25",
      openingCents: 150_000,
      closingCents: 120_000,
      growthCents: 0,
      feesCents: 0,
      flows: [{ date: "2026-09-01", precision: "EXACT", amountCents: -30_000, lane: "EXPENSE" }],
    },
  ]);

  it("knows the exact balance on a calendar month-end inside a cycle", () => {
    expect(valueAt(t, "2026-07-31")).toEqual({ cents: 600_000, quality: "EXACT", asOf: "2026-07-31" });
    expect(valueAt(t, "2026-08-31")).toMatchObject({ cents: 150_000, quality: "EXACT" });
  });

  it("decomposes a calendar month that spans two statements", () => {
    const aug = decompose(t, "2026-08-01", "2026-08-31");
    expect(aug.openingCents).toBe(600_000);
    expect(aug.closingCents).toBe(150_000);
    expect(aug.flowsByLane).toEqual({ TRANSFER: -450_000 });
    expect(aug.unexplainedCents).toBe(0);
    expect(aug.quality).toBe("EXACT");
  });

  it("carries the last balance forward as stale", () => {
    expect(valueAt(t, "2026-10-15")).toEqual({ cents: 120_000, quality: "STALE", asOf: "2026-09-25" });
  });
});

describe("timeline: quarterly 401(k)", () => {
  const t = buildTimeline("k", [
    {
      accountId: "k",
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
      openingCents: 1_000_000,
      closingCents: 1_480_000,
      growthCents: 90_000,
      feesCents: -1_000,
      flows: [
        { date: "2026-03-31", precision: "PERIOD", amountCents: 300_000, lane: "CONTRIBUTION_EMPLOYEE" },
        { date: "2026-03-31", precision: "PERIOD", amountCents: 91_000, lane: "CONTRIBUTION_EMPLOYER" },
      ],
    },
  ]);

  it("is exact at the quarter end and estimated inside it", () => {
    expect(valueAt(t, "2026-03-31")).toMatchObject({ cents: 1_480_000, quality: "EXACT" });
    expect(valueAt(t, "2026-02-15").quality).toBe("ESTIMATED");
  });

  it("splits a quarter's contributions and growth across months, summing back exactly", () => {
    const months = [
      decompose(t, "2026-01-01", "2026-01-31"),
      decompose(t, "2026-02-01", "2026-02-28"),
      decompose(t, "2026-03-01", "2026-03-31"),
    ];
    const total = (pick: (d: (typeof months)[number]) => number) => months.reduce((a, d) => a + pick(d), 0);
    expect(total((d) => d.flowsByLane.CONTRIBUTION_EMPLOYEE ?? 0)).toBeCloseTo(300_000, -1);
    expect(total((d) => d.growthCents + d.feesCents)).toBeCloseTo(89_000, -1);
    for (const d of months) {
      expect(d.openingCents + d.contributionsCents + d.growthCents + d.feesCents + d.unexplainedCents).toBe(d.closingCents);
    }
  });

  it("computes a Modified Dietz return net of fees", () => {
    const r = modifiedDietz(t, "2026-01-01", "2026-03-31")!;
    // 89,000 / (1,000,000 + 391,000 × ~0.5)
    expect(r).toBeGreaterThan(0.074);
    expect(r).toBeLessThan(0.075);
  });
});

describe("timeline: gaps, summaries, chain breaks", () => {
  const months = [
    ["2022-10-01", "2022-10-31", 2_000_000, 2_100_000],
    ["2022-11-01", "2022-11-30", 2_100_000, 2_150_000],
  ] as const;
  const statements = months.map(([s, e, o, c]) => ({
    accountId: "f",
    periodStart: s,
    periodEnd: e,
    openingCents: o,
    closingCents: c,
    growthCents: c - o,
    feesCents: 0,
    flows: [],
  }));

  it("derives a missing December from the year-end summary", () => {
    const t = buildTimeline("f", statements, [
      {
        accountId: "f",
        periodStart: "2022-10-01",
        periodEnd: "2022-12-31",
        openingCents: 2_000_000,
        closingCents: 2_500_000,
        growthCents: 200_000,
        feesCents: 0,
        flows: [{ date: "2022-12-31", precision: "PERIOD", amountCents: 300_000, lane: "TRANSFER" }],
      },
    ]);
    const dec = decompose(t, "2022-12-01", "2022-12-31");
    expect(dec.openingCents).toBe(2_150_000);
    expect(dec.closingCents).toBe(2_500_000);
    expect(dec.flowsByLane.TRANSFER).toBe(300_000);
    expect(dec.growthCents).toBe(50_000);
    expect(dec.unexplainedCents).toBe(0);
    expect(coverageGaps(t)).toEqual([{ from: "2022-12-01", to: "2022-12-31", kind: "DERIVED" }]);
  });

  it("flags a missing statement and attributes its change to 'unexplained'", () => {
    const t = buildTimeline("f", [
      statements[0]!,
      { ...statements[1]!, periodStart: "2022-12-01", periodEnd: "2022-12-31", openingCents: 2_200_000, closingCents: 2_250_000 },
    ]);
    expect(coverageGaps(t)).toEqual([{ from: "2022-11-01", to: "2022-11-30", kind: "MISSING" }]);
    const nov = decompose(t, "2022-11-01", "2022-11-30");
    expect(nov.unexplainedCents).toBe(100_000);
    expect(nov.quality).toBe("INTERPOLATED");
  });

  it("detects contiguous statements whose balances don't chain", () => {
    const t = buildTimeline("f", [statements[0]!, { ...statements[1]!, openingCents: 2_099_000 }]);
    expect(chainBreaks(t)).toEqual([{ at: "2022-11-01", priorClosingCents: 2_100_000, openingCents: 2_099_000 }]);
  });

  it("treats an account that closed at zero as zero afterwards, not stale", () => {
    const t = buildTimeline("e", [
      { accountId: "e", periodStart: "2025-10-01", periodEnd: "2025-12-31", openingCents: 500, closingCents: 0, growthCents: 0, feesCents: 0, flows: [{ date: "2025-12-31", precision: "PERIOD", amountCents: -500, lane: "TRANSFER" }] },
    ]);
    expect(valueAt(t, "2026-06-30")).toEqual({ cents: 0, quality: "EXACT", asOf: "2026-06-30" });
  });
});
