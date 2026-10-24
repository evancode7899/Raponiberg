import { describe, expect, it } from "vitest";
import type { Lane } from "../../classifier/taxonomy";
import { NO_HOUSEHOLD } from "../../household/patterns";
import { employerKey, type StubLine } from "../../ingest/payroll/types";
import { groupFor, refreshLedgerStatus, type LedgerAccount } from "../../ledger/loadLedger";
import { buildTimeline, type SegmentInput } from "../../ledger/timeline";
import type { Book, BookRow, BookStatement, BookStub } from "../load";
import { buildProof, parseDescriptor, type Proof, type ProofLink } from "./index";
import { buildRowProof, decidedBy } from "./rowProof";
import { buildStatementProof, printedRows } from "./statementProof";
import { buildStubProof } from "./stubProof";
import type { ProofFact } from "./types";

// An invented household: Pat Example at Springfield Bank, Jan – Feb 2025. Checking ••1234
// gets a paycheck from Example Partners LP (with its stub) and pays card ••5678, whose
// statement shows the payment and a grocery charge. Every name and amount is made up.

type Flow = { id: string; date: string; cents: number; lane: Lane; payee: string; category: string; classifiedBy?: string; match?: string; detail?: string };
type St = { id: string; account: string; from: string; to: string; open: number; close: number; flows: Flow[]; delta?: number; checks?: BookStatement["checks"] };

const STATEMENTS: St[] = [
  {
    id: "st-chk-jan",
    account: "chk",
    from: "2025-01-01",
    to: "2025-01-31",
    open: 1_000_000,
    close: 1_000_000 + 412_345 - 18_765,
    flows: [
      { id: "r-pay", date: "2025-01-15", cents: 412_345, lane: "INCOME", payee: "EXAMPLE PARTNERS LP PAYROLL", category: "Paycheck" },
      { id: "r-cardpay", date: "2025-01-20", cents: -18_765, lane: "TRANSFER", payee: "PAYMENT TO SPRINGFIELD CARD", category: "Own-account transfers", classifiedBy: "bank-chase-card-payment", match: "m1" },
    ],
    checks: [{ label: "Deposits and additions", expectedCents: 412_345, actualCents: 412_345, toleranceCents: 0 }],
  },
  {
    id: "st-chk-feb",
    account: "chk",
    from: "2025-02-01",
    to: "2025-02-28",
    open: 1_000_000 + 412_345 - 18_765,
    // Committed although it doesn't tie: the reader missed $1.23 somewhere.
    close: 1_000_000 + 412_345 - 18_765 - 2_500 - 123,
    delta: -123,
    flows: [{ id: "r-fee", date: "2025-02-03", cents: -2_500, lane: "EXPENSE", payee: "MONTHLY SERVICE FEE", category: "Fees & interest", detail: "WAIVED WITH DIRECT DEPOSIT" }],
  },
  {
    id: "st-card-jan",
    account: "card",
    from: "2025-01-05",
    to: "2025-02-04",
    open: -18_765,
    close: -18_765 + 18_765 - 6_543,
    flows: [
      { id: "r-cardrecv", date: "2025-01-21", cents: 18_765, lane: "TRANSFER", payee: "PAYMENT THANK YOU", category: "Own-account transfers", classifiedBy: "card-payment", match: "m1" },
      { id: "r-grocer", date: "2025-01-25", cents: -6_543, lane: "EXPENSE", payee: "SPRINGFIELD GROCER", category: "Groceries", classifiedBy: "user-merchant-rule", detail: "GROCERY STORES" },
    ],
  },
];

const ACCOUNTS = [
  { id: "chk", name: "Pat's checking ••1234", type: "CHECKING", subtype: "CHECKING" },
  { id: "card", name: "Pat's card ••5678", type: "CREDIT_CARD", subtype: "CREDIT_CARD" },
];

function stub(): BookStub {
  const line = (name: string, kind: StubLine["kind"], current: number, ytd: number): StubLine => ({ name, kind, current, ytd });
  return {
    id: "stub-jan",
    documentId: "doc-stub",
    documentTitle: "stub-2025-01-15.pdf",
    importedAt: "2025-02-01T00:00:00Z",
    source: "TRINET",
    employee: "PAT EXAMPLE",
    employer: "Example Partners LP",
    employerKey: employerKey("Example Partners LP"),
    personId: "pat",
    payDate: "2025-01-15",
    periodStart: "2025-01-01",
    periodEnd: "2025-01-15",
    federalFilingStatus: "Married filing jointly",
    lines: [
      line("Regular Salary", "REGULAR", 500_000, 500_000),
      line("Group Term Life", "IMPUTED", 1_234, 1_234),
      line("Federal Income Tax", "FEDERAL_TAX", 50_000, 50_000),
      line("401(k)", "RETIREMENT_PRETAX", 37_655, 37_655),
      line("401(k) Match", "EMPLOYER_RETIREMENT", 20_000, 20_000),
    ],
    printed: { grossCurrent: 500_000, grossYtd: 500_000, withheldCurrent: 87_655, withheldYtd: 87_655, netCurrent: 412_345, netYtd: 412_345 },
    deposits: [{ last4: "1234", amount: 412_345 }],
    warnings: [],
    depositTransactionId: "r-pay",
  };
}

