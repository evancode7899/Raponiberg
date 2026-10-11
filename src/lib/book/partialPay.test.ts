import { describe, expect, it } from "vitest";
import { CLASSIFIER_VERSION } from "../classifier/version";
import { NO_HOUSEHOLD } from "../household/patterns";
import type { StubLine } from "../ingest/payroll/types";
import { groupFor } from "../ledger/loadLedger";
import { buildTimeline } from "../ledger/timeline";
import { blockersFor } from "./blockers";
import { runChecks } from "./checks/index";
import type { Book, BookRow, BookStub } from "./load";
import { personPayYear } from "./pay";

// A household with one checking account and weekly stubs (names and amounts invented).

function book(stubs: BookStub[], deposits: { id: string; date: string; cents: number }[], unavailableAccounts: { last4: string; note: string }[] = []): Book {
  const rows: BookRow[] = deposits.map((d) => ({ id: d.id, date: d.date, precision: "EXACT", statement: { start: "2023-01-01", end: "2023-12-31" }, bookedOn: d.date, amountCents: d.cents, lane: "INCOME", accountId: "chk", payee: "ACME DIRECT DEP", merchantKey: "ACME", category: "Paycheck", categoryGroup: null, counterpartyKind: null, counterpartyInstitution: null, counterpartyAccountHint: null, classifiedBy: null, transferMatchId: null }));
  const timeline = buildTimeline("chk", [
    { accountId: "chk", periodStart: "2023-01-01", periodEnd: "2023-12-31", openingCents: 0, closingCents: deposits.reduce((s, d) => s + d.cents, 0), growthCents: 0, feesCents: 0, flows: deposits.map((d) => ({ date: d.date, precision: "EXACT" as const, amountCents: d.cents, lane: "INCOME" as const })) },
  ]);
  const b = {
    today: "2024-01-31",
    horizon: { cashFlow: "2023-12-31", netWorth: "2023-12-31" },
    ledger: { accounts: [{ id: "chk", name: "Checking ••1234", institution: "Bank", type: "CHECKING", subtype: "CHECKING", group: groupFor("CHECKING", "CHECKING"), isInvestment: false, timeline, statementCount: 1, closed: false }], mergeDate: "2022-01-01", completeThrough: null, firstDay: "2023-01-01" },
    accounts: [{ id: "chk", name: "Checking ••1234", institution: "Bank", type: "CHECKING", subtype: "CHECKING", group: "Cash", identifiers: ["1234"] }],
    statements: [],
    rows,
    rowById: new Map(rows.map((r) => [r.id, r])),
    stubs,
    brokerage: [],
    matches: [],
    documents: [],
    decisions: { version: 1, confirmed: [], rejected: [] },
    classifiedWith: CLASSIFIER_VERSION,
    household: NO_HOUSEHOLD,
    classifiedWithHousehold: null,
    taxProfile: { version: 1, persons: [{ id: "pat", name: "Pat", match: ["PAT"] }], dependents: [], accountOwners: {}, qualifiedDividendShare: 1, moneyMarketUsGovShare: 0, mfsDependentClaimant: "AUTO", unavailableAccounts, years: {} },
    persons: [{ id: "pat", name: "Pat", match: ["PAT"] }],
    integrity: { checks: [], findings: [], inferences: [], accepted: [] },
  } as unknown as Book;
  // No idle card cycles in this household (newer Books carry an idle-card report).
  Object.assign(b, { idle: { proven: [], unproven: [] } });
  b.integrity = runChecks(b);
  return b;
}

function stub(date: string, net: number, netYtd: number, dep: string): BookStub {
  const lines: StubLine[] = [{ name: "Regular", kind: "REGULAR", current: net, ytd: netYtd }];
  return {
    id: `s-${date}`, documentId: "d", documentTitle: "stub.pdf", importedAt: "2025-02-01T00:00:00.000Z", source: "ADP", employee: "Pat Example", employer: "Acme Inc", employerKey: "ACME", personId: "pat",
    payDate: date, periodStart: null, periodEnd: null, federalFilingStatus: null, lines,
    printed: { grossCurrent: net, grossYtd: netYtd, withheldCurrent: 0, withheldYtd: 0, netCurrent: net, netYtd },
    deposits: [{ last4: "1234", amount: net }], warnings: [], depositTransactionId: dep,
  };
}

describe("partial pay", () => {
  it("takes pay before the first available stub from its year-to-date totals, labelled partial", () => {
    // Jan–Sep stubs aren't available; the Oct 6 stub's YTD already includes $9,000.
    const b = book([stub("2023-10-06", 1000, 10_000, "r1"), stub("2023-10-13", 1000, 11_000, "r2")], [
      { id: "r1", date: "2023-10-06", cents: 1000 },
      { id: "r2", date: "2023-10-13", cents: 1000 },
    ]);
    expect(b.integrity.findings.filter((f) => f.check.startsWith("pay"))).toEqual([]);
    const pay = personPayYear(b, "pat", 2023);
    expect(pay.blockers).toEqual([]);
    expect(pay.totals.net).toBe(11_000);
    expect(pay.partial).toHaveLength(1);
    expect(pay.partial[0]!.title).toContain("partial");
    // Named by employer, pay date and net pay, so it survives a database rebuild.
    expect(pay.partial[0]!.id).toBe("pay.continuity:ACME:2023-10-06:1000");
  });

  it("takes pay deposited to an account with no statements available from the stubs, labelled partial", () => {
    const toClosed = (s: BookStub): BookStub => ({ ...s, deposits: [{ last4: "9999", amount: s.printed.netCurrent }], depositTransactionId: null });
    const stubs = [toClosed(stub("2023-10-06", 1000, 1000, "")), toClosed(stub("2023-10-13", 1000, 2000, "")), stub("2023-10-20", 1000, 3000, "r3")];
    const deposits = [{ id: "r3", date: "2023-10-20", cents: 1000 }];
    // Without the setting the closed account's paychecks are missing data.
    expect(personPayYear(book(stubs, deposits), "pat", 2023).blockers.length).toBeGreaterThan(0);
    const b = book(stubs, deposits, [{ last4: "9999", note: "Closed pre-marriage account" }]);
    const pay = personPayYear(b, "pat", 2023);
    expect(pay.blockers).toEqual([]);
    expect(pay.totals.net).toBe(3000);
    expect(pay.partial.map((i) => i.title).join()).toContain("••9999");
  });

  it("still blocks the year when stubs are missing mid-year", () => {
    const b = book([stub("2023-01-06", 1000, 1000, "r1"), stub("2023-10-06", 1000, 10_000, "r2")], [
      { id: "r1", date: "2023-01-06", cents: 1000 },
      { id: "r2", date: "2023-10-06", cents: 1000 },
    ]);
    expect(blockersFor(b, { affects: "PAY", personId: "pat", from: "2023-01-01", to: "2023-12-31" }).map((f) => f.check)).toContain("pay.continuity");
    expect(personPayYear(b, "pat", 2023).partial).toEqual([]);
  });
});
