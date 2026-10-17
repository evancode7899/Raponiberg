import { describe, expect, it } from "vitest";
import type { Lane } from "../classifier/taxonomy";
import { CLASSIFIER_VERSION } from "../classifier/version";
import { NO_HOUSEHOLD } from "../household/patterns";
import type { StubLine } from "../ingest/payroll/types";
import { groupFor } from "../ledger/loadLedger";
import { buildTimeline, type SegmentInput } from "../ledger/timeline";
import { blockersFor, netWorthAtBlockers, netWorthBlockers, passesFor } from "./blockers";
import { runChecksWithPasses } from "./checks/index";
import { Collector } from "./checks/collector";
import { staleEvidence } from "./exceptions";
import { cashFlowThrough, type Book, type BookAccount, type BookRow, type BookStub } from "./load";
import type { StandingException } from "./types";

// A tiny synthetic household (all names and amounts invented).

type Seg = { start: string; end: string; open: number; close: number; rows?: { date: string; cents: number; lane?: Lane; payee?: string; key?: string; id?: string }[] };

function makeBook(opts: {
  accounts: { id: string; name: string; subtype: string; institution?: string; idents?: string[]; segs: Seg[] }[];
  stubs?: BookStub[];
  today?: string;
  exceptions?: StandingException[];
  horizon?: Book["horizon"];
  persons?: Book["persons"];
}): Book {
  const rows: BookRow[] = [];
  const accounts: BookAccount[] = [];
  const ledgerAccounts: Book["ledger"]["accounts"] = [];
  for (const a of opts.accounts) {
    accounts.push({ id: a.id, name: a.name, institution: a.institution ?? null, type: a.subtype === "CREDIT_CARD" ? "CREDIT_CARD" : "CHECKING", subtype: a.subtype, group: groupFor(a.subtype, "OTHER"), identifiers: a.idents ?? [] });
    const segs: SegmentInput[] = a.segs.map((s) => {
      const flows = (s.rows ?? []).map((r, i) => {
        const id = r.id ?? `${a.id}-${s.start}-${i}`;
        rows.push({ id, date: r.date, precision: "EXACT", statement: { start: s.start, end: s.end }, bookedOn: r.date, amountCents: r.cents, lane: r.lane ?? "INCOME", accountId: a.id, payee: r.payee ?? "X", merchantKey: r.key ?? null, category: r.lane === "INCOME" ? "Paycheck" : "Other", categoryGroup: null, counterpartyKind: null, counterpartyInstitution: null, counterpartyAccountHint: null, classifiedBy: null, transferMatchId: null, statementImportId: `st-${a.id}-${s.start}`, documentId: `doc-${a.id}-${s.start}` });
        return { date: r.date, precision: "EXACT" as const, amountCents: r.cents, lane: r.lane ?? ("INCOME" as Lane) };
      });
      // Committed statements always tie; whatever the rows leave unexplained is market change.
      const growthCents = s.close - s.open - flows.reduce((t, f) => t + f.amountCents, 0);
      return { accountId: a.id, periodStart: s.start, periodEnd: s.end, openingCents: s.open, closingCents: s.close, growthCents, feesCents: 0, flows };
    });
    const timeline = buildTimeline(a.id, segs);
    ledgerAccounts.push({ id: a.id, name: a.name, institution: a.institution ?? null, type: "CHECKING", subtype: a.subtype as never, group: groupFor(a.subtype, "OTHER"), isInvestment: false, timeline, statementCount: segs.length, closed: false });
  }
  const firstDay = ledgerAccounts.map((a) => a.timeline.firstDay!).sort()[0]!;
  const book: Book = {
    today: opts.today ?? "2025-12-31",
    horizon: opts.horizon ?? { cashFlow: "2025-12-31", netWorth: "2025-12-31" },
    ledger: { accounts: ledgerAccounts, mergeDate: "2024-12-01", completeThrough: null, firstDay },
    accounts,
    statements: [],
    rows,
    rowById: new Map(rows.map((r) => [r.id, r])),
    stubs: opts.stubs ?? [],
    brokerage: [],
    holdings: [],
    matches: [],
    documents: [],
    decisions: { version: 1, confirmed: [], rejected: [] },
    classifiedWith: CLASSIFIER_VERSION,
    household: NO_HOUSEHOLD,
    classifiedWithHousehold: null,
    taxProfile: { version: 1, persons: opts.persons ?? [{ id: "pat", name: "Pat", match: ["PAT"] }], dependents: [], accountOwners: {}, accountKinds: {}, qualifiedDividendShare: 1, moneyMarketUsGovShare: 0, mfsDependentClaimant: "AUTO", years: {} },
    taxDocs: null,
    persons: opts.persons ?? [{ id: "pat", name: "Pat", match: ["PAT"] }],
    idle: { proven: [], unproven: [] },
    integrity: { checks: [], findings: [], inferences: [], accepted: [], stale: [], retired: [] },
    passes: [],
  };
  const checked = runChecksWithPasses(book, opts.exceptions);
  book.integrity = checked.report;
  book.passes = checked.passes;
  return book;
}

