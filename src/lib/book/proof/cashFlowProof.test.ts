import { describe, expect, it } from "vitest";
import { NO_HOUSEHOLD } from "../../household/patterns";
import type { Book, BookRow, BookStatement } from "../load";
import { buildCashFlowReport } from "../reports/cashFlow";
import type { AcceptedFinding, CheckPass, Finding } from "../types";
import { buildCashFlowProof, type CashFlowDescriptor } from "./cashFlowProof";
import { sumCheck } from "./common";
import { buildProof, parseDescriptor, type Proof, type ProofLink } from "./index";

// An invented household: Pat Example's checking (••1234) and a card (••5678) at
// Springfield Bank, Jan – Apr 2025. Every name and amount is made up.

const STATEMENTS: BookStatement[] = [
  ["chk", "2025-01-01", "2025-01-31"],
  ["chk", "2025-02-01", "2025-02-28"],
  ["chk", "2025-03-01", "2025-03-31"],
  ["chk", "2025-04-01", "2025-04-30"],
  ["card", "2025-01-05", "2025-02-04"],
  ["card", "2025-02-05", "2025-03-04"],
  // A quarterly statement that gives one line only as a period total.
  ["brk", "2025-01-01", "2025-03-31"],
].map(([accountId, periodStart, periodEnd]) => ({
  id: `st-${accountId}-${periodStart}`,
  accountId: accountId!,
  documentId: `doc-${accountId}-${periodStart}`,
  documentTitle: `${accountId}-${periodStart}.pdf`,
  importedAt: "2025-05-01T00:00:00.000Z",
  status: "COMMITTED" as const,
  isSummary: false,
  periodStart: periodStart!,
  periodEnd: periodEnd!,
  deltaCents: 0,
}));

let n = 0;
function row(accountId: string, date: string, cents: number, extra: Partial<BookRow> = {}): BookRow {
  const st = STATEMENTS.find((s) => s.accountId === accountId && s.periodStart <= date && date <= s.periodEnd) ?? STATEMENTS.find((s) => s.accountId === accountId)!;
  return {
    id: `r${++n}`,
    date,
    precision: "EXACT",
    statement: { start: st.periodStart, end: st.periodEnd },
    bookedOn: date,
    amountCents: cents,
    lane: cents > 0 ? "INCOME" : "EXPENSE",
    accountId,
    payee: "EXAMPLE",
    merchantKey: null,
    category: cents > 0 ? "Paycheck" : "Groceries",
    categoryGroup: null,
    counterpartyKind: null,
    counterpartyInstitution: null,
    counterpartyAccountHint: null,
    classifiedBy: null,
    transferMatchId: null,
    statementImportId: st.id,
    documentId: st.documentId,
    ...extra,
  };
}

const rent = (date: string) => row("chk", date, -210_000, { payee: "SPRINGFIELD PROPERTY MGMT", merchantKey: "SPRINGFIELD PROPERTY MGMT", category: "Housing & utilities" });

function makeBook(rows: BookRow[], extra: Partial<Pick<Book, "passes" | "integrity">> = {}): Book {
  const accounts = [
    { id: "chk", name: "Pat's checking ••1234", subtype: "CHECKING", type: "CHECKING" },
    { id: "card", name: "Pat's card ••5678", subtype: "CREDIT_CARD", type: "CREDIT_CARD" },
    { id: "brk", name: "Example brokerage", subtype: "BROKERAGE", type: "INVESTMENT" },
  ];
  return {
    today: "2025-05-15",
    horizon: { cashFlow: "2025-04-30", netWorth: "2025-04-30" },
    ledger: { accounts: [], mergeDate: "2024-12-01", completeThrough: null, firstDay: "2025-01-01" },
    accounts: accounts.map((a) => ({ ...a, institution: "Springfield Bank", group: a.subtype === "CREDIT_CARD" ? "Credit cards" : "Cash", identifiers: [] })),
    statements: STATEMENTS,
    rows,
    rowById: new Map(rows.map((r) => [r.id, r])),
    stubs: [],
    brokerage: [],
    holdings: [],
    matches: [],
    documents: [],
    decisions: { version: 1, confirmed: [], rejected: [] },
    classifiedWith: null,
    household: NO_HOUSEHOLD,
    classifiedWithHousehold: null,
    taxProfile: { version: 1, persons: [], dependents: [], accountOwners: {}, accountKinds: {}, qualifiedDividendShare: 1, moneyMarketUsGovShare: 0, mfsDependentClaimant: "AUTO", years: {} },
    taxDocs: null,
    persons: [],
    idle: { proven: [], unproven: [] },
    integrity: { checks: [], findings: [], inferences: [], accepted: [], stale: [], retired: [] },
    passes: [],
    ...extra,
  } as Book;
}

