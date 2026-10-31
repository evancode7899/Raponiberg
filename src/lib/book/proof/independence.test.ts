import { describe, expect, it } from "vitest";
import type { DerivedList } from "../derived/load";
import { c, derivedDescriptor, ln, type DerivedFigure } from "../derived/types";
import type { Book } from "../load";
import { clearanceOf, type SweepState } from "./clearance";
import { perBook } from "./common";
import { buildDerivedProof } from "./derivedProof";
import type { PageFigure } from "./figures";
import type { ProofDescriptor } from "./index";
import { failedRoutes, independenceOf, invariant, route, sameRoute } from "./independence";
import { descriptorKey } from "./key";
import { judgeFigures } from "./sweep";
import type { Proof, Rederivation } from "./types";

describe("sameRoute: which proofs re-run the page's own report or model", () => {
  it("is every derived figure and the F4 planning models", () => {
    expect(sameRoute({ report: "derived", page: "investments", figure: "fund-costs" })).toBe(true);
    expect(sameRoute({ report: "planning", page: "annual-estimate", line: "saved" })).toBe(true);
    expect(sameRoute({ report: "planning", page: "fire", figure: "plan-cell", row: "nw", col: "2031" })).toBe(true);
    expect(sameRoute({ report: "planning", page: "fire", figure: "stress", metric: "p50", volatility: 0.15 })).toBe(true);
    expect(sameRoute({ report: "planning", page: "home", figure: "rvb-ahead" })).toBe(true);
  });

  it("isn't a proof kind that re-adds the Book itself", () => {
    expect(sameRoute({ report: "planning", page: "fire", figure: "fire-number" })).toBe(false);
    expect(sameRoute({ report: "planning", page: "home", figure: "cash" })).toBe(false);
    expect(sameRoute({ report: "cash-flow", metric: "spending", granularity: "month", start: "2031-03-01", end: "2031-03-31" } as ProofDescriptor)).toBe(false);
  });
});

describe("routes and invariants", () => {
  it("holds money to the cent unless a tolerance is given", () => {
    expect(route("statement rows", { cents: 12_345 }, { cents: 12_345.4 }, "re-added").ok).toBe(true);
    expect(route("statement rows", { cents: 12_345 }, { cents: 12_346 }, "re-added").ok).toBe(false);
    expect(route("closed form", { cents: 12_345 }, { cents: 12_346 }, "annuity", { tolerance: { cents: 1 } }).ok).toBe(true);
  });

  it("holds ratios to 1e-9 unless told otherwise, and words exactly", () => {
    expect(route("a", { ratio: 0.25 }, { ratio: 0.25 + 1e-12 }, "x").ok).toBe(true);
    expect(route("a", { ratio: 0.25 }, { ratio: 0.2501 }, "x").ok).toBe(false);
    expect(route("a", { ratio: 0.25 }, { ratio: 0.2501 }, "x", { tolerance: { ratio: 1e-3 } }).ok).toBe(true);
    expect(route("a", { text: "3" }, { text: "3" }, "x").ok).toBe(true);
    expect(route("a", { cents: 300 }, { text: "3" }, "x").ok).toBe(false);
  });

  it("an invariant carries the figure and whether it holds", () => {
    expect(invariant("p10 ≤ p50 ≤ p90", { cents: 5 }, false, "bands out of order")).toEqual({ route: "p10 ≤ p50 ≤ p90", value: { cents: 5 }, ok: false, explain: "bands out of order" });
  });

  it("lists only the routes that fail, in words", () => {
    const p = { describes: "Fund expenses a year", figure: { cents: 41_000 }, rederived: { routes: [route("the holdings", { cents: 41_000 }, { cents: 41_000 }, "ok"), route("the statements", { cents: 41_000 }, { cents: 39_500 }, "value × ratio")] } };
    expect(failedRoutes(p)).toEqual(["Fund expenses a year: by the statements it comes to 395.00, the page's report to 410.00 (value × ratio)."]);
    expect(failedRoutes({ ...p, rederived: { none: "A seeded simulation." } })).toEqual([]);
  });

  it("tells how a figure stands apart from its page's report", () => {
    const derived: ProofDescriptor = { report: "derived", page: "car", figure: "mpg", key: "car-1" };
    expect(independenceOf(derived, {})).toBe("unchecked");
    expect(independenceOf(derived, { rederived: { routes: [] } })).toBe("unchecked");
    expect(independenceOf(derived, { rederived: { none: "Typed on the page." } })).toBe("declared");
    expect(independenceOf(derived, { rederived: { routes: [route("fill-ups", { ratio: 30 }, { ratio: 30 }, "miles ÷ gallons")] } })).toBe("rederived");
    expect(independenceOf({ report: "planning", page: "goals", figure: "current" }, {})).toBe("own-route");
  });
});