/** A stub paying `net` on `date` with `netYtd` year to date, linked to bank row `dep`. */
function stub(date: string, net: number, netYtd: number, dep: string | null): BookStub {
  const lines: StubLine[] = [{ name: "Regular", kind: "REGULAR", current: net, ytd: netYtd }];
  return {
    id: `s-${date}-${net}`,
    documentId: "d",
    documentTitle: "stub.pdf",
    importedAt: "2025-02-01T00:00:00.000Z",
    source: "TRINET",
    employee: "Pat Example",
    employer: "Acme LP",
    employerKey: "ACME",
    personId: "pat",
    payDate: date,
    periodStart: null,
    periodEnd: null,
    federalFilingStatus: null,
    lines,
    printed: { grossCurrent: net, grossYtd: netYtd, withheldCurrent: 0, withheldYtd: 0, netCurrent: net, netYtd },
    deposits: [{ last4: "1234", amount: net }],
    warnings: [],
    depositTransactionId: dep,
  };
}

const checking = (rows: Seg["rows"]): Parameters<typeof makeBook>[0]["accounts"][number] => ({
  id: "chk",
  name: "Checking ••1234",
  subtype: "CHECKING",
  institution: "Bank",
  idents: ["1234"],
  segs: [{ start: "2025-01-01", end: "2025-12-31", open: 0, close: (rows ?? []).reduce((s, r) => s + r.cents, 0), rows }],
});
const ids = (b: Book, check: string) => b.integrity.findings.filter((f) => f.check === check).map((f) => f.status);