function makeBook(): Book {
  const statements: BookStatement[] = [];
  const rows: BookRow[] = [];
  const inputs = new Map<string, SegmentInput[]>();
  for (const s of STATEMENTS) {
    statements.push({
      id: s.id,
      accountId: s.account,
      documentId: `doc-${s.id}`,
      documentTitle: `${s.id}.pdf`,
      importedAt: "2025-03-01T00:00:00.000Z",
      status: "COMMITTED",
      isSummary: false,
      periodStart: s.from,
      periodEnd: s.to,
      deltaCents: s.delta ?? 0,
      checks: s.checks,
      printed: { openingCents: s.open, closingCents: s.close, growthCents: 0, feesCents: 0 },
    });
    for (const f of s.flows)
      rows.push({
        id: f.id,
        date: f.date,
        precision: "EXACT",
        statement: { start: s.from, end: s.to },
        bookedOn: f.date,
        amountCents: f.cents,
        lane: f.lane,
        accountId: s.account,
        payee: f.payee,
        detail: f.detail ?? null,
        merchantKey: f.payee,
        category: f.category,
        categoryGroup: null,
        counterpartyKind: null,
        counterpartyInstitution: null,
        counterpartyAccountHint: null,
        classifiedBy: f.classifiedBy ?? null,
        transferMatchId: f.match ?? null,
        statementImportId: s.id,
        documentId: `doc-${s.id}`,
      });
    const list = inputs.get(s.account) ?? [];
    // The ledger books the gap a statement doesn't explain as its own line (timeline "rest"), so its balances still chain.
    list.push({
      accountId: s.account,
      importId: s.id,
      periodStart: s.from,
      periodEnd: s.to,
      openingCents: s.open,
      closingCents: s.close,
      growthCents: 0,
      feesCents: s.delta ?? 0,
      flows: s.flows.map((f) => ({ id: f.id, date: f.date, precision: "EXACT" as const, amountCents: f.cents, lane: f.lane })),
    });
    inputs.set(s.account, list);
  }
  const ledgerAccounts: LedgerAccount[] = ACCOUNTS.map((a) => ({
    ...a,
    institution: "Springfield Bank",
    subtype: a.subtype as LedgerAccount["subtype"],
    group: groupFor(a.subtype, a.type),
    isInvestment: false,
    timeline: buildTimeline(a.id, inputs.get(a.id)!, []),
    statementCount: inputs.get(a.id)!.length,
    closed: false,
  }));
  const ledger = { accounts: ledgerAccounts, mergeDate: "2024-12-01", completeThrough: null, firstDay: null };
  refreshLedgerStatus(ledger, "2025-03-15");
  return {
    today: "2025-03-15",
    horizon: { cashFlow: "2025-02-04", netWorth: "2025-02-04" },
    ledger,
    accounts: ACCOUNTS.map((a) => ({ ...a, institution: "Springfield Bank", group: groupFor(a.subtype, a.type), identifiers: [] })),
    statements,
    rows,
    rowById: new Map(rows.map((r) => [r.id, r])),
    stubs: [stub()],
    brokerage: [],
    holdings: [],
    matches: [
      {
        id: "m1",
        status: "AUTO",
        differenceCents: 0,
        legs: [
          { transactionId: "r-cardpay", accountId: "chk", date: "2025-01-20", amountCents: -18_765 },
          { transactionId: "r-cardrecv", accountId: "card", date: "2025-01-21", amountCents: 18_765 },
        ],
      },
    ],
    documents: STATEMENTS.map((s) => ({ id: `doc-${s.id}`, title: `${s.id}.pdf`, institution: "Springfield Bank", parserId: "springfield-bank", parserVersion: 3, factsVersion: 0, periodStart: s.from, periodEnd: s.to })),
    decisions: { version: 1, confirmed: [], rejected: [] },
    classifiedWith: null,
    household: NO_HOUSEHOLD,
    classifiedWithHousehold: null,
    taxProfile: { version: 1, persons: [], dependents: [], accountOwners: {}, accountKinds: {}, qualifiedDividendShare: 1, moneyMarketUsGovShare: 0, mfsDependentClaimant: "AUTO", years: {} },
    taxDocs: null,
    persons: [{ id: "pat", name: "Pat Example", match: ["PAT"] }],
    idle: { proven: [], unproven: [] },
    integrity: { checks: [], findings: [], inferences: [], accepted: [], stale: [], retired: [] },
    passes: [],
  } as unknown as Book;
}

