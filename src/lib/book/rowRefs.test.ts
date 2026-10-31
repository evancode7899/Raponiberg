import { describe, expect, it } from "vitest";
import { rowRefs } from "./findingKeys";
import type { Book, BookRow } from "./load";

// SSOT F · K: two identical transfers on one day keep their numbers when one of them pairs.
const row = (id: string, matched: boolean): BookRow => ({ id, accountId: "chk", date: "2025-03-03", amountCents: -10_000, lane: "TRANSFER", transferMatchId: matched ? "m1" : null }) as BookRow;
const book = (rows: BookRow[]) =>
  ({ rows, accounts: [{ id: "chk", name: "Example Bank ••1234", institution: "Example Bank", identifiers: ["1234"] }], ledger: { accounts: [] } }) as unknown as Book;
const unpaired = (r: BookRow) => r.lane === "TRANSFER" && !r.transferMatchId;
const transfers = (r: BookRow) => r.lane === "TRANSFER";

describe("rowRefs", () => {
  it("numbers a row among all its twins, so pairing one never renumbers the other", () => {
    const before = rowRefs(book([row("a", false), row("b", false)]), unpaired, transfers);
    const after = rowRefs(book([row("a", true), row("b", false)]), unpaired, transfers);
    expect(after.get("b")).toBe(before.get("b"));
    expect(after.has("a")).toBe(false);
  });
});
