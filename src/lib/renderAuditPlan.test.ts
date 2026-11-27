import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Replayer } from "../../scripts/render-audit-cache.ts";
import type { RawView, UnitRun } from "../../scripts/render-audit-drive.ts";
import { deal, firstDiff, mergeParts, withParts, type Cost } from "../../scripts/render-audit-plan.ts";

const view = (name: string, keys: string[], extra: Partial<RawView> = {}): RawView => ({
  view: name,
  figures: keys.map((key) => ({ key, shown: "100", shownKind: "cents", perMonths: null, clearance: "cleared", text: "$1.00" })),
  strays: [],
  errors: [],
  ...extra,
});
const run = (route: string, part: { i: number; n: number } | null, views: RawView[], more: Partial<UnitRun> = {}): UnitRun => ({ route, tab: null, part, views, ms: 1000, draws: views.length, repeats: 0, drawers: 0, ...more });

describe("withParts", () => {
  const o = { workers: 2, shards: 1, split: true, minPartMs: 8_000, maxParts: 6 };
  const tabs: Cost[] = [
    { route: "/big", tab: null, ms: 60_000 },
    { route: "/small", tab: null, ms: 4_000 },
  ];

  it("splits a tab costing more than its share (the run's work over every worker, twice over) into parts, busiest first", () => {
    // 64 s over 2 workers × 2 = 16 s a part: /big in 4, /small whole.
    const units = withParts(tabs, o);
    expect(units.map((u) => [u.route, u.part])).toEqual([
      ["/big", { i: 0, n: 4 }],
      ["/big", { i: 1, n: 4 }],
      ["/big", { i: 2, n: 4 }],
      ["/big", { i: 3, n: 4 }],
      ["/small", null],
    ]);
    expect(units[0]!.ms).toBe(15_000);
  });

  it("never splits below the smallest part, past the most parts, or when told not to; a forced count wins", () => {
    expect(withParts([{ route: "/a", tab: null, ms: 7_000 }], o).map((u) => u.part)).toEqual([null]);
    expect(withParts([{ route: "/a", tab: null, ms: 10_000_000 }, { route: "/b", tab: null, ms: 1 }], { ...o, workers: 1000 }).filter((u) => u.route === "/a")).toHaveLength(6);
    expect(withParts(tabs, { ...o, split: false }).every((u) => !u.part)).toBe(true);
    expect(withParts(tabs, o, new Map([[JSON.stringify(["/big", null, null]), 2]])).filter((u) => u.route === "/big")).toHaveLength(2);
  });

  it("deals the same plan to every shard, each part once", () => {
    const units = withParts(tabs, { ...o, shards: 2 });
    const shards = deal(units, 2);
    expect(shards.flat()).toHaveLength(units.length);
    expect(deal(units, 2)).toEqual(shards);
  });
});

describe("mergeParts", () => {
  it("puts a split tab back whole: views in part order, a view two parts drew kept once with both its drawers, the tab list part 0 read", () => {
    const base = (drawer: string) => view("/p", ["a"], { rawDrawers: [{ key: drawer, tokens: [], proof: {}, perMonths: null }] });
    const merged = mergeParts([
      run("/p", { i: 1, n: 2 }, [base("d2"), view("/p · x=2", ["c"])], { drawers: 1 }),
      run("/p", { i: 0, n: 2 }, [base("d1"), view("/p · x=1", ["b"])], { tabs: [{ route: "/p", tab: { id: "t", label: "T" } }], drawers: 1 }),
    ]);
    expect(merged).toHaveLength(1);
    const m = merged[0]!;
    expect(m.views.map((v) => v.view)).toEqual(["/p", "/p · x=1", "/p · x=2"]);
    expect(m.views[0]!.rawDrawers!.map((d) => d.key)).toEqual(["d1", "d2"]);
    expect(m.tabs).toEqual([{ route: "/p", tab: { id: "t", label: "T" } }]);
    expect([m.ms, m.drawers, m.part]).toEqual([2000, 2, { i: 0, n: 2 }]);
  });

  it("says so when a part is missing, and leaves a tab that wasn't split as it was", () => {
    const [m] = mergeParts([run("/p", { i: 0, n: 3 }, [view("/p", ["a"])])]);
    expect(m!.views.at(-1)!.errors[0]).toMatch(/Part\(s\) 2\/3, 3\/3 of this tab weren't audited/);
    const whole = run("/q", null, [view("/q", ["a"])]);
    expect(mergeParts([whole])[0]).toBe(whole);
  });
});

describe("firstDiff", () => {
  const kept = run("/p", null, [view("/p", ["a"], { rawDrawers: [{ key: "a", tokens: ["$1.00"], proof: { stamp: "0123456789ab" }, perMonths: null }] })]);

  it("is null for the same drawing, reading past the data stamp a proof carries", () => {
    const fresh = run("/p", null, [view("/p", ["a"], { rawDrawers: [{ key: "a", tokens: ["$1.00"], proof: { stamp: "fedcba987654" }, perMonths: null }] })]);
    expect(firstDiff(fresh, "fedcba987654", kept, "0123456789ab")).toBeNull();
  });

  it("names the view and what of it differs, down to the drawer", () => {
    expect(firstDiff(run("/p", null, [view("/p", ["b"])]), "fedcba987654", kept, "0123456789ab")).toBe('"/p" differs in figures, drawers');
    const empty = run("/p", null, [view("/p", ["a"], { rawDrawers: [{ key: "a", tokens: [], proof: { stamp: "fedcba987654" }, perMonths: null }] })]);
    expect(firstDiff(empty, "fedcba987654", kept, "0123456789ab")).toBe('"/p" differs in drawer 1 of 1 (its tokens: 0 drawn now, 1 kept)');
    expect(firstDiff(run("/p", null, []), "fedcba987654", kept, "0123456789ab")).toBe("a view fewer than kept: /p");
  });
});

describe("Replayer", () => {
  let server: Server;
  let base = "";
  let body = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader("content-type", req.url?.startsWith("/api/") ? "application/json" : "text/x-component");
      res.end(body.replaceAll("~ORIGIN~", base));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());
  const digest = async (url: string, text: string, stamps = ["stamp1234567", "BUILD-ID"]) => {
    body = text;
    return new Replayer(base, stamps).digest({ method: "GET", url, headers: {} });
  };

  it("reads past the data stamp, the build's id, this server's address, Next's per-request id and the sweep's timings", async () => {
    const rsc = (id: string, stamp: string, build: string) => `0:{"b":"${build}","s":"${stamp}"}\n["$","$L5","${id}v",{"children":"$L6"}],["$","$L8","${id}m"] ~ORIGIN~/x`;
    expect(await digest("/x", rsc("aaaaaaaaaaaaaaaaaaaaa", "stamp1234567", "BUILD-ID"))).toBe(await digest("/x", rsc("bbbbbbbbbbbbbbbbbbbbb", "stampABCDEFG", "OTHER-ID"), ["stampABCDEFG", "OTHER-ID"]));
    const sweep = (ms: number) => JSON.stringify({ stamp: "s", ms, pages: [{ page: "Home", figures: 3, ms, linkMs: ms }] });
    expect(await digest("/api/proof/sweep", sweep(5))).toBe(await digest("/api/proof/sweep", sweep(9)));
  });

  it("counts everything else, byte for byte", async () => {
    expect(await digest("/x", '{"value":100}')).not.toBe(await digest("/x", '{"value":101}'));
    // Timings are read past only in the sweep's own answer.
    expect(await digest("/api/report", '{"ms":1}')).not.toBe(await digest("/api/report", '{"ms":2}'));
  });
});