describe("the sweep holds a figure to its second route", () => {
  const d = (figure: string): ProofDescriptor => ({ report: "derived", page: "investments", figure });
  const proofOf = (desc: ProofDescriptor, cents: number, rederived?: Rederivation): Proof => ({
    report: desc.report,
    descriptor: desc,
    describes: `A made-up ${(desc as { figure: string }).figure}`,
    figure: { cents },
    selfCheck: null,
    ...(rederived ? { rederived } : {}),
    withheld: false,
    blocks: [],
    checks: [],
    estimates: [],
    through: "2031-03-31",
    today: "2031-04-02",
  });

  it("catches a wrong report the page and its proof agree on: REDERIVE withholds it", async () => {
    // The planted bug: the report says $500.00, so page and proof both show it (no DIFFERS); the rows say $480.00.
    const wrong = d("fund-costs");
    const right = d("account-fees");
    const figures: PageFigure[] = [
      { page: "Investments", descriptor: wrong, shown: { cents: 50_000 } },
      { page: "Investments", descriptor: right, shown: { cents: 12_000 } },
    ];
    const proofs = new Map<string, Proof>([
      [descriptorKey(wrong), proofOf(wrong, 50_000, { routes: [route("re-added from the holdings", { cents: 50_000 }, { cents: 48_000 }, "each fund's value × its ratio")] })],
      [descriptorKey(right), proofOf(right, 12_000, { routes: [route("re-added from the statements", { cents: 12_000 }, { cents: 12_000 }, "fee rows")] })],
    ]);
    const r = await judgeFigures(figures, async (x) => proofs.get(descriptorKey(x))!);
    expect(r.problems[descriptorKey(wrong)]?.map((p) => p.kind)).toEqual(["REDERIVE"]);
    expect(r.cleared[descriptorKey(wrong)]).toBeUndefined();
    expect(r.cleared[descriptorKey(right)]).toEqual({ cents: 12_000 });
    expect(r.independence).toEqual({ rederived: 2, declared: 0, "own-route": 0, unchecked: 0 });
    expect(r.pages[0]).toMatchObject({ page: "Investments", figures: 2, problems: 1, independence: { rederived: 2 } });

    const state: SweepState = { stamp: "s1", status: "ready", cleared: r.cleared, basis: r.basis, problems: r.problems };
    expect(clearanceOf({ descriptor: wrong, shownCents: 50_000 }, state, "s1")).toMatchObject({ state: "withheld", reason: "flagged" });
  });

  it("clears a figure that declares no second route, and tallies the ones still on their own route", async () => {
    const declared = d("growth-value");
    const bare = d("stocks");
    const own: ProofDescriptor = { report: "planning", page: "goals", figure: "current", goalId: "g1" };
    const figures: PageFigure[] = [declared, bare, own].map((descriptor) => ({ page: "Investments", descriptor, shown: { cents: 100 } }));
    const r = await judgeFigures(figures, async (x) => (descriptorKey(x) === descriptorKey(declared) ? proofOf(x, 100, { none: "As the statement prints it." }) : proofOf(x, 100)));
    expect(r.problemCount).toBe(0);
    expect(Object.keys(r.cleared)).toHaveLength(3);
    expect(r.independence).toEqual({ rederived: 0, declared: 1, "own-route": 1, unchecked: 1 });
  });
});

describe("a derived proof carries the re-derivation its page's loader worked out", () => {
  const book = { today: "2031-04-02" } as Book;
  const ctx = { book, db: {} as never };
  const fig = (figure: string, cents: number): DerivedFigure => ({ figure, key: "car-1", describes: `Made-up ${figure}`, value: c(cents), lines: [ln("Made up", c(cents))] });

  it("by the figure and its key, and leaves the rest without one", async () => {
    const rederived: Record<string, Rederivation> = { "cash-out-the-door|car-1": { routes: [route("the car's rows", { cents: 900 }, { cents: 900 }, "re-added")] } };
    const list: DerivedList = { figures: [fig("cash-out-the-door", 900), fig("prepaid", 50)], scope: null, through: "2031-03-31", rederived };
    await perBook(ctx, "derived:car", () => list);
    const a = await buildDerivedProof(ctx, derivedDescriptor("car", { figure: "cash-out-the-door", key: "car-1" }));
    const b = await buildDerivedProof(ctx, derivedDescriptor("car", { figure: "prepaid", key: "car-1" }));
    expect(a.rederived).toEqual(rederived["cash-out-the-door|car-1"]);
    expect(b.rederived).toBeUndefined();
  });
});