describe("pay checks", () => {
  it("proves a year whose stubs chain and whose net ties to the deposits", () => {
    const b = makeBook({
      accounts: [checking([{ date: "2025-01-15", cents: 100, key: "ACME", id: "r1" }, { date: "2025-01-31", cents: 100, key: "ACME", id: "r2" }])],
      stubs: [stub("2025-01-15", 100, 100, "r1"), stub("2025-01-31", 100, 200, "r2")],
    });
    expect(b.integrity.findings.filter((f) => f.check.startsWith("pay"))).toEqual([]);
  });

  it("infers a paycheck without a stub from the YTD jump and the deposit", () => {
    const b = makeBook({
      accounts: [checking([{ date: "2025-01-15", cents: 100, key: "ACME", id: "r1" }, { date: "2025-01-31", cents: 100, key: "ACME" }, { date: "2025-02-14", cents: 100, key: "ACME", id: "r3" }])],
      stubs: [stub("2025-01-15", 100, 100, "r1"), stub("2025-02-14", 100, 300, "r3")],
    });
    expect(ids(b, "pay.continuity")).toEqual([]);
    expect(b.integrity.inferences.map((i) => i.check)).toContain("pay.continuity");
    expect(ids(b, "pay.unexplained-deposits")).toEqual([]);
  });

  it("scopes each paycheck's pass to whose pay it is (its stub's, or the chain inferring it)", () => {
    const pay = (date: string, id?: string) => ({ date, cents: 100, key: "ACME", lane: "INCOME" as const, ...(id ? { id } : {}) });
    const b = makeBook({
      accounts: [checking([pay("2025-01-15", "r1"), pay("2025-01-31"), pay("2025-02-14", "r3")])],
      stubs: [stub("2025-01-15", 100, 100, "r1"), stub("2025-02-14", 100, 300, "r3")],
    });
    // So one person's pay proof doesn't list another's paychecks deposited to a joint account.
    const passes = b.passes.filter((p) => p.check === "pay.unexplained-deposits");
    expect(passes.map((p) => [p.scope.from, p.scope.personId, p.scope.employerKey])).toEqual([
      ["2025-01-15", "pat", "ACME"],
      ["2025-01-31", "pat", "ACME"],
      ["2025-02-14", "pat", "ACME"],
    ]);
  });

  it("reports missing stubs when the deposits don't explain the YTD jump", () => {
    const b = makeBook({
      accounts: [checking([{ date: "2025-01-15", cents: 100, key: "ACME", id: "r1" }, { date: "2025-02-14", cents: 100, key: "ACME", id: "r3" }])],
      stubs: [stub("2025-01-15", 100, 100, "r1"), stub("2025-02-14", 100, 300, "r3")],
    });
    expect(ids(b, "pay.continuity")).toEqual(["MISSING"]);
  });

  it("treats two checks paid the same day as one payment (both print the combined YTD)", () => {
    const b = makeBook({
      accounts: [checking([{ date: "2025-03-15", cents: 100, key: "ACME", id: "r1" }, { date: "2025-03-15", cents: 900, key: "ACME", id: "r2" }])],
      stubs: [stub("2025-03-15", 100, 1000, "r1"), stub("2025-03-15", 900, 1000, "r2")],
    });
    expect(ids(b, "pay.continuity")).toEqual([]);
  });

  it("flags paychecks deposited after the year's last stub", () => {
    const b = makeBook({
      accounts: [checking([{ date: "2025-01-15", cents: 100, key: "ACME", id: "r1" }, { date: "2025-06-30", cents: 100, key: "ACME" }])],
      stubs: [stub("2025-01-15", 100, 100, "r1")],
    });
    expect(ids(b, "pay.after-last-stub")).toEqual(["MISSING"]);
    // And the year's pay is blocked for that person.
    expect(blockersFor(b, { affects: "PAY", personId: "pat", from: "2025-01-01", to: "2025-12-31" }).length).toBeGreaterThan(0);
  });

  it("reports net pay that never reached a tracked account as missing, more than paid as failing", () => {
    const short = makeBook({ accounts: [checking([{ date: "2025-01-15", cents: 60, key: "ACME", id: "r1" }])], stubs: [{ ...stub("2025-01-15", 100, 100, null), deposits: [{ last4: "1234", amount: 100 }] }] });
    expect(ids(short, "pay.deposits-tie")).toEqual(["MISSING"]);
  });
});

describe("statement checks", () => {
  const card = (segs: Seg[]) => ({ id: "card", name: "Card ••9999", subtype: "CREDIT_CARD", institution: "Card Co", idents: ["9999"], segs });

  it("accepts a gap between zero balances with no money moved as provably empty", () => {
    const b = makeBook({
      accounts: [
        checking([]),
        card([
          { start: "2025-01-01", end: "2025-01-31", open: 0, close: 0 },
          { start: "2025-05-01", end: "2025-05-31", open: 0, close: 0 },
        ]),
      ],
    });
    expect(ids(b, "statement.gap")).toEqual([]);
    expect(b.integrity.inferences.map((i) => i.check)).toContain("statement.gap");
  });

  it("reports a gap whose balance changed as missing, blocking net worth inside it but not its last day", () => {
    const b = makeBook({
      accounts: [
        checking([]),
        card([
          { start: "2025-01-01", end: "2025-01-31", open: 0, close: -500 },
          { start: "2025-05-01", end: "2025-05-31", open: -200, close: -200 },
        ]),
      ],
    });
    expect(ids(b, "statement.gap")).toEqual(["MISSING"]);
    expect(netWorthAtBlockers(b, "2025-03-31")).toHaveLength(1);
    // The day before the next statement is its opening balance: known.
    expect(netWorthBlockers(b, "2025-05-01", "2025-05-31")).toHaveLength(0);
    // Cash flow is unknown for every day of the gap.
    expect(blockersFor(b, { affects: "CASH_FLOW", from: "2025-04-30", to: "2025-04-30" })).toHaveLength(1);
  });

  it("knows the balance the day before a first statement, but nothing earlier", () => {
    const b = makeBook({
      accounts: [checking([]), { id: "brk", name: "Brokerage", subtype: "BROKERAGE", segs: [{ start: "2025-07-01", end: "2025-12-31", open: 5000, close: 6000 }] }],
    });
    expect(ids(b, "statement.history")).toEqual(["MISSING"]);
    expect(netWorthAtBlockers(b, "2025-06-30")).toHaveLength(0);
    expect(netWorthAtBlockers(b, "2025-06-29")).toHaveLength(1);
    expect(netWorthBlockers(b, "2025-07-01", "2025-12-31")).toHaveLength(0);
    expect(netWorthBlockers(b, "2025-01-01", "2025-12-31")).toHaveLength(1);
  });
});

