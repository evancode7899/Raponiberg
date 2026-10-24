import { describe, expect, it } from "vitest";
import { NO_HOUSEHOLD } from "../../household/patterns";
import { hsaLedger } from "../../hsa/load";
import { buildHsaReport, type HsaReport } from "../../hsa/report";
import { EMPTY_SETTINGS, type HsaExpense, type HsaFile } from "../../hsa/store";
import type { StubLine } from "../../ingest/payroll/types";
import { buildTimeline, type SegmentInput } from "../../ledger/timeline";
import type { Book, BookRow, BookStatement, BookStub } from "../load";
import { hsaFigures } from "./figures";
import { buildHsaProof, makeHsaKind, type HsaDescriptor } from "./hsaProof";
import { buildProof, parseDescriptor, type Proof, type ProofLink } from "./index";

// An invented household: Pat Example's HSA (••9012), card (••5678) and checking (••1234)
// at Springfield Bank, Jan – Feb 2025, and a receipts log Pat keeps. All made up.

const STATEMENTS: BookStatement[] = [
  ["hsa", "2025-01-01", "2025-01-31"],
  ["hsa", "2025-02-01", "2025-02-28"],
  ["card", "2025-01-01", "2025-01-31"],
  ["card", "2025-02-01", "2025-02-28"],
].map(([accountId, periodStart, periodEnd]) => ({
  id: `st-${accountId}-${periodStart}`,
  accountId: accountId!,
  documentId: `doc-${accountId}-${periodStart}`,
  documentTitle: `${accountId}-${periodStart}.pdf`,
  importedAt: "2025-03-01T00:00:00.000Z",
  status: "COMMITTED" as const,
  isSummary: false,
  periodStart: periodStart!,
  periodEnd: periodEnd!,
  deltaCents: 0,
}));

let n = 0;
function row(accountId: string, date: string, cents: number, payee: string, lane: string): BookRow {
  const st = STATEMENTS.find((s) => s.accountId === accountId && s.periodStart <= date && date <= s.periodEnd)!;
  return {
    id: `r${++n}`,
    date,
    precision: "EXACT",
    statement: { start: st.periodStart, end: st.periodEnd },
    bookedOn: date,
    amountCents: cents,
    lane,
    accountId,
    payee,
    merchantKey: payee,
    category: lane === "EXPENSE" ? "Health & insurance" : "Transfer",
    categoryGroup: null,
    counterpartyKind: null,
    counterpartyInstitution: null,
    counterpartyAccountHint: null,
    classifiedBy: "merchant-keyword",
    transferMatchId: null,
    statementImportId: st.id,
    documentId: st.documentId,
  } as BookRow;
}

function rows(): BookRow[] {
  n = 0;
  return [
    // Counts for 2024 (the payee says so), so the split reads 2025 without it.
    row("hsa", "2025-01-10", 50_000, "EMPLOYER CONTRIBUTION FOR 2024", "CONTRIBUTION_EMPLOYER"),
    row("hsa", "2025-01-15", 20_000, "PAYROLL CONTRIBUTION", "CONTRIBUTION_EMPLOYEE"),
    row("hsa", "2025-01-20", -3_456, "CARD SPRINGFIELD PHARMACY", "EXPENSE"),
    row("hsa", "2025-02-10", 50_000, "EMPLOYER CONTRIBUTION", "CONTRIBUTION_EMPLOYER"),
    row("hsa", "2025-02-15", 20_000, "PAYROLL CONTRIBUTION", "CONTRIBUTION_EMPLOYEE"),
    row("hsa", "2025-02-18", 10_000, "CONTRIBUTION", "CONTRIBUTION_PERSONAL"),
    row("hsa", "2025-02-20", -12_345, "DISTRIBUTION TO CHECKING", "TRANSFER"),
    row("card", "2025-01-05", -15_000, "SPRINGFIELD DENTAL", "EXPENSE"),
    row("card", "2025-02-03", -7_000, "EXAMPLE CLINIC", "EXPENSE"),
  ];
}

const flowsOf = (rs: BookRow[], st: BookStatement) =>
  rs
    .filter((r) => r.statementImportId === st.id)
    .map((r) => ({
      date: r.date,
      precision: "EXACT" as const,
      amountCents: r.amountCents,
      lane: r.lane as SegmentInput["flows"][number]["lane"],
    }));