const facts = (p: Proof, title: string): ProofFact[] => {
  const b = p.blocks.find((x) => x.kind === "facts" && x.title === title);
  if (!b || b.kind !== "facts") throw new Error(`no facts block "${title}" in ${p.blocks.map((x) => x.title).join(", ")}`);
  return b.items;
};
const fact = (p: Proof, title: string, label: string) => facts(p, title).find((f) => f.label === label);

/** Every link a proof emits: chain lines, breakdown items and facts. */
function links(p: Proof): ProofLink[] {
  return p.blocks.flatMap((b) => (b.kind === "chain" ? b.lines.map((l) => l.link) : b.kind === "breakdown" || b.kind === "facts" ? b.items.map((x) => x.link) : [])).filter((l): l is ProofLink => !!l);
}

describe("statement proof", () => {
  it("re-adds the printed opening and every row to the printed closing", () => {
    const p = buildStatementProof(makeBook(), { report: "statement", statementId: "st-chk-jan" });
    expect(p.figure).toEqual({ cents: 1_000_000 + 412_345 - 18_765 });
    expect(p.selfCheck).toMatchObject({ ok: true, deltaCents: 0 });
    const eq = p.blocks.find((b) => b.title === "The statement's own arithmetic");
    expect(eq?.kind === "chain" && eq.lines.map((l) => [l.op ?? "", l.label, "cents" in l.value ? l.value.cents : l.value])).toEqual([
      ["", "Opening balance, as printed", 1_000_000],
      ["+", "2 rows read off it", 412_345 - 18_765],
      ["=", "Closing balance, as printed", 1_393_580],
    ]);
    const rows = p.blocks.find((b) => b.kind === "rows");
    expect(rows?.kind === "rows" && rows.groups.flatMap((g) => g.rows.map((r) => r.id))).toEqual(["r-pay", "r-cardpay"]);
  });

  it("lists the printed subtotals it was checked against, and its neighbours", () => {
    const p = buildStatementProof(makeBook(), { report: "statement", statementId: "st-chk-jan" });
    const printed = p.blocks.find((b) => b.title === "Totals the statement prints, re-added from its rows");
    expect(printed?.kind === "chain" && printed.lines[0]).toMatchObject({ label: "Deposits and additions", value: { cents: 412_345 }, note: "the rows read come to $4,123.45: they match" });
    expect(fact(p, "Its place among the account's statements", "The statement before")?.text).toContain("first statement");
    const after = fact(p, "Its place among the account's statements", "The statement after")!;
    expect(after).toMatchObject({ tone: "good", link: { descriptor: { report: "statement", statementId: "st-chk-feb" } } });
    expect(fact(p, "The document", "Read by")?.text).toBe("springfield-bank, version 3");
  });

  it("shows the gap of a statement committed although it doesn't tie, and still re-adds", () => {
    const p = buildStatementProof(makeBook(), { report: "statement", statementId: "st-chk-feb" });
    const eq = p.blocks.find((b) => b.title === "The statement's own arithmetic");
    const gap = eq?.kind === "chain" ? eq.lines.find((l) => l.source === "estimate") : undefined;
    expect(gap).toMatchObject({ label: "Not explained by the statement's own lines", value: { cents: -123 } });
    expect(p.selfCheck?.ok).toBe(true);
  });

  it("puts a bill payment booked in pieces back together, and leaves the ledger's corrections out", () => {
    const book = makeBook();
    const base = book.rowById.get("r-grocer")!;
    const extra: BookRow[] = [
      { ...base, id: "r-grocer:part2", partOf: "r-grocer", amountCents: -1_000, bookedOn: "2025-01-28" },
      { ...base, id: "r-grocer:correction", amountCents: -55, classifiedBy: "bill-correction" },
    ];
    const withPieces = { ...book, rows: [...book.rows, ...extra] } as Book;
    const rows = printedRows(withPieces, "st-card-jan");
    expect(rows.map((r) => [r.id, r.amountCents])).toEqual([
      ["r-cardrecv", 18_765],
      ["r-grocer", -7_543],
    ]);
  });
});