describe("a partner's own accounts join the household at the merge date (2024-12-01)", () => {
  const persons = [
    { id: "pat", name: "Pat", match: ["PAT"] },
    { id: "lee", name: "Lee", match: ["LEE"] },
  ];
  const joint = { id: "chk", name: "Checking ••1234", subtype: "CHECKING", institution: "Bank", idents: ["1234"], segs: [{ start: "2024-01-01", end: "2025-12-31", open: 0, close: 0 }] };
  const savings = (name: string, start: string) => ({ id: "sav", name, subtype: "SAVINGS", institution: "Bank", idents: ["7777"], segs: [{ start, end: "2025-12-31", open: 5000, close: 5100 }] });

  it("needs no history before a first statement that predates the merge", () => {
    const b = makeBook({ persons, accounts: [joint, savings("Savings — Lee ••7777", "2024-09-01")] });
    expect(ids(b, "statement.history")).toEqual([]);
    expect(b.integrity.inferences.filter((i) => i.check === "statement.history").map((i) => i.title)).toEqual([
      "Savings — Lee ••7777: joins the household at its first statement (2024-09-01)",
    ]);
    expect(netWorthBlockers(b, "2024-01-01", "2025-12-31")).toHaveLength(0);
    expect(blockersFor(b, { affects: "CASH_FLOW", from: "2024-01-01", to: "2025-12-31" })).toHaveLength(0);
  });

  it("still needs history back to the merge date when the first statement comes after it", () => {
    const b = makeBook({ persons, accounts: [joint, savings("Savings — Lee ••7777", "2025-03-01")] });
    expect(ids(b, "statement.history")).toEqual(["MISSING"]);
    expect(netWorthAtBlockers(b, "2024-11-30")).toHaveLength(0);
    expect(netWorthAtBlockers(b, "2024-12-01")).toHaveLength(1);
    expect(blockersFor(b, { affects: "CASH_FLOW", from: "2024-11-30", to: "2024-11-30" })).toHaveLength(0);
    expect(blockersFor(b, { affects: "CASH_FLOW", from: "2025-02-28", to: "2025-02-28" })).toHaveLength(1);
  });

  it("still needs full history for the first member's and joint accounts", () => {
    for (const name of ["Savings — Pat ••7777", "Savings ••7777"]) {
      const b = makeBook({ persons, accounts: [joint, savings(name, "2024-09-01")] });
      expect(ids(b, "statement.history")).toEqual(["MISSING"]);
      expect(netWorthAtBlockers(b, "2024-03-31")).toHaveLength(1);
    }
  });
});