function makeBook(rs: BookRow[], extra: Partial<Book> = {}): Book {
  // The HSA's statements: growth and fees as printed, closing = opening + flows + growth + fees.
  const [jan, feb] = STATEMENTS.filter((s) => s.accountId === "hsa") as [BookStatement, BookStatement];
  const seg = (st: BookStatement, openingCents: number, growthCents: number, feesCents: number): SegmentInput => {
    const flows = flowsOf(rs, st);
    return {
      accountId: "hsa",
      periodStart: st.periodStart,
      periodEnd: st.periodEnd,
      openingCents,
      closingCents: openingCents + flows.reduce((t, f) => t + f.amountCents, 0) + growthCents + feesCents,
      growthCents,
      feesCents,
      flows,
    };
  };
  const s1 = seg(jan, 100_000, 1_000, -100);
  const s2 = seg(feb, s1.closingCents, 2_000, 0);
  const accounts = [
    {
      id: "hsa",
      name: "Pat's HSA ••9012",
      subtype: "HSA",
      type: "INVESTMENT",
      group: "Health savings",
    },
    {
      id: "card",
      name: "Pat's card ••5678",
      subtype: "CREDIT_CARD",
      type: "CREDIT_CARD",
      group: "Credit cards",
    },
  ];
  return {
    today: "2025-03-15",
    horizon: { cashFlow: "2025-02-28", netWorth: "2025-02-28" },
    ledger: {
      accounts: [
        {
          id: "hsa",
          name: "Pat's HSA ••9012",
          institution: "Springfield Bank",
          type: "INVESTMENT",
          subtype: "HSA",
          group: "Health savings",
          isInvestment: true,
          timeline: buildTimeline("hsa", [s1, s2]),
          statementCount: 2,
          closed: false,
        },
      ],
      mergeDate: "2024-12-01",
      completeThrough: "2025-02-28",
      firstDay: "2025-01-01",
    },
    accounts: accounts.map((a) => ({
      ...a,
      institution: "Springfield Bank",
      identifiers: [],
    })),
    statements: STATEMENTS,
    rows: rs,
    rowById: new Map(rs.map((r) => [r.id, r])),
    stubs: [],
    brokerage: [],
    holdings: [],
    matches: [],
    documents: [],
    decisions: { version: 1, confirmed: [], rejected: [] },
    classifiedWith: null,
    household: NO_HOUSEHOLD,
    classifiedWithHousehold: null,
    taxProfile: {
      version: 1,
      persons: [],
      dependents: [],
      accountOwners: {},
      accountKinds: {},
      qualifiedDividendShare: 1,
      moneyMarketUsGovShare: 0,
      mfsDependentClaimant: "AUTO",
      years: {},
    },
    taxDocs: null,
    persons: [],
    idle: { proven: [], unproven: [] },
    integrity: {
      checks: [],
      findings: [],
      inferences: [],
      accepted: [],
      stale: [],
      retired: [],
    },
    passes: [],
    ...extra,
  } as unknown as Book;
}

const expense = (id: string, date: string, amountCents: number, extra: Partial<HsaExpense> = {}): HsaExpense => ({
  id,
  date,
  amountCents,
  provider: id,
  patient: "Pat Example",
  kind: "MEDICAL",
  notes: "",
  receipt: true,
  receiptRef: "",
  source: "MANUAL",
  paidWith: null,
  reimbursement: null,
  createdAt: "2025-03-01T00:00:00Z",
  updatedAt: "2025-03-01T00:00:00Z",
  ...extra,
});

const LOG: HsaFile = {
  version: 1,
  expenses: [
    // Tied by amount and date to the card's dental charge.
    expense("Springfield Dental", "2025-01-03", 15_000),
    // Paid back by the February distribution.
    expense("Example Clinic", "2025-02-01", 12_345, {
      reimbursement: {
        date: "2025-02-20",
        withdrawal: {
          institution: "Springfield Bank",
          identifiers: [],
          date: "2025-02-20",
          amountCents: -12_345,
          payee: "DISTRIBUTION TO CHECKING",
        },
        note: "",
      },
    }),
    // Before the HSA opened: logged, never reimbursable.
    expense("Old Optometry", "2024-06-01", 5_000),
    expense("Example Labs", "2025-02-05", 7_000, { receipt: false }),
  ],
  dismissed: [],
  ignoredMerchants: [],
  settings: {
    ...EMPTY_SETTINGS,
    openedOn: "2024-12-01",
    growthRate: 0.07,
    planYear: 2045,
  },
};

/** The Taxes page's rates, proven (the HSA page withholds its growth figures without them). */
const TAX_RATES = { year: 2025, incomeRate: 0.3, payrollRate: 0.0765, source: "TAX_REPORT" as const };

function report(book: Book, file = LOG, taxMarginal: typeof TAX_RATES | null = TAX_RATES): HsaReport {
  return buildHsaReport({
    today: "2025-03-15",
    file,
    ...hsaLedger(book),
    marginalRate: null,
    taxMarginal,
  });
}

/** Every wired figure, and what the HSA page shows for it (HsaClient / GrowthTab / ReimburseTab). */