describe("row proof", () => {
  it("shows the row as printed, the rule that filed it and where it counts", () => {
    const book = makeBook();
    const p = buildRowProof(book, { report: "row", rowId: "r-grocer" });
    expect(p.figure).toEqual({ cents: -6_543 });
    expect(fact(p, "As the statement prints it", "Second line")?.text).toBe("GROCERY STORES");
    expect(fact(p, "As the statement prints it", "Statement")?.link?.descriptor).toEqual({ report: "statement", statementId: "st-card-jan" });
    expect(fact(p, "How the app files it", "Decided by")?.text).toBe("Your rule for every row from “SPRINGFIELD GROCER” · user-merchant-rule");
    expect(fact(p, "Where it counts", "Cash flow")?.link?.descriptor).toEqual({ report: "cash-flow", metric: "spending", granularity: "month", start: "2025-01-01", end: "2025-01-31", category: "Groceries" });
  });

  it("names the other side of a transfer, and the stub behind a paycheck", () => {
    const book = makeBook();
    const t = buildRowProof(book, { report: "row", rowId: "r-cardpay" });
    expect(fact(t, "The other side", "Pat's card ••5678")).toMatchObject({ text: "$187.65 on 2025-01-21", link: { descriptor: { report: "row", rowId: "r-cardrecv" } } });
    expect(fact(t, "Where it counts", "Cash flow")?.text).toContain("Not income or spending");
    const pay = buildRowProof(book, { report: "row", rowId: "r-pay" });
    const s = facts(pay, "The pay stub behind it")[0]!;
    expect(s).toMatchObject({ tone: "good", link: { descriptor: { report: "stub", stubId: "stub-jan" } } });
    expect(s.text).toBe("Net pay $4,123.45: exactly this deposit");
  });

  it("explains a row it can't find in words", () => {
    expect(() => buildRowProof(makeBook(), { report: "row", rowId: "nope" })).toThrow(/isn't in the ledger/);
  });

  it("puts the classifier's rule names into words", () => {
    const r = { merchantKey: null, section: "Payments" };
    expect(decidedBy({ ...r, classifiedBy: "untracked-card:bank-capital-one-card-payment" })).toMatch(/^The transfer matcher: a card payment no tracked card received/);
    expect(decidedBy({ ...r, classifiedBy: "card-payment" })).toBe("The statement's own section (“Payments”) · card-payment");
    expect(decidedBy({ ...r, classifiedBy: null })).toBe("No rule: nothing filed it yet");
  });
});

describe("stub proof", () => {
  it("re-adds the earning lines less what was withheld to the printed net, and checks itself", () => {
    const p = buildStubProof(makeBook(), { report: "stub", stubId: "stub-jan" });
    expect(p.figure).toEqual({ cents: 412_345 });
    expect(p.selfCheck).toMatchObject({ ok: true, deltaCents: 0 });
    const pay = p.blocks.find((b) => b.title === "This paycheck, line by line");
    expect(pay?.kind === "chain" && pay.lines.map((l) => [l.op ?? "", l.label])).toEqual([
      ["", "Regular Salary"],
      ["=", "Gross pay, as printed"],
      ["−", "Federal Income Tax"],
      ["−", "401(k)"],
      ["=", "Net pay, as printed"],
    ]);
    expect(pay?.kind === "chain" && pay.lines[1]!.note).toContain("Group Term Life");
    const self = p.blocks.find((b) => b.title === "The stub checks itself");
    expect(self?.kind === "chain" && self.lines.every((l) => l.note?.endsWith("they match"))).toBe(true);
    expect(fact(p, "Where the net pay went", "On the bank statement")?.link?.descriptor).toEqual({ report: "row", rowId: "r-pay" });
  });
});

describe("source links", () => {
  it("marks every Book row and statement in any proof, so the drawer can open them", async () => {
    const book = makeBook();
    const p = await buildProof({ book, db: null as never }, { report: "cash-flow", metric: "spending", granularity: "month", start: "2025-01-01", end: "2025-01-31" });
    const rows = p.blocks.find((b) => b.kind === "rows");
    expect(rows?.kind === "rows" && rows.groups.map((g) => [g.statement.importId, g.rows.map((r) => r.rowId)])).toEqual([["st-card-jan", ["r-grocer"]]]);
  });

  it("emits links that parse and build, all the way down", async () => {
    const book = makeBook();
    const seen = new Set<string>();
    const queue: unknown[] = [
      { report: "statement", statementId: "st-chk-jan" },
      { report: "row", rowId: "r-cardpay" },
      { report: "row", rowId: "r-pay" },
      { report: "row", rowId: "r-grocer" },
      { report: "stub", stubId: "stub-jan" },
    ];
    while (queue.length) {
      const body = queue.shift();
      const key = JSON.stringify(body);
      if (seen.has(key)) continue;
      seen.add(key);
      const d = parseDescriptor(body);
      if ("error" in d) throw new Error(`${key}: ${d.error}`);
      const p = await buildProof({ book, db: null as never }, d);
      // Follow only into the source kinds; the figures they link up to just have to build.
      for (const l of links(p)) (["statement", "row", "stub"].includes(l.descriptor.report) ? queue : []).push(l.descriptor);
      for (const l of links(p)) if (!["statement", "row", "stub", "pay"].includes(l.descriptor.report)) await buildProof({ book, db: null as never }, l.descriptor);
    }
    expect(seen.size).toBeGreaterThanOrEqual(7);
  });
});
