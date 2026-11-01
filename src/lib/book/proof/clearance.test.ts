import { describe, expect, it } from "vitest";
import type { BlockerRef } from "../reports/blockerRef";
import { clearanceOf, NO_SWEEP, sweepAnswer, unswept, type ShownFigure, type SweepState } from "./clearance";
import { descriptorKey } from "./key";

const descriptor = { report: "cash-flow", metric: "spending", granularity: "month", start: "2031-03-01", end: "2031-03-31" } as const;
const key = descriptorKey(descriptor);
const shown = (cents: number | null): ShownFigure => ({ descriptor, shownCents: cents });
const ready = (over: Partial<SweepState> = {}): SweepState => ({ stamp: "abc123", status: "ready", cleared: { [key]: { cents: 412_50 } }, basis: {}, problems: {}, ...over });
const blocker: BlockerRef = { id: "f1", status: "MISSING", title: "Example Bank ••1234: March statement missing", fix: "Download it" };

describe("clearance: a figure shows only when the sweep of the page's data cleared it at the value shown", () => {
  it("shows a figure the sweep of the same data cleared at the same value", () => {
    const c = clearanceOf(shown(412_50), ready(), "abc123");
    expect(c).toMatchObject({ state: "cleared", key, cleared: { cents: 412_50 }, basis: "proven" });
  });

  it("reads verifying while the sweep of the page's data is pending, never the number", () => {
    expect(clearanceOf(shown(412_50), { ...ready(), status: "pending", cleared: {} }, "abc123").state).toBe("verifying");
    // Pending for other data than the page's: still verifying (the provider asks again).
    expect(clearanceOf(shown(412_50), { ...ready(), stamp: "new999", status: "pending", cleared: {} }, "abc123").state).toBe("verifying");
  });

  it("withholds a figure whose shown value differs from the cleared one, giving both", () => {
    const c = clearanceOf(shown(999_00), ready(), "abc123");
    expect(c).toMatchObject({ state: "withheld", reason: "mismatch", shown: { cents: 999_00 }, cleared: { cents: 412_50 } });
  });

  it("holds a rate or words to the cleared value like cents", () => {
    const rate = { descriptor, shownCents: null, shown: { ratio: 0.25 } };
    expect(clearanceOf(rate, ready({ cleared: { [key]: { ratio: 0.25 } } }), "abc123").state).toBe("cleared");
    expect(clearanceOf(rate, ready({ cleared: { [key]: { ratio: 0.3 } } }), "abc123")).toMatchObject({ state: "withheld", reason: "mismatch" });
  });

  it("withholds when the sweep ran on other data than the page shows", () => {
    expect(clearanceOf(shown(412_50), ready(), "def456")).toMatchObject({ state: "withheld", reason: "stale" });
    // A page whose data carries no stamp can't be vouched for.
    expect(clearanceOf(shown(412_50), ready(), null)).toMatchObject({ state: "withheld", reason: "stale" });
  });

  it("withholds every figure when the sweep failed or there is none", () => {
    expect(clearanceOf(shown(412_50), sweepAnswer(null, null, "Failed to fetch"), "abc123")).toMatchObject({ state: "withheld", reason: "failed" });
    expect(clearanceOf(shown(412_50), sweepAnswer(503, { error: "The proof sweep stopped" }), "abc123")).toMatchObject({ state: "withheld", reason: "failed" });
    expect(clearanceOf(shown(412_50), NO_SWEEP, "abc123")).toMatchObject({ state: "withheld", reason: "failed" });
  });

  it("withholds a figure the sweep never cleared, or flagged", () => {
    expect(clearanceOf(shown(412_50), ready({ cleared: {} }), "abc123")).toMatchObject({ state: "withheld", reason: "not-cleared" });
    const flagged = ready({ cleared: {}, problems: { [key]: [{ kind: "DIFFERS", page: "Cash flow", descriptor, detail: "the page shows 1, the proof 2" }] } });
    expect(clearanceOf(shown(412_50), flagged, "abc123")).toMatchObject({ state: "withheld", reason: "flagged" });
  });

  it("withholds a blocked figure, cleared or not, and says what blocks it", () => {
    const c = clearanceOf(shown(412_50), ready(), "abc123", [blocker]);
    expect(c).toMatchObject({ state: "withheld", reason: "blocked", blockers: [blocker] });
    expect(clearanceOf(unswept("no recipe"), ready(), "abc123", [blocker])).toMatchObject({ state: "withheld", reason: "blocked" });
  });

  it("withholds an unswept figure whatever the sweep says", () => {
    expect(clearanceOf(unswept("worked out in the browser"), ready(), "abc123")).toMatchObject({ state: "withheld", reason: "unswept", key: null });
  });

  it("carries an estimate or accepted exception through to the page", () => {
    expect(clearanceOf(shown(412_50), ready({ basis: { [key]: "estimate" } }), "abc123")).toMatchObject({ state: "cleared", basis: "estimate" });
    expect(clearanceOf(shown(412_50), ready({ basis: { [key]: "accepted" } }), "abc123")).toMatchObject({ state: "cleared", basis: "accepted" });
  });
});