const label = (d: HsaDescriptor) => `${d.metric}${d.part ? `:${d.part}` : ""}`;
const linksOf = (p: Proof): ProofLink[] =>
  p.blocks.flatMap((b) => (b.kind === "breakdown" ? b.items.flatMap((i) => (i.link ? [i.link] : [])) : b.kind === "chain" ? b.lines.flatMap((l) => (l.link ? [l.link] : [])) : []));

describe("buildHsaProof", () => {
  const book = makeBook(rows());
  const r = report(book);

  it("withholds the growth figures, page and proof alike, with no proven tax rate and none typed", () => {
    const bare = report(book, LOG, null);
    expect(bare.growth.withheld).toMatch(/No proven income tax rate/);
    expect(hsaFigures(bare).map((f) => (f.descriptor as HsaDescriptor).metric)).not.toContain("future");
    expect(buildHsaProof(book, bare, { report: "hsa", metric: "future" }).withheld).toBe(true);
    expect(r.growth.withheld).toBeNull();
  });

  it("proves every figure the page shows, its parts re-adding exactly", () => {
    expect(r.hsa.balanceCents).toBe(237_099);
    const figures = hsaFigures(r);
    expect(figures.length).toBe(13);
    for (const { descriptor, shown } of figures) {
      const d = descriptor as HsaDescriptor;
      const p = buildHsaProof(book, r, d);
      expect(p.figure, label(d)).toEqual(shown);
      expect(p.selfCheck?.ok, `${label(d)}: ${p.selfCheck?.explain}`).toBe(true);
      expect(p.descriptor).toEqual(d);
    }
  });

  it("reads the balance off the latest HSA statement: opening + rows + growth", () => {
    const p = buildHsaProof(book, r, { report: "hsa", metric: "balance" });
    const chain = p.blocks.find((b) => b.kind === "chain");
    if (chain?.kind !== "chain") throw new Error("no chain");
    expect(chain.lines[0]).toMatchObject({
      value: { cents: 167_444 },
      source: "proven",
    });
    expect(chain.lines.at(-1)).toMatchObject({
      op: "=",
      value: { cents: 237_099 },
    });
    const rowsBlock = p.blocks.find((b) => b.kind === "rows");
    expect(rowsBlock?.kind === "rows" && rowsBlock.groups.map((g) => g.statement.id)).toEqual(["st-hsa-2025-02-01"]);
    expect(p.checks.map((c) => c.id)).toContain("statement.chain");
  });

  it("splits contributions for the latest year by whose money, and yours by payroll vs direct", () => {
    const p = buildHsaProof(book, r, {
      report: "hsa",
      metric: "contributions",
    });
    expect(r.growth.funding).toMatchObject({
      source: "STATEMENTS",
      year: 2025,
      employeeCents: 50_000,
      employerCents: 50_000,
    });
    const how = p.blocks.find((b) => b.title === "Your part, by how it came in");
    expect(how?.kind === "breakdown" && how.items.map((i) => i.value)).toEqual([{ cents: 40_000 }, { cents: 10_000 }]);
    // The deposit marked "for 2024" isn't one of them.
    const listed = p.blocks.flatMap((b) => (b.kind === "rows" ? b.groups.flatMap((g) => g.rows.map((x) => x.payee)) : []));
    expect(listed).not.toContain("EMPLOYER CONTRIBUTION FOR 2024");
  });

  it("labels receipt-log figures as the owner's log, with no check over them", () => {
    const p = buildHsaProof(book, r, { report: "hsa", metric: "reimbursable" });
    const log = p.blocks[0];
    expect(log?.kind === "breakdown" && log.note).toMatch(/receipts log/);
    expect(log?.kind === "breakdown" && log.items.map((i) => i.label)).toEqual(["Springfield Dental", "Example Labs"]);
    expect(p.blocks.find((b) => b.title === "Logged but left out")).toBeTruthy();
    expect(p.checks).toEqual([]);
    // The dental receipt's card charge, read off the card's statement.
    const paid = p.blocks.find((b) => b.kind === "rows");
    expect(paid?.kind === "rows" && paid.groups[0]?.rows.map((x) => x.payee)).toEqual(["SPRINGFIELD DENTAL"]);
  });

  it("marks a projection's typed inputs as assumptions", () => {
    const p = buildHsaProof(book, r, { report: "hsa", metric: "future" });
    const chain = p.blocks[0];
    if (chain?.kind !== "chain") throw new Error("no chain");
    expect(chain.lines.filter((l) => l.source === "assumption").map((l) => l.label)).toEqual(["Reimbursable today", "Growth a year", "Years to 2045"]);
  });

  it("proves pay-stub contributions when the statements don't say whose money it is", async () => {
    const stub = (personId: string, employer: string, hsa: number, employerHsa: number): BookStub => {
      const lines: StubLine[] = [
        { name: "HSA", kind: "HSA", current: 0, ytd: hsa },
        {
          name: "Employer HSA",
          kind: "EMPLOYER_HSA",
          current: 0,
          ytd: employerHsa,
        },
      ];
      return {
        id: `s-${personId}`,
        documentId: "d",
        documentTitle: "stub.pdf",
        importedAt: "2025-01-01T00:00:00.000Z",
        source: "TRINET",
        employee: "Pat Example",
        employer,
        employerKey: employer.toUpperCase(),
        personId,
        payDate: "2024-12-31",
        periodStart: null,
        periodEnd: null,
        federalFilingStatus: null,
        lines,
        printed: {
          grossCurrent: 0,
          grossYtd: 0,
          withheldCurrent: 0,
          withheldYtd: 0,
          netCurrent: 0,
          netYtd: 0,
        },
        deposits: [],
        warnings: [],
        depositTransactionId: null,
      } as BookStub;
    };
    // No HSA deposit says whose it is (plain transfers in).
    const plain = rows().map((x) => (x.accountId === "hsa" && x.amountCents > 0 ? ({ ...x, lane: "TRANSFER", payee: "DEPOSIT" } as BookRow) : x));
    const b = makeBook(plain, {
      stubs: [stub("pat", "Example Partners LP", 120_000, 60_000), stub("sam", "Springfield Clinic", 30_000, 0)],
      taxProfile: {
        version: 1,
        persons: [
          { id: "pat", name: "Pat Example" },
          { id: "sam", name: "Sam Example" },
        ],
        dependents: [],
        accountOwners: {},
        accountKinds: {},
        qualifiedDividendShare: 1,
        moneyMarketUsGovShare: 0,
        mfsDependentClaimant: "AUTO",
        years: {},
      },
    } as unknown as Partial<Book>);
    const rr = report(b);
    expect(rr.growth.funding).toMatchObject({
      source: "PAY_STUBS",
      employeeCents: 150_000,
      employerCents: 60_000,
    });
    for (const part of [undefined, "employee", "employer"] as const) {
      const p = buildHsaProof(b, rr, {
        report: "hsa",
        metric: "contributions",
        ...(part ? { part } : {}),
      });
      expect(p.selfCheck?.ok, p.selfCheck?.explain).toBe(true);
      // Each stub total opens the pay proof of exactly that line, and it shows the same figure.
      const items = p.blocks.flatMap((x) => (x.kind === "breakdown" && x.title === "From the pay stubs" ? x.items : []));
      expect(items.length).toBeGreaterThan(0);
      for (const i of items) {
        expect(i.link?.descriptor.report, i.label).toBe("pay");
        const q = await buildProof({ book: b, db: {} as never }, parseDescriptor(JSON.parse(JSON.stringify(i.link!.descriptor))) as Parameters<typeof buildProof>[1]);
        expect(q.figure, i.label).toEqual(i.value);
      }
    }
  });
});

