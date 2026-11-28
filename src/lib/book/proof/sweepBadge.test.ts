import { describe, expect, it } from "vitest";
import type { SweepProblem, SweepState } from "./clearance.ts";
import { NO_BADGE, sweepBadge, withheldFigures } from "./sweepBadge.ts";

const problem = (kind: SweepProblem["kind"]): SweepProblem => ({ kind, page: "Taxes 2025", descriptor: null, detail: "off" });
const ready = (problems: Record<string, SweepProblem[]> = {}): SweepState => ({ stamp: "s1", status: "ready", cleared: {}, basis: {}, problems });
const pending = (stamp: string | null = "s1"): SweepState => ({ stamp, status: "pending", cleared: {}, basis: {}, problems: {} });
const failed: SweepState = { stamp: null, status: "failed", cleared: {}, basis: {}, problems: {}, error: "boom" };

describe("sweepBadge", () => {
  it("turns while the sweep runs, then says all clear", () => {
    const running = sweepBadge(NO_BADGE, pending());
    expect(running).toEqual({ kind: "running" });
    expect(sweepBadge(running, pending())).toEqual({ kind: "running" });
    expect(sweepBadge(running, ready())).toEqual({ kind: "clear" });
  });

  it("waits for a real answer: the browser's placeholder is no sweep running", () => {
    expect(sweepBadge(NO_BADGE, pending(null))).toBe(NO_BADGE);
  });

  it("says nothing when the sweep was already done as the app opened", () => {
    expect(sweepBadge(NO_BADGE, ready())).toBe(NO_BADGE);
    expect(sweepBadge(NO_BADGE, ready({ a: [problem("CHAIN")] }))).toBe(NO_BADGE);
  });

  it("never says all clear over a withheld figure", () => {
    expect(sweepBadge({ kind: "running" }, ready({ a: [problem("CHAIN"), problem("DIFFERS")], b: [problem("REDERIVE")], c: [problem("LINK")] }))).toEqual({ kind: "withheld", figures: 2 });
  });

  it("goes once a later sweep of the same run withholds nothing", () => {
    expect(sweepBadge({ kind: "withheld", figures: 2 }, ready())).toBe(NO_BADGE);
  });

  it("says a sweep failed, and all clear once one after it ties", () => {
    const f = sweepBadge({ kind: "running" }, failed);
    expect(f).toEqual({ kind: "failed", error: "boom" });
    expect(sweepBadge(f, ready())).toEqual({ kind: "clear" });
  });

  it("counts only blocking problems", () => {
    expect(withheldFigures(ready({ a: [problem("SKIPPED")], b: [problem("LINK")] }))).toBe(0);
    expect(withheldFigures({ ...ready({ a: [problem("CHAIN")] }), status: "pending" })).toBe(0);
  });
});