describe("sweepAnswer: one answer of the sweep route as the browser's state", () => {
  it("reads 202 as pending for that data, 200 as the verdicts", () => {
    expect(sweepAnswer(202, { status: "pending", stamp: "abc123" })).toMatchObject({ stamp: "abc123", status: "pending" });
    expect(sweepAnswer(200, { stamp: "abc123", cleared: {}, basis: {}, problems: {} })).toMatchObject({ stamp: "abc123", status: "ready" });
  });

  it("treats no answer, an error status or a malformed report as failed, never as nothing flagged", () => {
    expect(sweepAnswer(null, null).status).toBe("failed");
    expect(sweepAnswer(500, { error: "boom" })).toMatchObject({ status: "failed", error: "boom" });
    expect(sweepAnswer(200, { problems: [] }).status).toBe("failed");
    expect(sweepAnswer(202, {}).status).toBe("failed");
  });
});

describe("composite clearance: a share, change or sum clears from its parts' cleared values", () => {
  const a = { report: "row", rowId: "a" } as const;
  const b = { report: "row", rowId: "b" } as const;
  const cleared = { [descriptorKey(a)]: { cents: 250_00 }, [descriptorKey(b)]: { cents: 1000_00 } };
  const share = (ratio: number) => ({ descriptor: { report: "composite", op: "share", of: [a, b] } as const, shownCents: null, shown: { ratio } });
  it("clears at the value its parts work out to, never the page's", () => {
    expect(clearanceOf(share(0.25), ready({ cleared }), "abc123")).toMatchObject({ state: "cleared", cleared: { ratio: 0.25 } });
    expect(clearanceOf(share(0.3), ready({ cleared }), "abc123")).toMatchObject({ state: "withheld", reason: "mismatch" });
  });
  it("is withheld while a part hasn't cleared, or is flagged", () => {
    expect(clearanceOf(share(0.25), ready({ cleared: { [descriptorKey(a)]: { cents: 250_00 } } }), "abc123")).toMatchObject({ state: "withheld", reason: "not-cleared" });
    const flagged = ready({ cleared, problems: { [descriptorKey(b)]: [{ kind: "DIFFERS", page: "Example", descriptor: b, detail: "off" }] } });
    expect(clearanceOf(share(0.25), flagged, "abc123")).toMatchObject({ state: "withheld", reason: "flagged" });
  });
  it("works out a change and a sum", () => {
    const diff = { descriptor: { report: "composite", op: "diff", of: [b, a] } as const, shownCents: 750_00 };
    expect(clearanceOf(diff, ready({ cleared }), "abc123")).toMatchObject({ state: "cleared", cleared: { cents: 750_00 } });
  });

  it("shows a calculator figure on typed inputs when the sweep cleared its model on the saved ones", () => {
    const saved = { report: "planning", page: "home", figure: "max-price", inputs: { annualMortgageRate: 0.06 } } as const;
    const typed = { ...saved, inputs: { annualMortgageRate: 0.05 } };
    const model = '{"figure":"max-price","page":"home","report":"planning"}';
    const s = ready({ cleared: { [descriptorKey(saved)]: { cents: 500_000_00 } }, models: { [model]: true } });
    expect(clearanceOf({ descriptor: typed as never, shownCents: 560_000_00 }, s, "abc123")).toMatchObject({ state: "cleared", cleared: { cents: 560_000_00 } });
    // A share of two typed-input figures stands on them too.
    const share = { descriptor: { report: "composite", op: "share", of: [typed, { ...typed, figure: "salary" }] } as never, shownCents: null, shown: { ratio: 0.3 } };
    expect(clearanceOf(share, ready({ models: { [model]: true, [model.replace("max-price", "salary")]: true } }), "abc123").state).toBe("cleared");
    // A model the sweep found broken withholds every figure of it.
    expect(clearanceOf({ descriptor: typed as never, shownCents: 560_000_00 }, ready({ models: { [model]: false } }), "abc123")).toMatchObject({ state: "withheld", reason: "not-cleared" });
    // Ledger figures never stand on a model: only the sweep's own verdict clears them.
    expect(clearanceOf(shown(1_00), ready({ cleared: {}, models: { [model]: true } }), "abc123")).toMatchObject({ state: "withheld", reason: "not-cleared" });
  });
});
