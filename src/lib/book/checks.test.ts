import { describe, expect, it } from "vitest";
import type { Lane } from "../classifier/taxonomy";
import { CLASSIFIER_VERSION } from "../classifier/version";
import { compileHousehold, NO_HOUSEHOLD, type HouseholdPatterns } from "../household/patterns";
import type { StubLine } from "../ingest/payroll/types";
import { groupFor } from "../ledger/loadLedger";
import { buildTimeline, type SegmentInput } from "../ledger/timeline";
import { blockersFor, netWorthAtBlockers, netWorthBlockers, passesFor, taxBlockers } from "./blockers";
import { runChecksWithPasses } from "./checks/index";
import { Collector } from "./checks/collector";
import { checkHoldings } from "./checks/holdings";
import { checkHsaContributions } from "./checks/hsa";
import { staleEvidence } from "./exceptions";
import { cashFlowThrough, type Book, type BookAccount, type BookRow, type BookStub } from "./load";
import { estimatesFor } from "./proof/common";
import { buildCashFlowReport } from "./reports/cashFlow";
import { bookTotalsFor } from "./rowTotals";
import type { StandingException } from "./types";
import { TAX_DOCS_VERSION } from "../taxdocs/store";
import { LP_CAPITAL_PARSER_ID, VERSION as LP_CAPITAL_VERSION } from "../ingest/parsers/lpCapitalStatement";
import { buildStatementPlan } from "./reports/statementPlan";
import type { TaxDocsFile } from "../taxdocs/types";

// A tiny synthetic household (all names and amounts invented).

type Seg = { start: string; end: string; open: number; close: number; rows?: { date: string; cents: number; lane?: Lane; payee?: string; key?: string; id?: string }[] };

