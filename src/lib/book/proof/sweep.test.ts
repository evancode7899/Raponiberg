import { describe, expect, it } from "vitest";
import type { Book } from "../load";
import { perBook } from "./common";
import type { PageFigure } from "./figures";
import type { ProofDescriptor } from "./index";
import { descriptorKey } from "./key";
import { blockedTaxYearSkip, droppedCalendarYears, judgeFigures, LISTED, noForecastSkip } from "./sweep";
import type { Proof } from "./types";

describe("descriptorKey", () => {
  it("is the same whatever order the keys come in, nested objects included", () => {
    const a = { report: "planning", page: "fire", figure: "fire-number", fire: { withdrawalRate: 0.04, retirementAge: 55, walkAwayYear: null, stateTaxRate: null } };
    const b = { fire: { stateTaxRate: null, walkAwayYear: null, retirementAge: 55, withdrawalRate: 0.04 }, figure: "fire-number", page: "fire", report: "planning" };
    expect(descriptorKey(a)).toBe(descriptorKey(b));
  });

  it("tells apart descriptors that differ only inside a nested object or an array", () => {
    expect(descriptorKey({ report: "planning", fire: { retirementAge: 55 } })).not.toBe(descriptorKey({ report: "planning", fire: { retirementAge: 60 } }));
    expect(descriptorKey({ report: "net-worth", accountIds: ["a", "b"] })).not.toBe(descriptorKey({ report: "net-worth", accountIds: ["b", "a"] }));
  });

  it("ignores keys left undefined, as JSON would", () => {
    expect(descriptorKey({ report: "investments", accountId: undefined })).toBe(descriptorKey({ report: "investments" }));
  });
});

describe("perBook", () => {
  const book = {} as Book;
  const db = {} as never;

  it("works a value out once per Book and database, and freezes it", async () => {
    let runs = 0;
    const work = () => ({ runs: ++runs, rows: [1, 2, 3] });
    const a = await perBook({ book, db }, "report", work);
    const b = await perBook({ book, db }, "report", work);
    expect(a).toBe(b);
    expect(runs).toBe(1);
    expect(() => (a.rows as number[]).sort((x, y) => y - x)).toThrow();
  });

  it("starts afresh for a new Book or another database", async () => {
    let runs = 0;
    const work = () => ++runs;
    await perBook({ book, db }, "count", work);
    await perBook({ book: {} as Book, db }, "count", work);
    await perBook({ book, db: {} as never }, "count", work);
    expect(runs).toBe(3);
  });

  it("doesn't keep a failed load", async () => {
    let runs = 0;
    const fail = () => {
      runs++;
      throw new Error("settings unreadable");
    };
    await expect(perBook({ book, db }, "flaky", fail)).rejects.toThrow("settings unreadable");
    await expect(perBook({ book, db }, "flaky", fail)).rejects.toThrow("settings unreadable");
    expect(runs).toBe(2);
  });
});