describe("gating is limited to the dates actually missing", () => {
  const card = (segs: Seg[]) => ({ id: "card", name: "Card ••9999", subtype: "CREDIT_CARD", institution: "Card Co", idents: ["9999"], segs });

  it("blocks a card's cash flow and net worth only from the first missing day: June in a month view, not May", () => {
    const b = makeBook({
      accounts: [
        checking([]),
        card([
          { start: "2025-04-10", end: "2025-06-09", open: 0, close: -500 },
          { start: "2025-07-10", end: "2025-08-09", open: -200, close: -200 },
        ]),
      ],
    });
    expect(blockersFor(b, { affects: "CASH_FLOW", from: "2025-05-01", to: "2025-05-31" })).toHaveLength(0);
    expect(blockersFor(b, { affects: "CASH_FLOW", from: "2025-06-01", to: "2025-06-30" })).toHaveLength(1);
    expect(blockersFor(b, { affects: "CASH_FLOW", from: "2025-06-09", to: "2025-06-09" })).toHaveLength(0);
    expect(blockersFor(b, { affects: "CASH_FLOW", from: "2025-06-10", to: "2025-06-10" })).toHaveLength(1);
    expect(netWorthBlockers(b, "2025-05-01", "2025-05-31")).toHaveLength(0);
    expect(netWorthBlockers(b, "2025-06-01", "2025-06-30")).toHaveLength(1);
  });

  it("blocks an investment account only from the day after its last statement", () => {
    const b = makeBook({
      accounts: [checking([]), { id: "brk", name: "Brokerage", subtype: "BROKERAGE", segs: [{ start: "2025-01-01", end: "2025-03-31", open: 5000, close: 5000 }, { start: "2025-04-01", end: "2025-06-30", open: 5000, close: 5000 }, { start: "2025-07-01", end: "2025-09-30", open: 5000, close: 5000 }] }],
      today: "2026-03-31",
    });
    expect(netWorthAtBlockers(b, "2025-09-30")).toHaveLength(0);
    expect(netWorthAtBlockers(b, "2025-10-01")).toHaveLength(1);
    expect(netWorthBlockers(b, "2025-09-01", "2025-09-30")).toHaveLength(0);
    expect(netWorthBlockers(b, "2025-10-01", "2025-10-31")).toHaveLength(1);
  });

  it("blocks tax-relevant pay only from the stub whose deposit isn't on a statement, not the months before", () => {
    const b = makeBook({
      accounts: [checking([{ date: "2025-01-15", cents: 100, key: "ACME", id: "r1" }])],
      stubs: [stub("2025-01-15", 100, 100, "r1"), stub("2025-08-28", 100, 200, null)],
    });
    expect(ids(b, "paystub.deposit")).toHaveLength(1);
    expect(blockersFor(b, { affects: "PAY", from: "2025-01-01", to: "2025-07-31" }).filter((f) => f.check === "paystub.deposit")).toHaveLength(0);
    expect(blockersFor(b, { affects: "PAY", from: "2025-08-01", to: "2025-08-31" }).filter((f) => f.check === "paystub.deposit")).toHaveLength(1);
    expect(blockersFor(b, { affects: "TAX", from: "2025-01-01", to: "2025-12-31" }).filter((f) => f.check === "paystub.deposit")).toHaveLength(1);
  });
});

describe("the data edge", () => {
  // Checking is on file through Nov; the card only through Sep 30 (the edge). Payments to
  // the card after the edge can't pair yet: the card's statements haven't arrived.
  const edgeBook = (payments: { date: string; cents: number }[]) => {
    const rows = payments.map((p, i) => ({ date: p.date, cents: p.cents, lane: "TRANSFER" as Lane, payee: "Payment to card 5678", id: `pay${i}` }));
    return makeBook({
      today: "2025-12-15",
      horizon: { cashFlow: "2025-11-30", netWorth: "2025-09-30" },
      accounts: [
        { id: "chk", name: "Checking ••1234", subtype: "CHECKING", institution: "Bank", idents: ["1234"], segs: [{ start: "2025-01-01", end: "2025-11-30", open: 0, close: rows.reduce((s, r) => s + r.cents, 0), rows }] },
        { id: "card", name: "Card ••5678", subtype: "CREDIT_CARD", institution: "Issuer", idents: ["5678"], segs: [{ start: "2025-01-01", end: "2025-09-30", open: 0, close: 0 }] },
      ],
    });
  };

  it("marks a finding that starts after the edge, and it withholds nothing up to the edge", () => {
    const b = edgeBook([{ date: "2025-10-02", cents: -500 }]);
    const [f] = b.integrity.findings.filter((x) => x.check === "transfer.unmatched");
    expect(f).toMatchObject({ status: "MISSING", atEdge: true, date: "2025-10-02" });
    // Its matching window reaches back to Sep 29, but the edge holds: September stays proven.
    expect(blockersFor(b, { affects: "CASH_FLOW", from: "2025-09-01", to: "2025-09-30" })).toEqual([]);
    expect(netWorthAtBlockers(b, "2025-09-30")).toEqual([]);
    expect(blockersFor(b, { affects: "CASH_FLOW", from: "2025-10-01", to: "2025-10-31" }).map((x) => x.id)).toEqual([f!.id]);
  });

  it("pulls cash flow back to the last whole month before the first finding past the edge", () => {
    expect(cashFlowThrough(edgeBook([{ date: "2025-11-12", cents: -500 }]))).toBe("2025-10-31");
    // Never before the edge itself.
    expect(cashFlowThrough(edgeBook([{ date: "2025-10-02", cents: -500 }]))).toBe("2025-09-30");
    // Nothing open past the edge: cash flow runs as far as its statements go.
    expect(cashFlowThrough(edgeBook([]))).toBe("2025-11-30");
  });

  it("doesn't mark findings inside the proven range", () => {
    const b = edgeBook([{ date: "2025-06-10", cents: -500 }]);
    const [f] = b.integrity.findings.filter((x) => x.check === "transfer.unmatched");
    expect(f).toMatchObject({ status: "FAIL" });
    expect(f!.atEdge).toBeUndefined();
  });
});