function makeBook(opts: {
  accounts: { id: string; name: string; subtype: string; institution?: string; idents?: string[]; segs: Seg[] }[];
  stubs?: BookStub[];
  today?: string;
  exceptions?: StandingException[];
  horizon?: Book["horizon"];
  persons?: Book["persons"];
  taxDocs?: TaxDocsFile | null;
  /** Adds to the Book (statements, documents, row details) before the checks run. */
  before?: (book: Book) => void;
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
    taxDocs: opts.taxDocs ?? null,
    persons: opts.persons ?? [{ id: "pat", name: "Pat", match: ["PAT"] }],
    idle: { proven: [], unproven: [] },
    integrity: { checks: [], findings: [], inferences: [], accepted: [], stale: [], retired: [] },
    passes: [],
  };
  opts.before?.(book);
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
    // But not the months the stubs on file already prove.
    expect(blockersFor(b, { affects: "PAY", personId: "pat", from: "2025-01-01", to: "2025-01-15" })).toEqual([]);
    expect(blockersFor(b, { affects: "TAX", from: "2025-01-01", to: "2025-01-15" })).toEqual([]);
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

  it("withholds nothing before its own date when cash flow runs past the edge", () => {
    // Nov 1's matching window reaches back to Oct 29: past the edge (Sep 30), but cash flow
    // runs to Oct 31, and October must stay proven there.
    const b = edgeBook([{ date: "2025-11-01", cents: -500 }]);
    const [f] = b.integrity.findings.filter((x) => x.check === "transfer.unmatched");
    expect(f).toMatchObject({ atEdge: true, date: "2025-11-01" });
    expect(cashFlowThrough(b)).toBe("2025-10-31");
    expect(blockersFor(b, { affects: "CASH_FLOW", from: "2025-01-01", to: "2025-10-31" })).toEqual([]);
    expect(netWorthAtBlockers(b, "2025-10-31").map((x) => x.id)).not.toContain(f!.id);
    expect(blockersFor(b, { affects: "CASH_FLOW", from: "2025-11-01", to: "2025-11-30" }).map((x) => x.id)).toEqual([f!.id]);
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

describe("a payment to a private fund whose statement isn't out yet", () => {
  // Checking is on file through Nov; the fund's one capital statement ends Sep 30 (the edge).
  type Acct = Parameters<typeof makeBook>[0]["accounts"][number];
  const fund = (id = "fund", idents = ["7788"], subtype = "OTHER"): Acct => ({ id, name: `Example Partners LP ••${idents[0]}`, subtype, institution: "Example Partners", idents, segs: [{ start: "2025-07-01", end: "2025-09-30", open: 0, close: 0 }] });
  const fundBook = (o: { date?: string; payee?: string; cents?: number; others?: Acct[]; lp?: string[]; edit?: (r: BookRow) => void; on?: Acct; household?: HouseholdPatterns } = {}) => {
    const row = { date: o.date ?? "2025-10-14", cents: o.cents ?? -25_000, lane: "TRANSFER" as Lane, payee: o.payee ?? "ONLINE TRANSFER TO ACCT 7788", id: "wire" };
    const from = o.on ?? { id: "chk", name: "Checking ••1234", subtype: "CHECKING", institution: "Bank", idents: ["1234"], segs: [{ start: "2025-01-01", end: "2025-11-30", open: 100_000, close: 100_000 + row.cents, rows: [row] }] };
    const lp = o.lp ?? ["fund"];
    const b = makeBook({
      today: "2025-12-15",
      horizon: { cashFlow: "2025-11-30", netWorth: "2025-09-30" },
      accounts: [from, ...(o.others ?? [fund()])],
      before: (book) => {
        for (const id of lp) {
          book.documents.push({ id: `doc-${id}`, title: "Fund capital statement", institution: "Example Partners", parserId: LP_CAPITAL_PARSER_ID, parserVersion: LP_CAPITAL_VERSION, factsVersion: 0, periodStart: "2025-07-01", periodEnd: "2025-09-30" });
          book.statements.push({ id: `st-${id}`, accountId: id, documentId: `doc-${id}`, documentTitle: "fund.pdf", importedAt: "2025-10-20T00:00:00.000Z", status: "COMMITTED", isSummary: false, periodStart: "2025-07-01", periodEnd: "2025-09-30", deltaCents: 0 });
        }
        if (o.edit) o.edit(book.rowById.get("wire")!);
        if (o.household) book.household = o.household;
      },
    });
    b.horizon.cashFlow = cashFlowThrough(b);
    return b;
  };
  const finding = (b: Book) => b.integrity.findings.find((f) => f.check === "transfer.unmatched")!;
  const strict = (b: Book) => {
    expect(finding(b)).toMatchObject({ scope: { affects: ["CASH_FLOW", "NET_WORTH"] } });
    expect(blockersFor(b, { affects: "CASH_FLOW", from: "2025-10-01", to: "2025-10-31" }).map((f) => f.id)).toContain(finding(b).id);
  };

  it("holds back net worth only: still missing, cash flow and taxes run past it", () => {
    const b = fundBook();
    const f = finding(b);
    expect(f).toMatchObject({ status: "MISSING", atEdge: true, date: "2025-10-14", scope: { accountId: "chk", affects: ["NET_WORTH"] }, needs: { accountIds: ["fund"] } });
    expect(b.horizon.cashFlow).toBe("2025-11-30");
    expect(blockersFor(b, { affects: "CASH_FLOW", from: "2025-10-01", to: "2025-10-31" })).toEqual([]);
    expect(taxBlockers(b, 2025).map((x) => x.id)).not.toContain(f.id);
    expect(netWorthBlockers(b, "2025-10-01", "2025-10-31").map((x) => x.id)).toContain(f.id);
    // Still a transfer: never counted as spending.
    expect(b.rowById.get("wire")!.lane).toBe("TRANSFER");
    expect(buildCashFlowReport(b, { granularity: "month", from: "2025-10-01" }).periods.every((p) => p.spendingCents === 0)).toBe(true);
    // The fund's statement is still asked for, for net worth only.
    const next = buildStatementPlan(b).institutions.flatMap((i) => i.accounts).find((p) => p.accountId === "fund")!.statements.find((s) => s.settles.some((x) => x.id === f.id))!;
    expect(next.neededFrom).toEqual({ netWorth: "2025-10-01" });
  });

  it("stays strict when two accounts could hold the other leg", () => {
    strict(fundBook({ payee: "ONLINE TRANSFER TO ACCT 7788 / 5566", others: [fund(), fund("fund2", ["5566"])], lp: ["fund", "fund2"] }));
  });

  it("stays strict when the named account isn't a private fund", () => {
    strict(fundBook({ others: [fund("brk", ["7788"], "BROKERAGE")], lp: [] }));
    // An "Other" account with no fund capital statement on file isn't one either.
    strict(fundBook({ lp: [] }));
  });

  it("stays strict when only the institution points at the fund", () => {
    strict(fundBook({ payee: "ONLINE TRANSFER TO EXAMPLE PARTNERS", edit: (r) => (r.counterpartyInstitution = "Example Partners") }));
  });

  describe("a wire with no account number, matched by the household file's fund entry", () => {
    // The fund's statements came from an earlier reader (lp: []): the household file says it's a fund.
    const named = { ...fund(), name: "Example Growth Fund II LP (private equity) ••7788" };
    const entry = { institution: "Example Partners", statementName: "Example Growth Fund II LP", accountName: "Example Growth Fund II LP (private equity)", wirePattern: "EXAMPLE GROWTH FUND II\\b" };
    const wire = (payee: string, f: Partial<typeof entry> = {}) =>
      fundBook({
        payee,
        others: [named],
        lp: [],
        edit: (r) => (r.counterpartyInstitution = "Example Partners"),
        household: compileHousehold({ version: 1, funds: [{ ...entry, ...f }] }),
      });

    it("holds back net worth only when the fund's wire pattern names it", () => {
      const b = wire("Online Wire Transfer A/C: Example Growth Fund II New York NY Ref: Capitalcall");
      expect(finding(b)).toMatchObject({ status: "MISSING", atEdge: true, scope: { affects: ["NET_WORTH"] }, needs: { accountIds: ["fund"] } });
      expect(b.horizon.cashFlow).toBe("2025-11-30");
    });

    it("stays strict when the pattern doesn't match, the fund has no pattern, or the entry is another account's", () => {
      strict(wire("Online Wire Transfer A/C: Example Growth Fund III Ref: Capitalcall"));
      strict(wire("Online Wire Transfer A/C: Example Growth Fund II", { wirePattern: undefined }));
      strict(wire("Online Wire Transfer A/C: Example Growth Fund II", { accountName: "Example Value Fund I LP" }));
    });
  });

  it("stays strict for a gap inside the proven range", () => {
    // The fund's statements stop at June; a payment in September is before the edge.
    const inside = fundBook({ date: "2025-09-10", others: [{ ...fund(), segs: [{ start: "2025-01-01", end: "2025-06-30", open: 0, close: 0 }] }] });
    expect(finding(inside).atEdge).toBeUndefined();
    expect(finding(inside)).toMatchObject({ status: "MISSING", scope: { affects: ["CASH_FLOW", "NET_WORTH"] } });
  });

  it("stays strict for a card payment", () => {
    // Paid from a card rather than the bank: the bank-side condition fails.
    strict(fundBook({ on: { id: "card", name: "Card ••9999", subtype: "CREDIT_CARD", institution: "Card Co", idents: ["9999"], segs: [{ start: "2025-01-01", end: "2025-11-30", open: 0, close: -25_000, rows: [{ date: "2025-10-14", cents: -25_000, lane: "TRANSFER", payee: "ONLINE TRANSFER TO ACCT 7788", id: "wire" }] }] } }));
    // A bank payment to a card on file only through the edge.
    strict(fundBook({ payee: "PAYMENT TO CARD 7788", others: [{ ...fund("card", ["7788"], "CREDIT_CARD"), name: "Card ••7788" }], lp: [] }));
  });

  it("stays strict for money coming back from the fund, or a row awaiting review", () => {
    strict(fundBook({ cents: 25_000, payee: "TRANSFER FROM ACCT 7788" }));
    strict(fundBook({ edit: (r) => (r.needsReview = true) }));
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

describe("tax documents were read by the current reader (ledger.freshness)", () => {
  // An invented tax documents folder: Pat Example's 2024 W-2, and an older print a later one superseded.
  const taxDocs = (version: number): TaxDocsFile => ({
    version,
    scannedAt: "2025-03-01T00:00:00.000Z",
    folder: "Example tax folder",
    errors: [],
    docs: [
      { id: "w2-a", file: "2024/pat-w2.pdf", duplicates: [], year: 2024, kind: "W2", superseded: null, names: ["PAT EXAMPLE"], parsed: { kind: "OTHER" }, warnings: [] },
      { id: "w2-b", file: "2024/pat-w2-old.pdf", duplicates: [], year: 2024, kind: "W2", superseded: "An older print", names: ["PAT EXAMPLE"], parsed: { kind: "OTHER" }, warnings: [] },
    ],
  });
  const quiet = (docs: TaxDocsFile | null) =>
    makeBook({ accounts: [{ id: "chk", name: "Springfield Bank ••1234", subtype: "CHECKING", segs: [{ start: "2025-01-01", end: "2025-12-31", open: 0, close: 0 }] }], taxDocs: docs });
  const fresh = (b: Book) => b.integrity.findings.filter((f) => f.check === "ledger.freshness");
  const taxPasses = (b: Book) => b.passes.filter((p) => p.check === "ledger.freshness" && /tax documents reader/.test(p.subject));
  const tallyIsEvidence = (b: Book) => expect(b.passes.filter((p) => p.check === "ledger.freshness").reduce((t, p) => t + p.n, 0)).toBe(b.integrity.checks.find((c) => c.id === "ledger.freshness")!.passed);

  it("passes a folder read by the current reader, with what it covered", () => {
    const b = quiet(taxDocs(TAX_DOCS_VERSION));
    expect(fresh(b)).toEqual([]);
    expect(taxPasses(b)).toEqual([
      { check: "ledger.freshness", n: 1, subject: `1 tax document read by the current tax documents reader (version ${TAX_DOCS_VERSION})`, scope: { from: "2024-01-01", to: "2025-12-31", affects: ["TAX"] } },
    ]);
    // A tax figure's proof lists it; a cash-flow figure's doesn't.
    expect(passesFor(b, { affects: "TAX", from: "2024-01-01", to: "2024-12-31" }).some((p) => /tax documents reader/.test(p.subject))).toBe(true);
    expect(passesFor(b, { affects: "CASH_FLOW", from: "2024-01-01", to: "2024-12-31" }).some((p) => /tax documents reader/.test(p.subject))).toBe(false);
    tallyIsEvidence(b);
  });

  it("withholds taxes (only) while the folder was read by an older reader, with how to read it again", () => {
    const b = quiet(taxDocs(TAX_DOCS_VERSION - 1));
    const f = fresh(b);
    expect(f.map((x) => x.id)).toEqual([`ledger.freshness:taxdocs:v${TAX_DOCS_VERSION}`]);
    expect(f[0]!.title).toBe("1 tax document was read by an older tax documents reader");
    expect(f[0]!.detail).toMatch(new RegExp(`version ${TAX_DOCS_VERSION - 1} of the reader.*2024/pat-w2\\.pdf\\.$`));
    expect(f[0]!.fix).toMatch(/^Click Scan tax documents folder \(Statements → Import\)/);
    expect(f[0]!.scope).toEqual({ from: "2024-01-01", to: "2025-12-31", affects: ["TAX"] });
    expect(taxPasses(b)).toEqual([]);
    expect(blockersFor(b, { affects: "TAX", from: "2024-01-01", to: "2024-12-31" }).map((x) => x.id)).toEqual([f[0]!.id]);
    expect(blockersFor(b, { affects: "CASH_FLOW", from: "2024-01-01", to: "2025-12-31" }).filter((x) => x.check === "ledger.freshness")).toEqual([]);
    tallyIsEvidence(b);
  });

  it("says nothing about tax documents before the folder is first scanned", () => {
    const b = quiet(null);
    expect(fresh(b)).toEqual([]);
    expect(taxPasses(b)).toEqual([]);
    tallyIsEvidence(b);
  });
});

describe("single-source audit: what a committed statement and a row can't hide", () => {
  const statement = (over: Partial<Book["statements"][number]> = {}): Book["statements"][number] => ({
    id: "st1",
    accountId: "chk",
    documentId: "d1",
    documentTitle: "checking-jan.pdf",
    importedAt: "2025-02-01T00:00:00.000Z",
    status: "COMMITTED",
    isSummary: false,
    periodStart: "2025-01-01",
    periodEnd: "2025-01-31",
    deltaCents: 0,
    ...over,
  });
  const rerun = (b: Book) => {
    const r = runChecksWithPasses(b);
    b.integrity = r.report;
    b.passes = r.passes;
    return b;
  };

  it("fails a committed statement whose stored printed totals don't tie, whatever its status says", () => {
    const b = makeBook({ accounts: [checking([{ date: "2025-01-15", cents: 100 }])] });
    b.statements = [statement({ checks: [{ label: "Deposits total", expectedCents: 150, actualCents: 100, toleranceCents: 0 }] })];
    const f = rerun(b).integrity.findings.find((x) => x.check === "statement.held");
    expect(f?.status).toBe("FAIL");
    expect(f?.detail).toMatch(/printed \$1\.50, rows give \$1\.00/);
    // Within the parser's tolerance, it passes.
    b.statements = [statement({ checks: [{ label: "Deposits total", expectedCents: 101, actualCents: 100, toleranceCents: 2 }] })];
    expect(rerun(b).integrity.findings.filter((x) => x.check === "statement.held")).toEqual([]);
  });

  it("lists a statement whose market change is what the balances leave as an inference on its account", () => {
    const b = makeBook({ accounts: [checking([])] });
    b.statements = [statement({ growthDerived: true })];
    const inf = rerun(b).integrity.inferences.find((i) => i.id.startsWith("statement.growth:"));
    expect(inf?.scope).toMatchObject({ accountId: "chk", from: "2025-01-01", to: "2025-01-31" });
    expect(estimatesFor(b, { rowIds: new Set(), from: "2025-01-10", to: "2025-01-20", accountIds: ["chk"] }).map((e) => e.id)).toContain(inf!.id);
    expect(estimatesFor(b, { rowIds: new Set(), from: "2025-03-01", to: "2025-03-31", accountIds: ["chk"] }).map((e) => e.id)).not.toContain(inf!.id);
  });

  it("counts a row awaiting review as filed, and says so on the period and in its proof", () => {
    const b = makeBook({ accounts: [checking([{ date: "2025-01-15", cents: 1_000 }, { date: "2025-01-20", cents: -400, lane: "EXPENSE", id: "wire" }])] });
    const wire = b.rowById.get("wire")!;
    wire.needsReview = true;
    const jan = buildCashFlowReport(b, { granularity: "month", from: "2025-01-01", to: "2025-01-31" }).periods[0]!;
    expect(jan.spendingCents).toBe(400);
    expect(jan.unreviewed).toEqual({ rows: 1, cents: 400 });
    expect(estimatesFor(b, { rowIds: new Set(["wire"]), from: "2025-01-01", to: "2025-01-31" }).map((e) => e.id)).toContain("review:unanswered");
  });

  it("row viewers total the Book's amounts: a split payment's pieces and corrections count, a pending charge doesn't", () => {
    const b = makeBook({ accounts: [checking([{ date: "2025-01-15", cents: 1_000, id: "pay" }, { date: "2025-01-20", cents: -400, lane: "EXPENSE", id: "bill" }])] });
    const bill = b.rowById.get("bill")!;
    b.rows.push({ ...bill, id: "bill:part2", partOf: "bill", amountCents: -100 }, { ...bill, id: "bill:correction", amountCents: -5 }, { ...bill, id: "later", pending: true, amountCents: -70 });
    expect(bookTotalsFor(b, ["pay", "bill", "later", "gone"])).toEqual({ count: 4, inCents: 1_000, outCents: -505, pending: 1, notInLedger: 1 });
  });
});

describe("tax documents agree with the ledger", () => {
  const w2 = (wages: number): TaxDocsFile => ({
    version: TAX_DOCS_VERSION,
    scannedAt: "2026-02-15T00:00:00.000Z",
    folder: "tax",
    errors: [],
    docs: [
      {
        id: "w2pat",
        file: "2025/w2-pat.pdf",
        duplicates: [],
        year: 2025,
        kind: "W2",
        superseded: null,
        names: ["PAT EXAMPLE"],
        warnings: [],
        parsed: { kind: "W2", w2: { employer: "Example Partners LP", ein: null, employee: "PAT EXAMPLE", wages, federalWithheld: 0, ssWages: wages, ssWithheld: 0, medicareWages: wages, medicareWithheld: 0, dependentCare: 0, box12: [], states: [], locals: [] } },
      },
    ],
  });

  it("a W-2 the pay stubs can't corroborate is missing data for that year's pay and taxes", () => {
    const b = makeBook({ accounts: [checking([])], today: "2026-03-01", horizon: { cashFlow: "2025-12-31", netWorth: "2025-12-31" }, taxDocs: w2(5_000_000) });
    const f = b.integrity.findings.filter((x) => x.check === "tax.documents-tie");
    expect(f.length).toBeGreaterThan(0);
    expect(f.every((x) => x.status === "MISSING")).toBe(true);
    expect(f[0]!.scope).toMatchObject({ from: "2025-01-01", to: "2025-12-31", affects: ["PAY", "TAX"] });
    expect(blockersFor(b, { affects: "TAX", from: "2025-06-01", to: "2025-06-30" }).some((x) => x.check === "tax.documents-tie")).toBe(true);
  });
});

describe("holdings.ties", () => {
  const book = () =>
    makeBook({ accounts: [{ id: "brk", name: "Brokerage ••5678", subtype: "BROKERAGE", institution: "Bank", idents: ["5678"], segs: [{ start: "2025-01-01", end: "2025-03-31", open: 0, close: 1_000_000 }] }] });
  const snap = (b: Book, cents: number[], printed: number | null) =>
    ({ ...b, holdings: [{ id: "h", documentId: "d", institution: "Bank", accountNumber: "5678", accountId: "brk", asOf: "2025-03-31", positions: cents.map((v, i) => ({ symbol: `EX${i}`, name: "Example fund", kind: "FUND", quantity: null, price: null, valueCents: v, costBasisCents: null, expenseRatio: null })), printedTotalCents: printed, totalCents: cents.reduce((s, v) => s + v, 0) }] }) as Book;
  const run = (b: Book) => {
    const c = new Collector();
    checkHoldings(b, c);
    return c.report();
  };

  it("passes positions that add up to the balance and the printed total", () => {
    const r = run(snap(book(), [600_000, 400_000], 1_000_000));
    expect(r.findings).toEqual([]);
    expect(r.checks.find((c) => c.id === "holdings.ties")!.passed).toBe(1);
  });

  it("fails a list a row is missing from, on positions only", () => {
    const r = run(snap(book(), [600_000], null));
    expect(r.findings).toMatchObject([{ check: "holdings.ties", status: "FAIL", scope: { accountId: "brk", affects: ["HOLDINGS"] } }]);
    expect(r.findings[0]!.title).toContain("$10,000.00");
  });
});

describe("contributions.hsa", () => {
  const hsaStub = (date: string, employee: number, employer: number): BookStub => ({
    ...stub(date, 100_000, 100_000, null),
    id: `h-${date}`,
    lines: [
      { name: "Regular", kind: "REGULAR", current: 100_000, ytd: null },
      { name: "HSA", kind: "HSA", current: employee, ytd: null },
      { name: "Employer HSA", kind: "EMPLOYER_HSA", current: employer, ytd: null },
    ],
  });
  const stubs = ["2024-12-31", "2025-01-15", "2025-01-31", "2025-02-14", "2025-02-28", "2025-03-14", "2025-03-31", "2025-04-15"].map((d) => hsaStub(d, 10_000, 2_500));
  const book = (rows: Seg["rows"]) => {
    const b = makeBook({
      stubs,
      accounts: [{ id: "hsa", name: "HSA ••9012", subtype: "HSA", institution: "Bank", idents: ["9012"], segs: [{ start: "2025-02-01", end: "2025-02-28", open: 50_000, close: 50_000 + (rows ?? []).reduce((s, r) => s + r.cents, 0), rows }] }],
    });
    return { ...b, statements: [{ id: "st-hsa", accountId: "hsa", documentId: "d", documentTitle: "hsa.pdf", importedAt: "", status: "COMMITTED", isSummary: false, periodStart: "2025-02-01", periodEnd: "2025-02-28", deltaCents: 0 }] } as Book;
  };
  const run = (b: Book) => {
    const c = new Collector();
    checkHsaContributions(b, c);
    return c.report();
  };
  const dep = (date: string, cents: number) => ({ date, cents, lane: "CONTRIBUTION_EMPLOYEE" as Lane, payee: "Payroll contribution" });

  it("ties a period's payroll deposits to a run of paychecks, allowing for posting lag", () => {
    // Jan 31's money posts Feb 3; Feb 28's posts in March: the period holds two paychecks' worth.
    const r = run(book([dep("2025-02-03", 12_500), dep("2025-02-18", 12_500)]));
    expect(r.findings).toEqual([]);
    expect(r.checks.find((c) => c.id === "contributions.hsa")!.passed).toBe(1);
  });

  it("fails a period whose deposits no run of paychecks explains", () => {
    const r = run(book([dep("2025-02-03", 12_500), dep("2025-02-18", 9_000)]));
    expect(r.findings).toMatchObject([{ check: "contributions.hsa", status: "FAIL", scope: { accountId: "hsa", affects: ["PAY", "TAX"] } }]);
  });
});
