import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { declaredClosure, readClosedAccounts, saveClosedAccount, settlement } from "./closedAccounts";
import { refreshLedgerStatus, type Ledger, type LedgerAccount } from "./loadLedger";
import type { AccountTimeline } from "./timeline";

const tempFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), "closed-accounts-")), "closed-accounts.json");
const journal = (file: string) => readFileSync(file.replace(/\.json$/, ".journal.jsonl"), "utf8").trim().split("\n");

describe("closed accounts file", () => {
  it("keeps one entry per account and finds it by any identifier, ignoring case", () => {
    const file = tempFile();
    saveClosedAccount({ institution: "Example Bank", identifier: "1-23456", note: "closed with a credit" }, file);
    saveClosedAccount({ institution: "EXAMPLE BANK", identifier: "1-23456", note: "closed by phone" }, file);
    const { accounts } = readClosedAccounts(file);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.note).toBe("closed by phone");
    expect(journal(file)).toHaveLength(2);

    expect(declaredClosure(accounts, "example bank", ["9-99999", "1-23456"])).toBeDefined();
    expect(declaredClosure(accounts, "Other Bank", ["1-23456"])).toBeUndefined();
    expect(declaredClosure(accounts, "Example Bank", ["9-99999"])).toBeUndefined();
  });

  it("treats a missing file as none, and refuses a damaged or newer one", () => {
    const file = tempFile();
    expect(readClosedAccounts(file).accounts).toEqual([]);
    writeFileSync(file, "{ nope");
    expect(() => readClosedAccounts(file)).toThrow(/damaged/);
    writeFileSync(file, JSON.stringify({ version: 2, accounts: [] }));
    expect(() => readClosedAccounts(file)).toThrow(/newer version/);
  });
});

describe("refreshLedgerStatus", () => {
  const card = (id: string, lastDay: string, closingCents: number, closedByOwner?: string): LedgerAccount => ({
    id,
    name: id,
    institution: "Example Bank",
    type: "CREDIT_CARD",
    subtype: "CREDIT_CARD",
    group: "Credit cards",
    isInvestment: false,
    timeline: { firstDay: "2024-01-01", lastDay, segments: [{ closing: closingCents }] } as unknown as AccountTimeline,
    statementCount: 1,
    closed: false,
    ...(closedByOwner != null ? { closedByOwner } : {}),
  });

  it("an owner-closed card with a credit left stops holding back the complete-through date", () => {
    const ledger: Ledger = {
      accounts: [card("open", "2024-09-10", -5000), card("credit-left", "2024-03-10", 2000)],
      mergeDate: "2024-01-01",
      completeThrough: null,
      firstDay: null,
    };
    refreshLedgerStatus(ledger, "2024-10-01");
    expect(ledger.completeThrough).toBe("2024-03-10");

    ledger.accounts[1]!.closedByOwner = "closed with a credit";
    refreshLedgerStatus(ledger, "2024-10-01");
    expect(ledger.accounts[1]!.closed).toBe(true);
    expect(ledger.completeThrough).toBe("2024-09-10");
  });
});

describe("settlement", () => {
  const pay = (id: string, cents: number) => ({ id, amountCents: cents });

  it("is the first payments that add up to what was owing", () => {
    expect(settlement([pay("a", -70_00), pay("b", -30_00), pay("c", -5_00)], 100_00).map((p) => p.id)).toEqual(["a", "b"]);
    expect(settlement([pay("a", -100_00)], 100_00).map((p) => p.id)).toEqual(["a"]);
  });

  it("is none when nothing was owing (a credit or $0) or no run of payments adds up to it", () => {
    expect(settlement([pay("a", -12_00)], 0)).toEqual([]);
    expect(settlement([pay("a", -60_00), pay("b", -60_00)], 100_00)).toEqual([]);
    expect(settlement([pay("a", -40_00)], 100_00)).toEqual([]);
  });
});