const d = (x: Partial<CashFlowDescriptor>): CashFlowDescriptor => ({ report: "cash-flow", metric: "spending", granularity: "month", start: "2025-01-01", end: "2025-04-30", ...x });

function household() {
  n = 0;
  return [
    row("chk", "2025-01-15", 512_345, { payee: "EXAMPLE PARTNERS LP PAYROLL" }),
    row("chk", "2025-02-14", 512_345, { payee: "EXAMPLE PARTNERS LP PAYROLL" }),
    row("card", "2025-01-09", -8_733),
    row("card", "2025-02-11", -4_101, { category: "Dining" }),
    // Dated before its statement's period: the ledger books it on the period's first day.
    row("card", "2025-02-03", -1_999, { statement: { start: "2025-02-05", end: "2025-03-04" }, bookedOn: "2025-02-05", statementImportId: "st-card-2025-02-05", documentId: "doc-card-2025-02-05" }),
    // A fee given only as a quarter's total: spread over Jan–Mar by days.
    row("brk", "2025-03-31", -9_001, { precision: "PERIOD", category: "Fees", statement: { start: "2025-01-01", end: "2025-03-31" }, bookedOn: "2025-03-31" }),
    rent("2025-01-02"),
    rent("2025-02-03"),
    // Paid early: counts in April, the month it pays for.
    rent("2025-03-27"),
    rent("2025-05-01"),
    // A further piece of one bill payment, booked on its own day; keeps its statement.
    { ...row("chk", "2025-03-10", -2_500, { category: "Housing & utilities", payee: "Bill" }), id: "r-bill:part2", partOf: "r-bill" },
    row("chk", "2025-02-20", 30_000, { lane: "EXTERNAL_TRANSFER", category: "Partner", payee: "FROM PARTNER" }),
    row("chk", "2025-02-21", -50_000, { lane: "TRANSFER", category: "Transfer" }),
  ];
}

