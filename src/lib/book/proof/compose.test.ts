import { describe, expect, it } from "vitest";
import { clearanceOf, isUnswept, noFigure, type SweepState } from "./clearance";
import { averageOf, medianOf, sumOf, type ProofTarget } from "./compose";
import { descriptorKey } from "./key";
import type { ProofDescriptor } from "./index";

// Pat Example's made-up months: spending of $300, $450 and $600.
const month = (start: string): ProofDescriptor => ({ report: "cash-flow", metric: "spending", granularity: "month", start, end: start.replace(/01$/, "28") });
const parts: ProofTarget[] = [
  { descriptor: month("2031-01-01"), shownCents: 30_000 },
  { descriptor: month("2031-02-01"), shownCents: 45_000 },
  { descriptor: month("2031-03-01"), shownCents: 60_000 },
];
const sweep = (other: Record<string, number> = {}): SweepState => ({
  status: "ready",
  stamp: "s1",
  cleared: Object.fromEntries(parts.map((p) => [descriptorKey(p.descriptor), { cents: other[(p.descriptor as { start: string }).start] ?? p.shownCents! }])),
  problems: {},
  basis: {},
});

describe("averageOf", () => {
  it("is the months added up, shown per month", () => {
    const a = averageOf(parts, 135_000) as ProofTarget;
    expect(a.perMonths).toBe(3);
    expect(a.shownCents).toBe(135_000);
    expect(a.descriptor.report).toBe("composite");
    expect(clearanceOf(a, sweep(), "s1").state).toBe("cleared");
  });

  it("is withheld when a month's proof cleared at another value", () => {
    const a = averageOf(parts, 135_000) as ProofTarget;
    const c = clearanceOf(a, sweep({ "2031-02-01": 46_000 }), "s1");
    expect(c.state).toBe("withheld");
  });

  it("is the month itself for a run of one, and nothing for none", () => {
    expect(averageOf(parts.slice(0, 1), 30_000)).toBe(parts[0]);
    expect(isUnswept(averageOf([], 0))).toBe(true);
  });

  it("keeps a part's withholding", () => {
    const none = noFigure("a month with no statement");
    expect(averageOf([parts[0]!, none], 30_000)).toEqual(none);
    expect(sumOf([parts[0]!, none], 30_000)).toEqual(none);
  });
});

describe("medianOf", () => {
  const item = (i: number) => ({ cents: parts[i]!.shownCents!, proof: parts[i]! as ProofTarget });
  it("is the middle figure's own proof for an odd count", () => {
    expect(medianOf([item(2), item(0), item(1)])).toBe(parts[1]);
  });
  it("averages the two middle figures for an even count", () => {
    const m = medianOf([item(2), item(0), item(1), { cents: 90_000, proof: parts[2]! }]) as ProofTarget;
    expect(m.perMonths).toBe(2);
    expect(m.shownCents).toBe(105_000);
  });
  it("has nothing to show for none", () => {
    expect(isUnswept(medianOf([]))).toBe(true);
  });
});