describe("permanent exceptions", () => {
  // The same household before and after a database rebuild: every database id differs.
  const gapCard = (id: string, idents = ["9999"]) => ({
    id,
    name: "Card ••9999",
    subtype: "CREDIT_CARD",
    institution: "Card Co",
    idents,
    segs: [
      { start: "2025-01-01", end: "2025-01-31", open: 0, close: -500 },
      { start: "2025-05-01", end: "2025-05-31", open: -200, close: -200 },
    ],
  });
  const before = () => makeBook({ accounts: [checking([]), gapCard("card")], stubs: [stub("2025-01-15", 100, 100, null)] });
  const exceptionFor = (b: Book, check: string): StandingException => {
    const f = b.integrity.findings.find((x) => x.check === check)!;
    return { id: f.id, check: f.check, accounts: f.accounts, note: "Explained", acceptedAt: "2025-06-01T00:00:00.000Z", finding: { status: f.status, title: f.title, detail: f.detail, scope: f.scope } };
  };

  it("raises the same finding ids after a rebuild, with no database ids in them", () => {
    const a = before();
    const rebuilt = makeBook({
      accounts: [{ ...checking([]), id: "chk-rebuilt" }, gapCard("card-rebuilt")],
      stubs: [{ ...stub("2025-01-15", 100, 100, null), id: "stub-rebuilt", documentId: "doc-rebuilt" }],
    });
    const idsOf = (b: Book) => b.integrity.findings.map((f) => f.id).sort();
    expect(idsOf(a).length).toBeGreaterThan(0);
    expect(idsOf(rebuilt)).toEqual(idsOf(a));
    for (const id of idsOf(a)) expect(id).not.toMatch(/\bcard\b|\bchk\b|s-2025/);
  });

  it("applies an accepted exception again after a rebuild", () => {
    const ex = exceptionFor(before(), "statement.gap");
    const rebuilt = makeBook({ accounts: [{ ...checking([]), id: "chk-rebuilt" }, gapCard("card-rebuilt")], exceptions: [ex] });
    expect(rebuilt.integrity.findings.some((f) => f.check === "statement.gap")).toBe(false);
    expect(rebuilt.integrity.accepted.map((f) => f.exceptionId)).toEqual([ex.id]);
    expect(rebuilt.integrity.stale).toEqual([]);
    expect(netWorthAtBlockers(rebuilt, "2025-03-31")).toHaveLength(0);
  });

  it("still matches when the account is reissued under another number", () => {
    const ex = exceptionFor(before(), "statement.gap");
    // A new identifier that sorts first changes the id's account reference; the shared one still matches.
    const reissued = makeBook({ accounts: [checking([]), gapCard("card", ["0001", "9999"])], exceptions: [ex] });
    expect(reissued.integrity.findings.some((f) => f.check === "statement.gap")).toBe(false);
    expect(reissued.integrity.accepted[0]!.id).not.toBe(ex.id);
    expect(reissued.integrity.accepted[0]!.exceptionId).toBe(ex.id);
  });

  it("keeps an exception whose finding no longer arises, for review, with what changed", () => {
    const ex = exceptionFor(before(), "statement.gap");
    const filled = makeBook({
      accounts: [
        checking([]),
        { ...gapCard("card"), segs: [...gapCard("card").segs, { start: "2025-02-01", end: "2025-04-30", open: -500, close: -200 }] },
      ],
      exceptions: [ex],
    });
    expect(filled.integrity.accepted).toEqual([]);
    expect(filled.integrity.stale.map((e) => e.id)).toEqual([ex.id]);
    // No import is newer than the exception: says the check changed rather than guessing.
    expect(filled.integrity.stale[0]!.evidence.join(" ")).toMatch(/code changed/);
    filled.statements.push({ id: "st", accountId: "card", documentId: "d2", documentTitle: "card-feb-apr.pdf", importedAt: "2025-07-01T00:00:00.000Z", status: "COMMITTED", isSummary: false, periodStart: "2025-02-01", periodEnd: "2025-04-30", deltaCents: 0 });
    expect(staleEvidence(filled, filled.integrity, ex).join(" ")).toMatch(/card-feb-apr\.pdf/);
  });
});

