import { describe, expect, it } from "vitest";
import type { Lane } from "../classifier/taxonomy";
import { CLASSIFIER_VERSION } from "../classifier/version";
import { NO_HOUSEHOLD } from "../household/patterns";
import { FACTS_VERSION } from "../ingest/factsVersion";
import { PARSER_VERSIONS } from "../ingest/parsers/index";
import { groupFor } from "../ledger/loadLedger";
import { buildNetWorthReport } from "../ledger/netWorthReport";
import { buildTimeline, type SegmentInput } from "../ledger/timeline";
import type { DecisionsFile, LegFingerprint } from "../transfers/decisionStore";
import { blockersFor, netWorthBlockers, taxBlockers } from "./blockers";
import { bookedOn, bookedShare } from "./booking";
import { runChecks } from "./checks/index";
import type { Book, BookAccount, BookDocument, BookRow, BookStub, BookTransferMatch } from "./load";
import { buildCashFlowReport } from "./reports/cashFlow";

// A synthetic household (all names, numbers and amounts invented).

type Row = { id: string; date: string; cents: number; lane?: Lane; precision?: "EXACT" | "PERIOD"; payee?: string };
type Seg = { start: string; end: string; open: number; close: number; rows?: Row[] };
type Acct = { id: string; name: string; subtype: string; institution: string; idents: string[]; segs: Seg[] };

const INVESTMENT = new Set(["401K", "ROLLOVER_IRA", "TRADITIONAL_IRA", "ROTH_IRA", "BROKERAGE"]);
const emptyDecisions: DecisionsFile = { version: 1, confirmed: [], rejected: [] };

