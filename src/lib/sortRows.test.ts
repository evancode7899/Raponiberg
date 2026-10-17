import { describe, expect, it } from "vitest";
import { sortRows } from "./sortRows";

type R = { id: string; date: string; cents: number; payee: string | null };
const rows: R[] = [
  { id: "a", date: "2024-03-02", cents: -4_210, payee: "corner cafe" },
  { id: "b", date: "2024-01-15", cents: 90_000, payee: "Example Partners LP" },
  { id: "c", date: "2024-02-20", cents: -90_000, payee: "Acme Rent" },
  { id: "d", date: "2024-02-20", cents: 1_299, payee: null },
];
const get = { date: (r: R) => r.date, amount: (r: R) => r.cents, name: (r: R) => r.payee };
const ids = (xs: R[]) => xs.map((r) => r.id).join("");

describe("sortRows", () => {
  it("sorts by date either way", () => {
    expect(ids(sortRows(rows, { key: "date", desc: true }, get))).toBe("acdb");
    expect(ids(sortRows(rows, { key: "date", desc: false }, get))).toBe("bcda");
  });

  it("sorts by size, so money in and out of the same size sit together, newest first on a tie", () => {
    expect(ids(sortRows(rows, { key: "amount", desc: true }, get))).toBe("cbad");
    expect(ids(sortRows(rows, { key: "amount", desc: false }, get))).toBe("dacb");
  });

  it("sorts names ignoring case, blanks first going A to Z", () => {
    expect(ids(sortRows(rows, { key: "name", desc: false }, get))).toBe("dcab");
  });

  it("keeps the given order with no sort and never mutates the input", () => {
    const copy = [...rows];
    expect(ids(sortRows(rows, null, get))).toBe("abcd");
    sortRows(rows, { key: "amount", desc: true }, get);
    expect(rows).toEqual(copy);
  });
});
