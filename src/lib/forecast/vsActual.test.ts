import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { vsActualDerived } from "../book/derived/forecast";
import type { NetWorthChange } from "../book/reports/netWorthChanges";
import type { Forecast } from "./forecast";
import { keepForecast, readForecastSnapshots } from "./snapshots";
import { forecastVsActual, leaning, snapshotOf, type ForecastSnapshot } from "./vsActual";

// Invented months and a made-up forecast.
const month = (key: string, cents: number, through: string | null = null): NetWorthChange =>
  ({ start: `${key}-01`, end: `${key}-28`, through, incomeCents: cents, spendingCents: cents / 2, savedCents: cents / 4, marketsCents: cents / 10, changeCents: cents / 3, proofs: { income: { report: "x", k: key }, spending: {}, saved: {}, markets: {}, change: {} } }) as unknown as NetWorthChange;
const snap = (keys: string[], v: number): ForecastSnapshot => ({ id: "s1", savedAt: "2025-12-31T00:00:00.000Z", reason: "test", startKey: "2025-12", months: keys.map((key) => ({ key, income: v, spending: v, saved: v, markets: v, change: v })) });
const forecast = (vals: number[]) =>
  ({ startKey: "2025-12", months: vals.map((v, i) => ({ key: `2026-${String(i + 1).padStart(2, "0")}`, takeHome: v, bonusKept: 0, bonusSaved: 0, livingCost: v / 2, planned: 0, saved: v / 2, growth: 10, netWorth: 1_000 + i * 100 })) }) as unknown as Forecast;

describe("forecast vs actual", () => {
  it("holds a kept forecast to the proven months it projected, and says which way it leans", () => {
    const [v] = forecastVsActual([snap(["2026-01", "2026-02", "2026-03"], 1_200)], [month("2026-01", 1_000), month("2026-02", 1_100), month("2026-03", 1_300)]);
    const income = v!.rows.find((r) => r.line === "income")!;
    expect([v!.from, v!.through, v!.months]).toEqual(["2026-01", "2026-03", 3]);
    expect([income.forecastCents, income.actualCents, income.missCents, income.high]).toEqual([3_600, 3_400, 200, 2]);
    expect(leaning(income)).toBe("high overall; above in 2 of 3 months");
    expect(leaning({ high: 0, months: [1] as never, missCents: -500 })).toBe("low overall; above in 0 of 1 month");
    expect(leaning({ high: 1, months: [1, 2] as never, missCents: 40 })).toBe("on the mark overall; above in 1 of 2 months");
  });

  it("compares nothing before a proven month, and stops at a gap or a month cut short", () => {
    expect(forecastVsActual([], [month("2026-01", 1)])).toEqual([]);
    expect(forecastVsActual([snap(["2026-07"], 1)], [month("2026-01", 1)])).toEqual([]);
    const [v] = forecastVsActual([snap(["2026-01", "2026-02", "2026-03"], 1)], [month("2026-01", 1), month("2026-03", 1), month("2026-02", 1, "2026-02-10")]);
    expect(v!.months).toBe(1);
  });

  it("keeps a forecast as it was, and only when it moved", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "snaps-")), "forecast-snapshots.json");
    expect(readForecastSnapshots(file)).toEqual([]);
    expect(keepForecast(forecast([500, 600]), { reason: "a", file })).not.toBeNull();
    expect(keepForecast(forecast([500, 600]), { reason: "b", file })).toBeNull();
    expect(keepForecast(forecast([500, 600]), { reason: "c", file, always: true })).not.toBeNull();
    expect(keepForecast(forecast([500, 700]), { reason: "d", file })).not.toBeNull();
    expect(readForecastSnapshots(file).map((s) => s.reason)).toEqual(["a", "c", "d"]);
    writeFileSync(file, "{");
    expect(() => readForecastSnapshots(file)).toThrow(/damaged/);
  });

  it("reads each projected month as its lines", () => {
    const s = snapshotOf(forecast([500, 600]), "2026-01-01T00:00:00.000Z", "x");
    expect(s.months[0]).toEqual({ key: "2026-01", income: 500, spending: 250, saved: 250, markets: 10, change: 260 });
    expect(s.months[1]!.change).toBe(100);
  });

  it("states projected, actual and the miss, each adding up", () => {
    const vs = forecastVsActual([snap(["2026-01", "2026-02"], 1_000)], [month("2026-01", 900), month("2026-02", 1_200)]);
    const d = vsActualDerived(vs).filter((f) => f.key === "s1|income");
    expect(d.map((f) => [f.figure, f.value])).toEqual([
      ["vs-forecast", { cents: 2_000 }],
      ["vs-actual", { cents: 2_100 }],
      ["vs-miss", { cents: -100 }],
    ]);
    expect(d[1]!.lines[0]!.link?.descriptor).toEqual({ report: "x", k: "2026-01" });
  });
});
