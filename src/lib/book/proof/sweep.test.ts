import { describe, expect, it } from "vitest";
import type { Book } from "../load";
import { perBook } from "./common";
import { descriptorKey } from "./key";

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
