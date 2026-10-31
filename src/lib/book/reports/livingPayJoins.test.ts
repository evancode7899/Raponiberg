import { describe, expect, it } from "vitest";
import type { Book, BookStub } from "../load";
import { payReimbursementsIn } from "./living";

// SSOT F · H: a partner's paycheck reimbursements offset household spending only from the
// merge (STRICT), as their pay counts only from then. Pat Example and Sam Example, invented.
const stub = (personId: string, payDate: string, cents: number): BookStub =>
  ({ id: `${personId}-${payDate}`, personId, payDate, lines: [{ name: "Expense reimbursement", kind: "NONTAXABLE", current: cents, ytd: cents }] }) as unknown as BookStub;

const book = (viewMode: "STRICT" | "PRO_FORMA"): Book =>
  ({
    viewMode,
    persons: [{ id: "pat", name: "Pat Example", match: ["PAT"] }, { id: "sam", name: "Sam Example", match: ["SAM"] }],
    ledger: { accounts: [], mergeDate: "2025-06-01", completeThrough: null, firstDay: "2025-01-01" },
    rows: [],
    stubs: [stub("pat", "2025-03-15", 10_000), stub("sam", "2025-03-15", 20_000), stub("sam", "2025-07-15", 40_000)],
  }) as unknown as Book;

describe("pay reimbursements in living cost", () => {
  it("count a partner's only from the merge in the strict view", () => {
    expect(payReimbursementsIn(book("STRICT"), "2025-01-01", "2025-12-31")).toBe(50_000);
  });
  it("count every paycheck as if merged all along in the pro forma view", () => {
    expect(payReimbursementsIn(book("PRO_FORMA"), "2025-01-01", "2025-12-31")).toBe(70_000);
  });
});