describe("as a registered proof kind", () => {
  const book = makeBook(rows());
  const r = report(book);
  const kind = makeHsaKind(async () => r);
  const ctx = { book, db: {} as never };

  it("parses through the registry and rejects bad parts", () => {
    for (const { descriptor: d } of hsaFigures(r)) expect(parseDescriptor(JSON.parse(JSON.stringify(d))), label(d as HsaDescriptor)).toEqual(d);
    expect(parseDescriptor({ report: "hsa", metric: "distributions" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "hsa", metric: "balance", part: "employee" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "hsa", metric: "horoscope" })).toHaveProperty("error");
  });

  it("emits links that parse, build and come to the value they're shown with", async () => {
    let seen = 0;
    for (const { descriptor } of hsaFigures(r)) {
      const d = descriptor as HsaDescriptor;
      const p = await kind.build(ctx, d);
      const values = new Map<string, unknown>();
      for (const b of p.blocks) {
        if (b.kind === "breakdown") for (const i of b.items) if (i.link) values.set(JSON.stringify(i.link.descriptor), i.value);
        if (b.kind === "chain") for (const l of b.lines) if (l.link) values.set(JSON.stringify(l.link.descriptor), l.value);
      }
      for (const l of linksOf(p)) {
        seen++;
        const parsed = parseDescriptor(JSON.parse(JSON.stringify(l.descriptor)));
        expect(parsed, l.label).not.toHaveProperty("error");
        const q = await kind.build(ctx, parsed as HsaDescriptor);
        expect(q.selfCheck?.ok, l.label).toBe(true);
        expect(q.figure, l.label).toEqual(values.get(JSON.stringify(l.descriptor)));
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});
