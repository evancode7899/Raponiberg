import { describe, expect, it } from "vitest";
import { CLASSIFIER_VERSION } from "../../classifier/version";
import { NO_HOUSEHOLD } from "../../household/patterns";
import { groupFor } from "../../ledger/loadLedger";
import { buildTimeline, type SegmentInput } from "../../ledger/timeline";
import { runChecks } from "../checks/index";
import type { Book, BookAccount, BookRow, BookStatement, BookStub } from "../load";
import { buildStatementPlan } from "./statementPlan";

// A synthetic household (all names, numbers and amounts invented).

type Acct = { id: string; name: string; subtype: string; institution: string; periods: [string, string][] };

function makeBook(accts: Acct[], today: string): Book {
  const accounts: BookAccount[] = [];
  const statements: BookStatement[] = [];
  const ledgerAccounts: Book["ledger"]["accounts"] = [];
  for (const a of accts) {
    const type = a.subtype === "CREDIT_CARD" ? "CREDIT_CARD" : a.subtype === "401K" ? "INVESTMENT" : "CHECKING";
    accounts.push({ id: a.id, name: a.name, institution: a.institution, type, subtype: a.subtype, group: groupFor(a.subtype, type), identifiers: [a.id] });
    // Each account opens empty, so none needs earlier history.
    const segs: SegmentInput[] = a.periods.map(([start, end], i) => ({ accountId: a.id, periodStart: start, periodEnd: end, openingCents: i ? 10_000 : 0, closingCents: 10_000, growthCents: i ? 0 : 10_000, feesCents: 0, flows: [] }));
    for (const [start, end] of a.periods)
      statements.push({ id: `${a.id}-${end}`, accountId: a.id, documentId: `d-${a.id}-${end}`, documentTitle: `${a.id} ${end}.pdf`, importedAt: `${end}T00:00:00Z`, status: "COMMITTED", isSummary: false, periodStart: start, periodEnd: end, deltaCents: 0 });
    ledgerAccounts.push({ id: a.id, name: a.name, institution: a.institution, type, subtype: a.subtype as never, group: groupFor(a.subtype, type), isInvestment: type === "INVESTMENT", timeline: buildTimeline(a.id, segs), statementCount: segs.length, closed: false });
  }
  const firstDay = ledgerAccounts.map((a) => a.timeline.firstDay!).sort()[0]!;
  const lastDay = ledgerAccounts.map((a) => a.timeline.lastDay!).sort()[0]!;
  const book: Book = {
    today,
    horizon: { cashFlow: lastDay, netWorth: lastDay },
    ledger: { accounts: ledgerAccounts, mergeDate: "2024-12-01", completeThrough: lastDay, firstDay },
    accounts,
    statements,
    rows: [],
    rowById: new Map(),
    stubs: [],
    brokerage: [],
    holdings: [],
    matches: [],
    documents: [],
    decisions: { version: 1, confirmed: [], rejected: [] },
    classifiedWith: CLASSIFIER_VERSION,
    household: NO_HOUSEHOLD,
    classifiedWithHousehold: null,
    taxProfile: { version: 1, persons: [{ id: "pat", name: "Pat", match: ["PAT"] }], dependents: [], accountOwners: {}, accountKinds: {}, qualifiedDividendShare: 1, moneyMarketUsGovShare: 0, mfsDependentClaimant: "AUTO", years: {} },
    taxDocs: null,
    persons: [{ id: "pat", name: "Pat", match: ["PAT"] }],
    idle: { proven: [], unproven: [] },
    integrity: { checks: [], findings: [], inferences: [], accepted: [], stale: [], retired: [] },
    passes: [],
  };
  book.integrity = runChecks(book);
  return book;
}

