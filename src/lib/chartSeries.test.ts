import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chartTable, lastIndexWith, spreadLabels, withCompare, zoomWindow } from "./chartSeries";

describe("the shared chart pieces", () => {
  it("lays the same time before beside each point, null where history is short", () => {
    const rows = [1, 2, 3, 4].map((v, i) => ({ label: `M${i}`, v }));
    expect(withCompare(rows, "v", 2).map((r) => r.vBefore)).toEqual([null, null, 1, 2]);
    expect(withCompare(rows, "v", 1, "prior")[3]!.prior).toBe(3);
  });

  it("holds a zoom inside the data and at least two points wide", () => {
    expect(zoomWindow(10, 3, 6)).toEqual({ start: 3, end: 6 });
    expect(zoomWindow(10, 8, 2)).toEqual({ start: 2, end: 8 });
    expect(zoomWindow(10, 9, 9)).toEqual({ start: 8, end: 9 });
    expect(zoomWindow(10, -4, 40)).toEqual({ start: 0, end: 9 });
    expect(zoomWindow(0, 0, 3)).toEqual({ start: 0, end: 0 });
  });

  it("writes a line's name at its last value, and keeps names apart", () => {
    expect(lastIndexWith([{ a: 1 }, { a: 2 }, { a: null }], "a")).toBe(1);
    expect(lastIndexWith([{ a: null }], "a")).toBe(-1);
    expect(spreadLabels([100, 104, 50], 12)).toEqual([100, 112, 50]);
  });

  it("draws a chart as a table in its own words", () => {
    const t = chartTable([{ label: "Jan 2031", a: 1200, b: null }], "label", [{ key: "a", name: "Spending" }, { key: "b", name: "Income" }], (v) => `$${v}`);
    expect(t).toEqual({ head: ["", "Spending", "Income"], body: [["Jan 2031", "$1200", ""]] });
  });
});

describe("chart colors", () => {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const ratio = (a: string, b: string) => {
    const [x, y] = [luminance(a), luminance(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };

  it("spending (rust) and growth (green) differ in lightness in every theme, not by hue alone", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    for (const theme of ["light", "dark", "terminal"]) {
      const block = css.split(`html[data-theme="${theme}"] {`)[1]!.split("}")[0]!;
      const slot = (i: number) => new RegExp(`--chart-series-${i}: (#[0-9a-f]{6})`).exec(block)![1]!;
      expect(ratio(slot(1), slot(2)), theme).toBeGreaterThanOrEqual(1.5);
    }
  });
});
