import { describe, expect, it } from "vitest";
import { recurringCheckCategory } from "./classify.ts";

const check = (date: string, dollars: number, n: number) => ({ description: `Check # ${n}`, amountCents: -dollars * 100, date });

describe("recurringCheckCategory", () => {
  it("marks monthly checks that step up a few percent and stay as rent", () => {
    const rows = [
      check("2023-11-03", 4150, 159),
      check("2023-12-08", 4150, 160),
      check("2024-01-09", 4300, 165),
      check("2024-02-12", 4300, 167),
      check("2024-03-05", 4300, 169),
      check("2024-04-04", 4475, 171),
    ];
    expect(recurringCheckCategory(rows).size).toBe(rows.length);
  });

  it("leaves one-off, small, and same-month duplicate checks alone", () => {
    const rows = [
      check("2023-12-08", 150, 162),
      check("2023-12-18", 2150, 164),
      check("2023-12-19", 2150, 163),
      check("2026-03-25", 345, 191),
    ];
    expect(recurringCheckCategory(rows).size).toBe(0);
  });

  it("does not follow a big jump or a drop", () => {
    const rows = [check("2023-01-05", 2000, 1), check("2023-02-05", 3000, 2), check("2023-03-05", 2000, 3)];
    expect(recurringCheckCategory(rows).size).toBe(0);
  });
});