const quarterly: Acct = { id: "k", name: "401(k) ••3333", subtype: "401K", institution: "Plan Co", periods: [["2026-01-01", "2026-03-31"], ["2026-04-01", "2026-06-30"]] };
const card: Acct = {
  id: "card",
  name: "Card ••2222",
  subtype: "CREDIT_CARD",
  institution: "Card Co",
  periods: [["2026-05-22", "2026-06-21"], ["2026-06-22", "2026-07-21"], ["2026-07-22", "2026-08-21"]],
};
const bank: Acct = { id: "chk", name: "Checking ••1111", subtype: "CHECKING", institution: "Bank Co", periods: [["2026-07-01", "2026-07-31"], ["2026-08-01", "2026-08-31"], ["2026-09-01", "2026-09-30"]] };

describe("statement plan", () => {
  const plan = buildStatementPlan(makeBook([quarterly, card, bank], "2026-10-05"));
  const statementsOf = (id: string) => plan.institutions.flatMap((i) => i.accounts).find((a) => a.accountId === id)?.statements ?? [];

  it("targets each month past the horizon through the last whole month, marking the quarter", () => {
    expect(plan.targets.map((t) => t.label)).toEqual(["Jul 2026", "Aug 2026", "Sep 2026"]);
    expect(plan.targets.at(-1)!.quarter).toBe("Q3 2026");
  });

  it("predicts each account's next statements from its cycle until they cover the target", () => {
    expect(statementsOf("k").map((s) => [s.label, s.start, s.end])).toEqual([["Q3 2026", "2026-07-01", "2026-09-30"]]);
    expect(statementsOf("card").map((s) => [s.label, s.start, s.end])).toEqual([
      ["Sep 2026", "2026-08-22", "2026-09-21"],
      ["Oct 2026", "2026-09-22", "2026-10-21"],
    ]);
    // Already through Sep 30.
    expect(statementsOf("chk")).toEqual([]);
    expect(plan.upToDate.map((u) => u.name)).toEqual(["Checking ••1111"]);
  });

  it("says when each one can be downloaded", () => {
    expect(statementsOf("card").map((s) => s.status)).toEqual(["ready", "open"]);
    // The quarter closed Sep 30; a plan's quarterly statement posts about 25 business days later.
    expect(statementsOf("k")[0]).toMatchObject({ status: "posting", readyBy: "2026-11-04" });
    // A card posts 5 business days after closing: Sep 21 (Mon) → Sep 28.
    expect(statementsOf("card")[0]!.readyBy).toBe("2026-09-28");
  });

  it("records the first month of each figure that waits on it", () => {
    // A 401(k) holds back net worth only; a card holds back cash flow and taxes too.
    expect(statementsOf("k")[0]!.neededFrom).toEqual({ netWorth: "2026-07-01" });
    expect(statementsOf("card")[0]!.neededFrom).toEqual({ netWorth: "2026-08-22", cashFlow: "2026-08-22", tax: "2026-08-22" });
  });

  it("adds a statement missing from the middle, with the finding it settles", () => {
    const gappy: Acct = { ...bank, periods: [["2026-07-01", "2026-07-31"], ["2026-09-01", "2026-09-30"]] };
    const p = buildStatementPlan(makeBook([quarterly, gappy], "2026-10-05"));
    const s = p.institutions.flatMap((i) => i.accounts).find((a) => a.accountId === "chk")!.statements;
    expect(s.map((x) => [x.kind, x.label, x.start, x.end])).toEqual([["gap", "Aug 2026", "2026-08-01", "2026-08-31"]]);
    expect(s[0]!.settles.map((f) => f.title)).toEqual(["Checking ••1111: no statement for 2026-08-01 – 2026-08-31"]);
    expect(s[0]!.neededFrom).toMatchObject({ cashFlow: "2026-08-01", netWorth: "2026-08-01" });
  });

  it("names the latest statement on file", () => {
    const a = plan.institutions.flatMap((i) => i.accounts).find((x) => x.accountId === "card")!;
    expect(a.last).toEqual({ title: "card 2026-08-21.pdf", start: "2026-07-22", end: "2026-08-21" });
  });

  it("says which bank statements prove a card's cycle when its issuer skips idle statements", () => {
    const skipper: Acct = { ...card, institution: "Capital One" };
    const b = makeBook([quarterly, skipper, bank], "2026-10-05");
    b.matches = [{ id: "m1", status: "CONFIRMED", differenceCents: 0, legs: [{ transactionId: "t1", accountId: "chk", date: "2026-07-05", amountCents: -100 }, { transactionId: "t2", accountId: "card", date: "2026-07-06", amountCents: 100 }] }];
    const s = buildStatementPlan(b).institutions.flatMap((i) => i.accounts).find((a) => a.accountId === "card")!.statements;
    // Sep 21 + 30 days: Checking's October statement (closing Oct 31) settles it, ~5 business days later.
    expect(s[0]!.ifIdle).toEqual({ banks: ["Checking ••1111"], through: "2026-10-21", readyBy: "2026-11-06", onFile: false });
    // An issuer that always sends one gets no such note.
    expect(statementsOf("card")[0]!.ifIdle).toBeUndefined();
  });
});