describe("check passes carry their evidence", () => {
  const busy = () =>
    makeBook({
      accounts: [
        checking([{ date: "2025-01-15", cents: 100, key: "ACME", id: "r1" }, { date: "2025-01-31", cents: 100, key: "ACME", id: "r2" }, { date: "2025-02-10", cents: -40, lane: "EXPENSE" }]),
        { id: "card", name: "Card ••5678", subtype: "CREDIT_CARD", institution: "Bank", idents: ["5678"], segs: [{ start: "2025-01-05", end: "2025-02-04", open: 0, close: -25, rows: [{ date: "2025-01-20", cents: -25, lane: "EXPENSE" }] }, { start: "2025-02-05", end: "2025-12-31", open: -25, close: -25 }] },
      ],
      stubs: [stub("2025-01-15", 100, 100, "r1"), stub("2025-01-31", 100, 200, "r2")],
    });

  it("records one piece of evidence per pass, so every check's tally equals its evidence", () => {
    const b = busy();
    expect(b.passes.length).toBeGreaterThan(10);
    for (const c of b.integrity.checks) expect(b.passes.filter((p) => p.check === c.id).reduce((t, p) => t + p.n, 0), c.id).toBe(c.passed);
  });

  it("names what passed in plain words, never by database id", () => {
    const b = busy();
    for (const p of b.passes) {
      expect(p.subject.length).toBeGreaterThan(0);
      expect(p.subject).not.toMatch(/\b(r1|r2|s-2025|chk-2025)\b/);
    }
    expect(b.passes.filter((p) => p.check === "statement.chain").map((p) => p.subject)).toContain("Card ••5678: 2025-01-05 – 2025-12-31, every opening = the previous closing");
  });

  it("keeps passes off the integrity report (the Statements page's payload)", () => {
    const b = busy();
    expect(Object.keys(b.integrity)).not.toContain("passes");
  });

  it("collects evidence with a scope and tallies n", () => {
    const c = new Collector();
    c.pass("tax.params", { subject: "2025 tax law", from: "2025-01-01", to: "2025-12-31", affects: ["TAX"] });
    c.pass("pay.unexplained-deposits", { subject: "two paychecks", accountId: "chk", from: "2025-01-15", to: "2025-01-31", affects: ["PAY", "TAX"] }, 2);
    expect(c.passes).toEqual([
      { check: "tax.params", n: 1, subject: "2025 tax law", scope: { from: "2025-01-01", to: "2025-12-31", affects: ["TAX"] } },
      { check: "pay.unexplained-deposits", n: 2, subject: "two paychecks", scope: { accountId: "chk", from: "2025-01-15", to: "2025-01-31", affects: ["PAY", "TAX"] } },
    ]);
    const r = c.report();
    expect(r.checks.find((x) => x.id === "pay.unexplained-deposits")!.passed).toBe(2);
    expect(r).not.toHaveProperty("passes");
  });

  it("finds the passes covering a figure by the same overlap as its blockers", () => {
    const b = busy();
    const held = (q: Parameters<typeof passesFor>[1]) => passesFor(b, q).filter((p) => p.check === "statement.chain").map((p) => p.scope.accountId);
    // The card's chain runs from its first statement (Jan 5): a window ending the day before misses it.
    expect(held({ affects: "CASH_FLOW", from: "2025-01-01", to: "2025-01-04" })).toEqual(["chk"]);
    expect(held({ affects: "CASH_FLOW", from: "2025-01-01", to: "2025-01-05" }).sort()).toEqual(["card", "chk"]);
    expect(held({ affects: "CASH_FLOW", from: "2025-03-01", to: "2025-03-31", accountIds: ["card"] })).toEqual(["card"]);
    // Pay passes never vouch for cash flow; household-wide ones cover every account filter.
    expect(passesFor(b, { affects: "CASH_FLOW", from: "2025-01-01", to: "2025-12-31" }).some((p) => p.check === "paystub.arithmetic")).toBe(false);
    expect(passesFor(b, { affects: "CASH_FLOW", from: "2025-06-01", to: "2025-06-30", accountIds: ["card"] }).some((p) => p.check === "ledger.freshness")).toBe(true);
  });
});