describe("judgeFigures: every verdict, none dropped", () => {
  const proofOf = (d: ProofDescriptor, cents: number, over: Partial<Proof> = {}): Proof => ({
    report: d.report,
    descriptor: d,
    describes: "A made-up figure",
    figure: { cents },
    selfCheck: null,
    withheld: false,
    blocks: [],
    checks: [],
    estimates: [],
    through: "2031-03-31",
    today: "2031-04-02",
    ...over,
  });
  const month = (i: number): ProofDescriptor => ({ report: "cash-flow", metric: "spending", granularity: "month", start: `2031-${String((i % 12) + 1).padStart(2, "0")}-01`, end: `2031-${String((i % 12) + 1).padStart(2, "0")}-28`, category: `Category ${i}` }) as ProofDescriptor;

  it("keeps a verdict for every figure past any cap: 700 that differ and 300 that tie", async () => {
    const figures: PageFigure[] = Array.from({ length: 1000 }, (_, i) => ({ page: "Cash flow", descriptor: month(i), shown: { cents: i < 700 ? 1 : 100 } }));
    const r = await judgeFigures(figures, async (d) => proofOf(d, 100), { followLinks: false });
    expect(r.problemCount).toBe(700);
    expect(Object.keys(r.problems)).toHaveLength(700);
    expect(Object.keys(r.cleared)).toHaveLength(300);
    // Only the listing for people is cut short.
    expect(r.listing).toHaveLength(LISTED);
    for (const f of figures.slice(0, 700)) expect(r.cleared[descriptorKey(f.descriptor)]).toBeUndefined();
    for (const f of figures.slice(700)) expect(r.cleared[descriptorKey(f.descriptor)]).toEqual({ cents: 100 });
  });

  it("clears no figure with a problem on any page that shows it, nor one an open finding withholds", async () => {
    const d = month(1);
    const twice: PageFigure[] = [
      { page: "Cash flow", descriptor: d, shown: { cents: 100 } },
      { page: "Home", descriptor: d, shown: { cents: 101 } },
    ];
    expect(Object.keys((await judgeFigures(twice, async (x) => proofOf(x, 100), { followLinks: false })).cleared)).toHaveLength(0);
    const held = await judgeFigures([{ page: "Cash flow", descriptor: d, shown: null }], async (x) => proofOf(x, 100, { withheld: true }), { followLinks: false });
    expect(held.cleared).toEqual({});
    const broken = await judgeFigures([{ page: "Cash flow", descriptor: d, shown: null }], async () => new Error("no such account"), { followLinks: false });
    expect(broken.cleared).toEqual({});
    expect(broken.problems[descriptorKey(d)]![0]!.kind).toBe("ERROR");
  });

  it("marks cleared figures that rest on an estimate or an accepted exception", async () => {
    const [a, b] = [month(1), month(2)];
    const r = await judgeFigures(
      [
        { page: "Cash flow", descriptor: a, shown: { cents: 100 } },
        { page: "Cash flow", descriptor: b, shown: { cents: 100 } },
      ],
      async (d) =>
        d === a
          ? proofOf(d, 100, { estimates: [{ id: "e", title: "Estimated", detail: "spread" }] })
          : proofOf(d, 100, { checks: [{ id: "balance-chain" as never, title: "t", description: "d", state: "accepted", passed: 0, subjects: [], open: [], accepted: [] }] }),
      { followLinks: false },
    );
    expect(r.basis).toEqual({ [descriptorKey(a)]: "estimate", [descriptorKey(b)]: "accepted" });
  });

  it("files a page that couldn't be built under the page, and lists skips apart from problems", async () => {
    const r = await judgeFigures([], async (d) => proofOf(d, 0), {
      errors: [{ kind: "ERROR", page: "Goals", descriptor: null, detail: "Couldn't build" }],
      skipped: [noForecastSkip()],
      followLinks: false,
    });
    expect(r.problems["page:Goals"]).toHaveLength(1);
    expect(r.problemCount).toBe(1);
    expect(r.skipped).toEqual([noForecastSkip()]);
  });
});

describe("silent skips are logged", () => {
  it("logs a blocked Taxes year with what blocks it", () => {
    const s = blockedTaxYearSkip(2031, [{ title: "Example Payroll: December stub missing" }]);
    expect(s).toMatchObject({ kind: "SKIPPED", page: "Taxes 2031" });
    expect(s.detail).toContain("Example Payroll: December stub missing");
  });

  it("logs a missing forecast", () => {
    expect(noForecastSkip()).toMatchObject({ kind: "SKIPPED", page: "Forecast" });
  });

  it("logs each calendar year dropped for a report it couldn't build", () => {
    const skips = droppedCalendarYears([{ year: 2030, tax: {} as never, accounts: {} as never }, { year: 2031, accounts: {} as never }, { year: 2032 }]);
    expect(skips.map((s) => s.detail.slice(0, 4))).toEqual(["2031", "2032"]);
    expect(skips.every((s) => s.kind === "SKIPPED" && s.page === "Calendar")).toBe(true);
  });
});