describe("statement plan · pay stubs", () => {
  const row = (id: string, date: string): BookRow => ({
    id,
    date,
    precision: "EXACT",
    statement: { start: `${date.slice(0, 8)}01`, end: `${date.slice(0, 8)}30` },
    bookedOn: date,
    amountCents: 2_000_00,
    lane: "INCOME",
    accountId: "chk",
    payee: "ACME PAYROLL",
    merchantKey: "ACME",
    category: "Paycheck",
    categoryGroup: null,
    counterpartyKind: null,
    counterpartyInstitution: null,
    counterpartyAccountHint: null,
    classifiedBy: null,
    transferMatchId: null,
    statementImportId: "st",
    documentId: "doc",
  });
  const stub = (payDate: string, rowId: string | null, n: number) =>
    ({ id: `s-${payDate}`, documentId: `d-${payDate}`, documentTitle: `acme ${payDate}.pdf`, employer: "Acme Corp", employerKey: "ACME", personId: "pat", payDate, depositTransactionId: rowId, printed: { netCurrent: 2_000_00, netYtd: n * 2_000_00 }, lines: [], deposits: [] }) as unknown as BookStub;
  const withPay = (dates: string[], stubbed: number) => {
    const b = makeBook([quarterly, bank], "2026-10-05");
    b.rows = dates.map((d, i) => row(`r${i}`, d));
    b.rowById = new Map(b.rows.map((r) => [r.id, r]));
    b.stubs = dates.slice(0, stubbed).map((d, i) => stub(d, `r${i}`, i + 1));
    return buildStatementPlan(b);
  };

  it("lists paychecks the bank shows without a stub, and the ones the pay cycle says are due past the bank's statements", () => {
    // Semimonthly (the 15th and month end, a weekend moved to Friday); stubs through Aug 31, bank through Sep 30.
    const p = withPay(["2026-07-15", "2026-07-31", "2026-08-14", "2026-08-31", "2026-09-15"], 4);
    expect(p.stubs).toHaveLength(1);
    expect(p.stubs[0]).toMatchObject({ person: "Pat", employer: "Acme Corp", cadence: "semimonthly", last: { title: "acme 2026-08-31.pdf", payDate: "2026-08-31" } });
    expect(p.stubs[0]!.stubs.map((s) => [s.kind, s.date, s.status, s.neededFrom.tax])).toEqual([
      ["deposited", "2026-09-15", "ready", "2026-09-15"],
      ["expected", "2026-09-30", "ready", "2026-09-30"],
    ]);
  });

  it("leaves out an employer the bank shows paying nothing for two cycles after its last stub", () => {
    expect(withPay(["2026-07-15", "2026-07-31"], 2).stubs).toEqual([]);
  });
});
