import { describe, expect, it } from "vitest";
import type { PageFigure } from "./figures";
import type { ProofDescriptor } from "./index";
import { judgeFigures, type SweepReport } from "./sweep";
import { trustOf } from "./trust";
import type { Proof, ProofGroup } from "./types";

const month = (i: number): ProofDescriptor => ({ report: "cash-flow", metric: "spending", granularity: "month", start: `2031-0${i}-01`, end: `2031-0${i}-28`, category: `Category ${i}` }) as ProofDescriptor;

/** A made-up statement of a made-up account, ending on `end`. */
const group = (id: string, account: string, end: string): ProofGroup => ({
  statement: { id, account, institution: null, periodStart: `${end.slice(0, 8)}01`, periodEnd: end, documentTitle: "example.pdf", status: "OK" },
  subtotalCents: 100,
  rows: [],
});

const proofOf = (d: ProofDescriptor, over: Partial<Proof> = {}): Proof => ({
  report: d.report,
  descriptor: d,
  describes: "A made-up figure",
  figure: { cents: 100 },
  selfCheck: null,
  withheld: false,
  blocks: [],
  checks: [],
  estimates: [],
  through: "2031-04-30",
  today: "2031-05-02",
  ...over,
});

describe("how far to trust the figures", () => {
  it("reads the sweep's own counts, and finds the account whose latest statement is oldest", async () => {
    const figures: PageFigure[] = [1, 2, 3, 4].map((i) => ({ page: "Cash flow", descriptor: month(i), shown: { cents: i === 4 ? 1 : 100 } }));
    const proofs: Record<string, Partial<Proof>> = {
      "Category 1": { blocks: [{ kind: "rows", title: "Rows", figureCents: 100, groups: [group("s1", "Example Card ••1234", "2031-03-31"), group("s2", "Example Card ••1234", "2031-04-30")] }], rederived: { routes: [{ route: "balances", value: { cents: 100 }, ok: true, explain: "" }] } },
      "Category 2": { blocks: [{ kind: "rows", title: "Rows", figureCents: 100, groups: [group("s3", "Springfield Savings ••5678", "2031-02-28")] }], estimates: [{ id: "e", title: "An estimate", detail: "made up" }] },
      "Category 3": { rederived: { none: "a typed input" } },
    };
    const built = await judgeFigures(figures, async (d) => proofOf(d, proofs[(d as { category: string }).category] ?? {}), { followLinks: false });
    const t = trustOf({ ...built, stamp: "s", today: "2031-05-02", ms: 1 } as SweepReport);
    expect(t).toMatchObject({ figures: 4, cleared: 3, rederived: 1, declared: 1, estimates: 1, accepted: 0, problems: 1, today: "2031-05-02" });
    expect(t.rederived + t.declared + t.ownRoute + t.unchecked).toBe(t.figures);
    // The figure that differs from its proof isn't cleared, so its statements aren't counted as sources.
    expect(t.sources).toEqual({ statements: 3, accounts: 2, oldest: { account: "Springfield Savings ••5678", through: "2031-02-28" } });
  });

  it("says nothing about sources for a sweep kept from before they were counted", () => {
    const old = { figures: 0, cleared: {}, basis: {}, independence: { rederived: 0, declared: 0, "own-route": 0, unchecked: 0 }, problemCount: 0, skipped: [], today: "2031-05-02" } as unknown as SweepReport;
    expect(trustOf(old).sources).toBeNull();
  });
});
