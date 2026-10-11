import { describe, expect, it } from "vitest";
import type { ParsedAccountSection } from "./types";
import { validateSection } from "./validate";

// An invented card statement.
const section = (rows: { date: string; cents: number }[]): ParsedAccountSection => ({
  institution: "Card Co",
  accountNumber: "2222",
  accountName: "Card",
  kind: "CREDIT_CARD",
  subtype: "CREDIT_CARD",
  periodStart: "2025-12-12",
  periodEnd: "2026-01-11",
  openingBalanceCents: 0,
  closingBalanceCents: rows.reduce((t, r) => t + r.cents, 0),
  growthCents: 0,
  feesCents: 0,
  transactions: rows.map((r) => ({ date: r.date, datePrecision: "EXACT", description: "SHOP", amountCents: r.cents })),
  checks: [],
});

describe("statement validation", () => {
  it("accepts a purchase listed a few days before the period (posted after the last statement closed)", () => {
    expect(validateSection(section([{ date: "2025-12-09", cents: -500 }])).ok).toBe(true);
  });

  it("holds a statement that ties but has a row a year off — a New Year date read wrong", () => {
    const v = validateSection(section([{ date: "2025-01-03", cents: -500 }]));
    expect(v.deltaCents).toBe(0);
    expect(v.ok).toBe(false);
    expect(v.problems).toEqual(["Transaction dated 2025-01-03 is outside the statement period 2025-12-12 – 2026-01-11"]);
  });
});
