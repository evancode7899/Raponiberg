import { describe, expect, it } from "vitest";
import { filterRows, firstDirection, sortByValue, tableCsv, visibleWindow } from "./table";

type Row = { id: string; payee: string | null; cents: number; day: string };
const rows: Row[] = [
  { id: "a", payee: "Springfield Grocer", cents: -4210, day: "2031-03-02" },
  { id: "b", payee: "Example Partners LP", cents: 250000, day: "2031-03-01" },
  { id: "c", payee: null, cents: -990, day: "2031-02-27" },
  { id: "d", payee: "springfield power", cents: -12000, day: "2031-03-02" },
];

describe("the shared table's rows", () => {
  it("filters by every word typed, in any case or order", () => {
    const t = [(r: Row) => r.payee ?? "", (r: Row) => r.day];
    expect(filterRows(rows, "springfield", t).map((r) => r.id)).toEqual(["a", "d"]);
    expect(filterRows(rows, "POWER springfield", t).map((r) => r.id)).toEqual(["d"]);
    expect(filterRows(rows, "2031-03", t).map((r) => r.id)).toEqual(["a", "b", "d"]);
    expect(filterRows(rows, "  ", t)).toHaveLength(4);
  });

  it("sorts by a column, missing values last, ties in the page's order", () => {
    expect(sortByValue(rows, { key: "payee", desc: false }, (r) => r.payee).map((r) => r.id)).toEqual(["b", "a", "d", "c"]);
    expect(sortByValue(rows, { key: "payee", desc: true }, (r) => r.payee).map((r) => r.id)).toEqual(["d", "a", "b", "c"]);
    expect(sortByValue(rows, { key: "size", desc: true }, (r) => Math.abs(r.cents)).map((r) => r.id)).toEqual(["b", "d", "a", "c"]);
    expect(sortByValue(rows, { key: "day", desc: true }, (r) => r.day).map((r) => r.id)).toEqual(["a", "d", "b", "c"]);
    expect(sortByValue(rows, null, (r) => r.day)).toEqual(rows);
  });

  it("starts numbers and dates biggest and newest, words A to Z", () => {
    expect(firstDirection(12)).toBe(true);
    expect(firstDirection("2031-01-01")).toBe(true);
    expect(firstDirection("Grocer")).toBe(false);
  });

  it("draws the rows in view and keeps room for the rest", () => {
    expect(visibleWindow(10_000, 30, 0, 600, 10)).toEqual({ start: 0, end: 30, padTop: 0, padBottom: 9970 * 30 });
    const mid = visibleWindow(10_000, 30, 30_000, 600, 10);
    expect(mid.start).toBe(990);
    expect(mid.end).toBe(1030);
    expect(mid.padTop + (mid.end - mid.start) * 30 + mid.padBottom).toBe(10_000 * 30);
    expect(visibleWindow(5, 30, 99_999, 600, 10)).toMatchObject({ start: 0, end: 5, padBottom: 0 });
    expect(visibleWindow(0, 30, 0, 600)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
  });

  it("copies the cells as drawn, as CSV a spreadsheet reads safely", () => {
    const csv = tableCsv(rows.slice(0, 3), [
      { label: "Payee", text: (r) => r.payee ?? "n.a." },
      { label: "Amount", text: (r) => (r.id === "b" ? "n.a." : `$${(Math.abs(r.cents) / 100).toFixed(2)}`) },
    ]);
    expect(csv).toBe("Payee,Amount\r\nSpringfield Grocer,$42.10\r\nExample Partners LP,n.a.\r\nn.a.,$9.90\r\n");
    expect(tableCsv([{ v: "=1+1" }], [{ label: "A", text: (r) => r.v }])).toBe("A\r\n'=1+1\r\n");
  });
});