describe("buildCashFlowProof", () => {
  it("lists rows that re-add to every figure the report shows, per month and per category", () => {
    const book = makeBook(household());
    const report = buildCashFlowReport(book, { granularity: "month" });
    for (const p of report.periods) {
      for (const metric of ["income", "spending", "external", "net"] as const) {
        const proof = buildCashFlowProof(book, d({ metric, start: p.start, end: p.end }));
        const shown = { income: p.incomeCents, spending: p.spendingCents, net: p.netCents, external: p.externalByCategory.reduce((t, c) => t + c.cents, 0) }[metric];
        expect(proof.figureCents, `${metric} ${p.label}`).toBe(shown);
        expect(proof.rowsCents).toBe(shown);
        expect(proof.selfCheck).toEqual({ ok: true, deltaCents: 0 });
      }
      for (const c of p.spendingByCategory) {
        const proof = buildCashFlowProof(book, d({ category: c.category, start: p.start, end: p.end }));
        expect(proof.figureCents).toBe(c.cents);
        expect(proof.selfCheck.ok).toBe(true);
      }
    }
  });

  it("matches a range figure as the page sums it (each month rounded once)", () => {
    const book = makeBook(household());
    const months = buildCashFlowReport(book, { granularity: "month" }).periods;
    const proof = buildCashFlowProof(book, d({}));
    expect(proof.figureCents).toBe(months.reduce((t, p) => t + p.spendingCents, 0));
    expect(proof.selfCheck.ok).toBe(true);
    expect(proof.periods.map((p) => p.cents)).toEqual(months.map((p) => p.spendingCents));
  });

  it("spreads a period total across months by its share, and groups it under its statement", () => {
    const book = makeBook(household());
    const jan = buildCashFlowProof(book, d({ category: "Fees", start: "2025-01-01", end: "2025-01-31" }));
    const [g] = jan.sections[0]!.groups;
    expect(g!.statement).toMatchObject({ id: "st-brk-2025-01-01", periodStart: "2025-01-01", periodEnd: "2025-03-31" });
    const [r] = g!.rows;
    expect(r!.precision).toBe("PERIOD");
    expect(r!.share).toBeCloseTo(31 / 90, 10);
    expect(r!.countedCents).toBeCloseTo((9_001 * 31) / 90, 6);
    expect(jan.figureCents).toBe(Math.round((9_001 * 31) / 90));
    // The quarter's three months add back to the whole line.
    const q = buildCashFlowProof(book, d({ category: "Fees", start: "2025-01-01", end: "2025-03-31" }));
    expect(q.sections[0]!.groups[0]!.rows[0]!.share).toBeCloseTo(1, 10);
  });

  it("counts rent in the month it pays for and says where it moved", () => {
    const book = makeBook(household());
    const mar = buildCashFlowProof(book, d({ category: "Housing & utilities", start: "2025-03-01", end: "2025-03-31" }));
    expect(mar.sections[0]!.groups.flatMap((g) => g.rows).some((r) => r.date === "2025-03-27")).toBe(false);
    const apr = buildCashFlowProof(book, d({ category: "Housing & utilities", start: "2025-04-01", end: "2025-04-30" }));
    const moved = apr.sections[0]!.groups.flatMap((g) => g.rows).find((r) => r.date === "2025-03-27");
    expect(moved?.movedTo).toEqual({ date: "2025-04-01", why: "rent" });
    expect(apr.selfCheck.ok).toBe(true);
  });

  it("books a row on its clamped date, and keeps a bill piece under the statement it came from", () => {
    const book = makeBook(household());
    const feb = buildCashFlowProof(book, d({ start: "2025-02-01", end: "2025-02-28" }));
    const early = feb.sections[0]!.groups.flatMap((g) => g.rows).find((r) => r.date === "2025-02-03" && r.amountCents === -1_999);
    expect(early?.bookedOn).toBe("2025-02-05");
    const mar = buildCashFlowProof(book, d({ start: "2025-03-01", end: "2025-03-31" }));
    const piece = mar.sections[0]!.groups.flatMap((g) => g.rows.map((r) => ({ g, r }))).find(({ r }) => r.id === "r-bill:part2");
    expect(piece?.r.piece).toBe(true);
    expect(piece?.g.statement.id).toBe("st-chk-2025-03-01");
  });

  it("subtotals per statement add up to the section", () => {
    const book = makeBook(household());
    const proof = buildCashFlowProof(book, d({ start: "2025-01-01", end: "2025-02-28" }));
    const s = proof.sections[0]!;
    expect(s.groups.length).toBeGreaterThan(1);
    expect(Math.abs(s.groups.reduce((t, g) => t + g.subtotalCents, 0) - s.figureCents)).toBeLessThanOrEqual(s.groups.length);
  });

  it("filters by account, and nets income against spending in two sections", () => {
    const book = makeBook(household());
    const card = buildCashFlowProof(book, d({ accountIds: ["card"] }));
    expect(card.sections[0]!.groups.every((g) => g.statement.id.startsWith("st-card"))).toBe(true);
    expect(card.figureCents).toBe(8_733 + 4_101 + 1_999);
    expect(card.describes).toContain("Pat's card ••5678 only");
    const net = buildCashFlowProof(book, d({ metric: "net", start: "2025-02-01", end: "2025-02-28" }));
    expect(net.sections.map((s) => s.label)).toEqual(["Income", "Spending"]);
    expect(net.figureCents).toBe(net.sections[0]!.figureCents - net.sections[1]!.figureCents);
    expect(net.selfCheck.ok).toBe(true);
  });

  it("never lists own-account transfers", () => {
    const book = makeBook(household());
    for (const metric of ["income", "spending", "external"] as const) {
      const proof = buildCashFlowProof(book, d({ metric }));
      expect(proof.sections.flatMap((s) => s.groups.flatMap((g) => g.rows)).some((r) => r.amountCents === -50_000)).toBe(false);
    }
  });

  it("flags rows that don't come to the figure", () => {
    expect(sumCheck(10_000, 10_000, "x")).toEqual({ ok: true, deltaCents: 0, explain: "x" });
    expect(sumCheck(10_000, 9_999, "x")).toEqual({ ok: false, deltaCents: -1, explain: "x" });
  });

  it("gives each check a tri-state: passed, open, accepted, or nothing in scope", () => {
    const scope = (accountId: string | undefined, from: string, to: string) => ({ ...(accountId ? { accountId } : {}), from, to, affects: ["CASH_FLOW" as const, "NET_WORTH" as const] });
    const passes: CheckPass[] = [
      { check: "statement.held", n: 1, subject: "card Jan", scope: scope("card", "2025-01-05", "2025-02-04") },
      { check: "statement.held", n: 1, subject: "chk Mar", scope: scope("chk", "2025-03-01", "2025-03-31") },
      { check: "ledger.freshness", n: 1, subject: "rules", scope: scope(undefined, "2025-01-01", "2025-05-15") },
      { check: "paystub.arithmetic", n: 1, subject: "stub", scope: { from: "2025-01-15", to: "2025-01-15", affects: ["PAY"] } },
    ];
    const finding: Finding = { id: "transfer.unmatched:x", check: "transfer.unmatched", status: "MISSING", title: "unpaired", detail: "", fix: "", scope: scope("chk", "2025-01-10", "2025-01-12") };
    const accepted: AcceptedFinding = { ...finding, id: "statement.gap:x", check: "statement.gap", exceptionId: "statement.gap:x", note: "closed for a month", acceptedAt: "2025-04-01" };
    const book = makeBook(household(), { passes, integrity: { checks: [], findings: [finding], inferences: [], accepted: [accepted], stale: [], retired: [] } });
    const jan = buildCashFlowProof(book, d({ start: "2025-01-01", end: "2025-01-31", accountIds: ["card"] }));
    const state = Object.fromEntries(jan.checks.map((c) => [c.id, c.state]));
    expect(state["statement.held"]).toBe("passed");
    expect(jan.checks.find((c) => c.id === "statement.held")!.subjects).toEqual(["card Jan"]);
    expect(state["ledger.freshness"]).toBe("passed");
    expect(state["statement.chain"]).toBe("none");
    // Another account's finding and exception don't bear on the card's figure.
    expect(state["transfer.unmatched"]).toBe("none");
    expect(jan.withheld).toBe(false);
    const all = buildCashFlowProof(book, d({ start: "2025-01-01", end: "2025-01-31" }));
    expect(all.checks.find((c) => c.id === "transfer.unmatched")!.state).toBe("open");
    expect(all.checks.find((c) => c.id === "statement.gap")).toMatchObject({ state: "accepted", accepted: [{ note: "closed for a month" }] });
    expect(all.withheld).toBe(true);
    expect(all.checks.some((c) => (c.id as string) === "paystub.arithmetic")).toBe(false);
  });
});