function makeBook(opts: {
  accounts: Acct[];
  matches?: { id: string; status?: string; differenceCents?: number; rowIds: string[] }[];
  stubs?: BookStub[];
  documents?: BookDocument[];
  decisions?: Book["decisions"];
  classifiedWith?: number | null;
  today?: string;
}): Book {
  const rows: BookRow[] = [];
  const accounts: BookAccount[] = [];
  const ledgerAccounts: Book["ledger"]["accounts"] = [];
  const matchOf = new Map((opts.matches ?? []).flatMap((m) => m.rowIds.map((id) => [id, m.id] as const)));
  for (const a of opts.accounts) {
    const isInvestment = INVESTMENT.has(a.subtype);
    const type = a.subtype === "CREDIT_CARD" ? "CREDIT_CARD" : isInvestment ? "INVESTMENT" : "CHECKING";
    accounts.push({ id: a.id, name: a.name, institution: a.institution, type, subtype: a.subtype, group: groupFor(a.subtype, type), identifiers: a.idents });
    const segs: SegmentInput[] = a.segs.map((s) => {
      const statement = { start: s.start, end: s.end };
      const flows = (s.rows ?? []).map((r) => {
        const lane = r.lane ?? "EXPENSE";
        const precision = r.precision ?? "EXACT";
        rows.push({
          id: r.id, date: r.date, precision, statement, bookedOn: bookedOn({ date: r.date, statement }), amountCents: r.cents, lane, accountId: a.id,
          payee: r.payee ?? "X", merchantKey: null, category: lane === "INCOME" ? "Interest" : "Other", categoryGroup: null,
          counterpartyKind: null, counterpartyInstitution: null, counterpartyAccountHint: null, classifiedBy: null, transferMatchId: matchOf.get(r.id) ?? null, statementImportId: "st", documentId: "doc",
        });
        return { date: r.date, precision, amountCents: r.cents, lane };
      });
      // Committed statements always tie; whatever the rows leave unexplained is market change.
      const growthCents = s.close - s.open - flows.reduce((t, f) => t + f.amountCents, 0);
      return { accountId: a.id, periodStart: s.start, periodEnd: s.end, openingCents: s.open, closingCents: s.close, growthCents, feesCents: 0, flows };
    });
    ledgerAccounts.push({ id: a.id, name: a.name, institution: a.institution, type, subtype: a.subtype as never, group: groupFor(a.subtype, type), isInvestment, timeline: buildTimeline(a.id, segs), statementCount: segs.length, closed: false });
  }
  rows.sort((x, y) => x.date.localeCompare(y.date) || x.id.localeCompare(y.id));
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const matches: BookTransferMatch[] = (opts.matches ?? []).map((m) => ({
    id: m.id,
    status: m.status ?? "AUTO",
    differenceCents: m.differenceCents ?? 0,
    legs: m.rowIds.map((id) => ({ transactionId: id, accountId: rowById.get(id)!.accountId, date: rowById.get(id)!.date, amountCents: rowById.get(id)!.amountCents })),
  }));
  const today = opts.today ?? "2025-12-31";
  const firstDay = ledgerAccounts.map((a) => a.timeline.firstDay!).sort()[0]!;
  const lastDay = ledgerAccounts.map((a) => a.timeline.lastDay!).sort()[0]!;
  const book: Book = {
    today,
    horizon: { cashFlow: lastDay, netWorth: lastDay },
    ledger: { accounts: ledgerAccounts, mergeDate: "2024-12-01", completeThrough: lastDay, firstDay },
    accounts,
    statements: [],
    rows,
    rowById,
    stubs: opts.stubs ?? [],
    brokerage: [],
    holdings: [],
    matches,
    documents: opts.documents ?? [],
    decisions: opts.decisions ?? emptyDecisions,
    classifiedWith: opts.classifiedWith === undefined ? CLASSIFIER_VERSION : opts.classifiedWith,
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

const recheck = (b: Book) => {
  b.integrity = runChecks(b);
  return b;
};
const findings = (b: Book, check: string) => b.integrity.findings.filter((f) => f.check === check);
const passed = (b: Book, check: string) => b.integrity.checks.find((c) => c.id === check)!.passed;

// Checking pays the card each month; both statements are calendar months of 2025.
const months2025 = (fn: (m: string, start: string, end: string) => Partial<Seg>) =>
  ["01", "02", "03"].map((m) => {
    const end = m === "02" ? "2025-02-28" : `2025-${m}-31`;
    return { start: `2025-${m}-01`, end, open: 0, close: 0, ...fn(m, `2025-${m}-01`, end) };
  });
const bank = (): Acct => ({
  id: "chk",
  name: "Checking ••1111",
  subtype: "CHECKING",
  institution: "Bank Co",
  idents: ["1111"],
  segs: months2025((m) => ({ open: 100_000, close: 100_000, rows: [{ id: `pay-${m}`, date: `2025-${m}-10`, cents: -5_000, lane: "TRANSFER" }, { id: `inc-${m}`, date: `2025-${m}-15`, cents: 5_000, lane: "INCOME" }] })),
});
const card = (): Acct => ({
  id: "card",
  name: "Card ••2222",
  subtype: "CREDIT_CARD",
  institution: "Card Co",
  idents: ["2222"],
  segs: months2025((m) => ({ rows: [{ id: `buy-${m}`, date: `2025-${m}-05`, cents: -5_000 }, { id: `got-${m}`, date: `2025-${m}-11`, cents: 5_000, lane: "TRANSFER" }] })),
});
const paired = ["01", "02", "03"].map((m) => ({ id: `m-${m}`, rowIds: [`pay-${m}`, `got-${m}`] }));
const household = () => makeBook({ accounts: [bank(), card()], matches: paired });

describe("booking", () => {
  it("books an exact row on its date clamped into its statement, a period total spread across it", () => {
    const statement = { start: "2025-02-01", end: "2025-02-28" };
    expect(bookedOn({ date: "2025-01-30", statement })).toBe("2025-02-01");
    expect(bookedOn({ date: "2025-02-14", statement })).toBe("2025-02-14");
    expect(bookedShare({ date: "2025-01-30", precision: "EXACT", statement }, "2025-01-01", "2025-01-31")).toBe(0);
    const quarter = { start: "2025-10-01", end: "2025-12-31" };
    expect(bookedShare({ date: "2025-12-31", precision: "PERIOD", statement: quarter }, "2025-11-01", "2025-11-30")).toBeCloseTo(30 / 92);
  });

  it("puts a purchase listed before its statement's period in the month net worth puts it", () => {
    const c = card();
    c.segs[1]!.rows!.push({ id: "early", date: "2025-01-30", cents: -700 });
    c.segs[1]!.close = -700;
    c.segs[2]!.open = -700;
    c.segs[2]!.close = -700;
    const b = makeBook({ accounts: [bank(), c], matches: paired });
    const cf = buildCashFlowReport(b, { granularity: "month", from: "2025-01-01", to: "2025-03-31" });
    const nw = buildNetWorthReport(b.ledger, { granularity: "month", from: "2025-01-01", to: "2025-03-31" });
    expect(cf.periods.map((p) => p.spendingCents)).toEqual([5_000, 5_700, 5_000]);
    expect(nw.periods.map((p) => -p.household.spendingCents)).toEqual([5_000, 5_700, 5_000]);
    expect(findings(b, "ledger.consistency")).toEqual([]);
  });
});

describe("the ledger agrees with itself", () => {
  it("passes a household whose rows, timelines and pairings agree", () => {
    const b = household();
    expect(findings(b, "ledger.consistency")).toEqual([]);
    expect(passed(b, "ledger.consistency")).toBeGreaterThan(0);
  });

  it("fails a segment that doesn't tie, and withholds that account's figures", () => {
    const b = household();
    b.ledger.accounts[1]!.timeline.segments[1]!.closing -= 100;
    recheck(b);
    expect(findings(b, "ledger.consistency").map((f) => f.title)).toEqual(["Card ••2222: the ledger's 2025-02-01 – 2025-02-28 segment doesn't tie"]);
    // (The statement chain into March breaks too, and says so separately.)
    expect(netWorthBlockers(b, "2025-02-01", "2025-02-28", ["card"]).map((f) => f.check)).toContain("ledger.consistency");
    expect(netWorthBlockers(b, "2025-02-01", "2025-02-28", ["chk"])).toHaveLength(0);
  });

  it("fails two statements covering the same days", () => {
    const b = household();
    const t = b.ledger.accounts[0]!.timeline;
    t.segments.splice(1, 0, { ...t.segments[1]!, start: t.segments[1]!.start + 10, exact: [] });
    t.segments[1]!.closing = t.segments[1]!.opening + t.segments[1]!.growth;
    recheck(b);
    expect(findings(b, "ledger.consistency").some((f) => /two statements cover/.test(f.title))).toBe(true);
  });

  it("fails when an account's rows and its timeline book different amounts", () => {
    const b = household();
    const extra = { ...b.rowById.get("inc-02")!, id: "ghost", amountCents: 1_234 };
    b.rows.push(extra);
    b.rowById.set(extra.id, extra);
    recheck(b);
    const f = findings(b, "ledger.consistency");
    expect(f).toHaveLength(1);
    expect(f[0]!.title).toBe("Checking ••1111: cash flow and net worth disagree from 2025-02");
    expect(f[0]!.detail).toMatch(/INCOME \$12\.34/);
  });

  it("fails a pairing whose legs don't net to zero or that holds a row no longer filed as a transfer", () => {
    const b = household();
    b.matches[0]!.legs[1]!.amountCents += 1;
    const leg = b.rowById.get("got-02")!;
    leg.lane = "EXPENSE";
    recheck(b);
    const titles = findings(b, "ledger.consistency").map((f) => `${f.title} — ${f.detail}`);
    expect(titles.some((t) => /2025-01-10.*broken.*net to \$0\.01/.test(t))).toBe(true);
    expect(titles.some((t) => /2025-02-10.*broken.*no longer filed as a transfer/.test(t))).toBe(true);
  });

  it("fails a pay stub linked to a deposit of a different amount", () => {
    const stub = { id: "s1", documentId: "d", documentTitle: "stub.pdf", importedAt: "2025-02-01T00:00:00.000Z", source: "ADP", employee: "Pat Example", employer: "Acme", employerKey: "ACME", personId: "pat", payDate: "2025-01-15", periodStart: null, periodEnd: null, federalFilingStatus: null, lines: [{ name: "Regular", kind: "REGULAR", current: 4_999, ytd: 4_999 }], printed: { grossCurrent: 4_999, grossYtd: 4_999, withheldCurrent: 0, withheldYtd: 0, netCurrent: 4_999, netYtd: 4_999 }, deposits: [{ last4: "1111", amount: 4_999 }], warnings: [], depositTransactionId: "inc-01" } as BookStub;
    const b = makeBook({ accounts: [bank(), card()], matches: paired, stubs: [stub] });
    expect(findings(b, "ledger.consistency").map((f) => f.title)).toEqual(["Acme stub 2025-01-15 is linked to the wrong deposit"]);
  });
});

describe("everything was read by the current code", () => {
  const doc = (parserId: string, v: Partial<BookDocument> = {}): BookDocument => ({ id: `d-${parserId}`, title: `${parserId}.pdf`, institution: "X", parserId, parserVersion: PARSER_VERSIONS[parserId]!, factsVersion: FACTS_VERSION, periodStart: "2025-02-01", periodEnd: "2025-02-28", ...v });

  it("passes when every document, fact and row is current", () => {
    const b = makeBook({ accounts: [bank(), card()], matches: paired, documents: [doc("chase-checking"), doc("adp-paystub")] });
    expect(findings(b, "ledger.freshness")).toEqual([]);
  });

  it("withholds the figures a document read by an older parser feeds, with how to re-read it", () => {
    const b = makeBook({
      accounts: [bank(), card()],
      matches: paired,
      documents: [doc("chase-checking", { parserVersion: 0 }), doc("adp-paystub", { parserVersion: 0, periodStart: null, periodEnd: "2025-03-15" })],
    });
    const f = findings(b, "ledger.freshness");
    expect(f.map((x) => x.id)).toEqual([`ledger.freshness:parser:chase-checking:v${PARSER_VERSIONS["chase-checking"]}`, `ledger.freshness:parser:adp-paystub:v${PARSER_VERSIONS["adp-paystub"]}`]);
    expect(f[0]!.fix).toMatch(/Scan statements folder/);
    expect(f[0]!.scope).toMatchObject({ from: "2025-02-01", to: "2025-02-28", affects: ["CASH_FLOW", "NET_WORTH"] });
    expect(f[1]!.scope.affects).toEqual(["PAY", "TAX"]);
  });

  it("reports facts read by an older extractor", () => {
    const b = makeBook({ accounts: [bank(), card()], matches: paired, documents: [doc("vanguard-brokerage", { factsVersion: FACTS_VERSION - 1 })] });
    expect(findings(b, "ledger.freshness").map((f) => f.id)).toEqual([`ledger.freshness:facts:v${FACTS_VERSION}`]);
  });

  it("withholds cash flow, pay and taxes (not net worth) until rows are filed by the current rules", () => {
    const b = makeBook({ accounts: [bank(), card()], matches: paired, classifiedWith: null });
    expect(findings(b, "ledger.freshness").map((f) => f.id)).toEqual([`ledger.freshness:rules:v${CLASSIFIER_VERSION}`]);
    expect(blockersFor(b, { affects: "CASH_FLOW", from: "2025-01-01", to: "2025-01-31" })).toHaveLength(1);
    expect(netWorthBlockers(b, "2025-01-01", "2025-01-31")).toHaveLength(0);
  });
});

describe("the owner's transfer decisions are in force", () => {
  const leg = (accountId: "chk" | "card", date: string, amountCents: number): LegFingerprint =>
    accountId === "chk" ? { institution: "Bank Co", identifiers: ["1111"], date, amountCents } : { institution: "Card Co", identifiers: ["2222"], date, amountCents };
  const confirmed = (legs: LegFingerprint[]): DecisionsFile => ({ version: 1, confirmed: [{ legs, differenceCents: 0, note: "mine", confirmedAt: "2025-04-01T00:00:00.000Z" }], rejected: [] });
  const jan = [leg("chk", "2025-01-10", -5_000), leg("card", "2025-01-11", 5_000)];

  it("passes a confirmed pairing that's paired in the ledger", () => {
    const b = makeBook({ accounts: [bank(), card()], matches: paired.map((m) => ({ ...m, status: "CONFIRMED" })), decisions: confirmed(jan) });
    expect(findings(b, "transfer.decisions")).toEqual([]);
    expect(passed(b, "transfer.decisions")).toBe(1);
  });

  it("says why a confirmed pairing isn't applied: a leg missing, two candidates, or not paired yet", () => {
    const missing = makeBook({ accounts: [bank(), card()], matches: paired, decisions: confirmed([leg("chk", "2025-01-09", -5_000), jan[1]!]) });
    expect(findings(missing, "transfer.decisions")[0]!.detail).toMatch(/2025-01-09 −\$50\.00 \(Bank Co ••1111\) isn't on any statement/);

    const c = card();
    c.segs[0]!.rows!.push({ id: "twin", date: "2025-01-11", cents: 5_000, lane: "TRANSFER" }, { id: "buy2", date: "2025-01-12", cents: -5_000 });
    const ambiguous = makeBook({ accounts: [bank(), c], matches: paired, decisions: confirmed(jan) });
    expect(findings(ambiguous, "transfer.decisions")[0]!.detail).toMatch(/matches 2 rows/);

    const unpaired = makeBook({ accounts: [bank(), card()], matches: paired.slice(1), decisions: confirmed(jan) });
    const f = findings(unpaired, "transfer.decisions")[0]!;
    expect(f.detail).toMatch(/aren't paired together/);
    expect(f.scope).toMatchObject({ from: "2025-01-07", to: "2025-01-14" });
  });

  it("fails a pairing the owner rejected that's paired again", () => {
    const b = makeBook({ accounts: [bank(), card()], matches: paired, decisions: { version: 1, confirmed: [], rejected: [{ legs: jan, rejectedAt: "2025-04-01T00:00:00.000Z" }] } });
    expect(findings(b, "transfer.decisions").map((f) => f.title)).toEqual(["A pairing you rejected is paired again: 2025-01-10 −$50.00 (Bank Co ••1111) ↔ 2025-01-11 $50.00 (Card Co ••2222)"]);
  });

  it("withholds every figure a damaged decisions file could touch, rather than dropping the decisions", () => {
    const b = makeBook({ accounts: [bank(), card()], matches: paired, decisions: { error: "not valid JSON" } });
    expect(findings(b, "transfer.decisions").map((f) => f.id)).toEqual(["transfer.decisions:file"]);
    expect(netWorthBlockers(b, "2025-03-01", "2025-03-31")).toHaveLength(1);
  });
});

describe("tax law for the year is in the app", () => {
  it("withholds a year's taxes until its parameters are added", () => {
    const b = makeBook({ accounts: [bank(), card()], matches: paired, today: "2031-02-01" });
    expect(findings(b, "tax.params").map((f) => f.id)).toEqual(["tax.params:2030", "tax.params:2031"]);
    // The year in progress runs only to the data edge; a finished year is withheld whole.
    expect(taxBlockers(b, 2030).some((f) => f.id === "tax.params:2030")).toBe(true);
  });
});

describe("net worth reconciles month by month", () => {
  it("proves each month, measuring a quarterly statement's undated transfer the way the ledger spreads it", () => {
    // A 401(k)'s Q4 statement gives a rollover only as a period total; the IRA receives it on Jan 5.
    const plan: Acct = { id: "plan", name: "401(k)", subtype: "401K", institution: "Plan Co", idents: ["P1"], segs: [{ start: "2025-10-01", end: "2025-12-31", open: 30_000_00, close: 0, rows: [{ id: "out", date: "2025-12-31", cents: -30_000_00, lane: "TRANSFER", precision: "PERIOD" }] }] };
    const ira: Acct = { id: "ira", name: "Rollover IRA", subtype: "ROLLOVER_IRA", institution: "Broker Co", idents: ["R1"], segs: [{ start: "2025-10-01", end: "2025-12-31", open: 0, close: 0 }, { start: "2026-01-01", end: "2026-01-31", open: 0, close: 30_000_00, rows: [{ id: "in", date: "2026-01-05", cents: 30_000_00, lane: "TRANSFER" }] }] };
    plan.segs.push({ start: "2026-01-01", end: "2026-01-31", open: 0, close: 0 });
    const b = makeBook({ accounts: [plan, ira], matches: [{ id: "roll", status: "CONFIRMED", rowIds: ["out", "in"] }], today: "2026-02-10" });
    expect(findings(b, "networth.reconciles")).toEqual([]);
    expect(passed(b, "networth.reconciles")).toBe(4);
  });

  it("still catches a month whose transfers don't net out", () => {
    // February comes from a year-end summary (no rows of its own) that books a transfer
    // nothing on file pairs with — the one case the row-level checks can't see.
    const b0 = bank();
    const c0 = card();
    b0.segs[1]!.rows = [];
    c0.segs[1]!.rows = [];
    const b = makeBook({ accounts: [b0, c0], matches: [paired[0]!, paired[2]!] });
    const feb = b.ledger.accounts[0]!.timeline.segments[1]!;
    feb.derived = true;
    feb.spread.push({ amount: -1_00, lane: "TRANSFER" });
    feb.growth += 1_00;
    recheck(b);
    expect(findings(b, "ledger.consistency")).toEqual([]);
    expect(findings(b, "networth.reconciles").map((x) => x.id)).toEqual(["networth.reconciles:2025-02"]);
  });
});
