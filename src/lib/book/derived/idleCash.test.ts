import { describe, expect, it } from "vitest";
import type { PositionRow } from "../reports/investments";
import { idleCash } from "./investments";

// Invented positions: a money-market fund, a balanced fund 10% cash, and a stock fund.
const pos = (accountId: string, valueCents: number, cash: number): PositionRow => ({ accountId, account: `Account ${accountId}`, valueCents, weights: cash ? { CASH: cash } : { US_STOCK: 1 } }) as unknown as PositionRow;

describe("cash in investment accounts", () => {
  it("adds each account's cash part, most first, and leaves out accounts holding none", () => {
    const rows = idleCash({ positions: [pos("a", 5_000_00, 1), pos("a", 45_000_00, 0), pos("b", 100_000_00, 0.1), pos("c", 20_000_00, 0)] });
    expect(rows).toEqual([
      { accountId: "b", account: "Account b", cashCents: 10_000_00, valueCents: 100_000_00 },
      { accountId: "a", account: "Account a", cashCents: 5_000_00, valueCents: 50_000_00 },
    ]);
    expect(idleCash({ positions: [] })).toEqual([]);
  });
});
