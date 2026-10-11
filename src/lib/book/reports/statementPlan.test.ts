import { describe, expect, it } from "vitest";
import { CLASSIFIER_VERSION } from "../../classifier/version";
import { NO_HOUSEHOLD } from "../../household/patterns";
import { groupFor } from "../../ledger/loadLedger";
import { buildTimeline, type SegmentInput } from "../../ledger/timeline";
import { runChecks } from "../checks/index";
import type { Book, BookAccount, BookStatement } from "../load";
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
    // The quarter closed Sep 30; quarterly statements post a few weeks later.
    expect(statementsOf("k")[0]).toMatchObject({ status: "posting", readyBy: "2026-10-21" });
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
});