describe("parseDescriptor", () => {
  it("accepts a figure's recipe and rejects anything else", () => {
    expect(parseDescriptor({ report: "cash-flow", metric: "income", granularity: "month", start: "2025-01-01", end: "2025-01-31", accountIds: [] })).toEqual({
      report: "cash-flow",
      metric: "income",
      granularity: "month",
      start: "2025-01-01",
      end: "2025-01-31",
    });
    expect(parseDescriptor(null)).toHaveProperty("error");
    expect(parseDescriptor({ report: "net-worth" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "cash-flow", metric: "income", granularity: "month", start: "Jan", end: "2025-01-31" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "cash-flow", metric: "income", granularity: "month", start: "2025-02-01", end: "2025-01-31" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "cash-flow", metric: "net", granularity: "month", start: "2025-01-01", end: "2025-01-31", category: "Dining" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "cash-flow", metric: "spending", granularity: "week", start: "2025-01-01", end: "2025-01-31" })).toHaveProperty("error");
  });
});

describe("as a registered proof kind", () => {
  const ctx = () => ({ book: makeBook(household()), db: {} as never });
  const links = (p: Proof): ProofLink[] =>
    p.blocks.flatMap((b) => (b.kind === "breakdown" ? b.items.flatMap((i) => (i.link ? [i.link] : [])) : b.kind === "chain" ? b.lines.flatMap((l) => (l.link ? [l.link] : [])) : []));

  it("builds the drawer's blocks: by month, by category, then rows by statement", async () => {
    const p = await buildProof(ctx(), d({}));
    expect(p.blocks.map((b) => `${b.kind}:${b.title}`)).toEqual(["breakdown:By month", "breakdown:By category", "rows:How it adds up"]);
    expect(p.figure).toEqual({ cents: buildCashFlowProof(ctx().book, d({})).figureCents });
    expect(p.selfCheck?.ok).toBe(true);
    expect(p.selfCheck?.explain).toMatch(/^The \d+ rows below add up to \$[\d,.]+$/);
  });

  it("emits links that parse, build and re-add to the part they came from", async () => {
    const c = ctx();
    for (const metric of ["income", "spending", "net"] as const) {
      const p = await buildProof(c, d({ metric }));
      const ls = links(p);
      expect(ls.length).toBeGreaterThan(0);
      for (const l of ls) {
        const parsed = parseDescriptor(JSON.parse(JSON.stringify(l.descriptor)));
        expect(parsed, l.label).not.toHaveProperty("error");
        const q = await buildProof(c, parsed as CashFlowDescriptor);
        expect(q.selfCheck?.ok, l.label).toBe(true);
      }
      // Each month's link opens a proof of exactly that month's part.
      const months = p.blocks.find((b) => b.kind === "breakdown" && b.title === "By month");
      if (months?.kind !== "breakdown") throw new Error("no months");
      for (const i of months.items) expect((await buildProof(c, i.link!.descriptor)).figure).toEqual(i.value);
    }
  });

  it("splits a net figure's categories by side, each linking to that side", async () => {
    const p = await buildProof(ctx(), d({ metric: "net", start: "2025-02-01", end: "2025-02-28" }));
    const spend = p.blocks.find((b) => b.title === "By category · Spending");
    expect(spend?.kind === "breakdown" && spend.items.every((i) => (i.link?.descriptor as CashFlowDescriptor | undefined)?.metric === "spending")).toBe(true);
  });

  it("rejects a report no kind is registered for", () => {
    expect(parseDescriptor({ report: "horoscope" })).toMatchObject({ error: expect.stringMatching(/^report must be one of: cash-flow\b/) });
    expect(parseDescriptor({ report: "toString" })).toHaveProperty("error");
  });
});
