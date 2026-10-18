import { describe, expect, it } from "vitest";
import type { Lane } from "../classifier/taxonomy";
import { NO_HOUSEHOLD } from "../household/patterns";
import { groupFor, refreshLedgerStatus, type LedgerAccount } from "../ledger/loadLedger";
import { buildTimeline, type SegmentInput } from "../ledger/timeline";
import type { Book, BookRow, BookStatement } from "../book/load";
import { buildProof, parseDescriptor, type Proof, type ProofDescriptor, type ProofLink } from "../book/proof/index";
import { buildHomeSummary } from "./homeSummary";

// An invented household: Pat Example at Springfield Bank, Jan 2025 – mid-Mar 2026.
// Checking (••1234), a card (••5678), a brokerage, a 401(k) and savings first on file in
// June 2025. Every name and amount is made up.

const ACCOUNTS = [
  { id: "chk", name: "Pat's checking ••1234", type: "CHECKING", subtype: "CHECKING" },
  { id: "card", name: "Pat's card ••5678", type: "CREDIT_CARD", subtype: "CREDIT_CARD" },
  { id: "brk", name: "Example brokerage ••2468", type: "INVESTMENT", subtype: "BROKERAGE" },
  { id: "ret", name: "Example 401(k)", type: "INVESTMENT", subtype: "401K" },
  { id: "sav", name: "Pat's savings ••9753", type: "SAVINGS", subtype: "SAVINGS" },
];

type Flow = [day: string, cents: number, lane: Lane, payee: string, category: string, precision?: "PERIOD"];
const MONTHS = Array.from({ length: 15 }, (_, i) => {
  const y = 2025 + Math.floor(i / 12);
  const m = String((i % 12) + 1).padStart(2, "0");
  const last = new Date(Date.UTC(y, (i % 12) + 1, 0)).getUTCDate();
  return { i, from: `${y}-${m}-01`, to: `${y}-${m}-${last}`, day: (d: number) => `${y}-${m}-${String(d).padStart(2, "0")}` };
});

function flowsFor(account: string, m: (typeof MONTHS)[number]): { flows: Flow[]; growth: number; fees: number } {
  const k = m.i;
  if (account === "chk")
    return {
      flows: [
        [m.day(3), -(30_000 + 100 * k + 12_345), "TRANSFER", "CARD PAYMENT", "Transfer"],
        [m.day(5), -45_000, "EXPENSE", "SPRINGFIELD POWER", "Housing & utilities"],
        [m.day(15), 600_000, "INCOME", "EXAMPLE PARTNERS LP PAYROLL", "Paycheck"],
        [m.day(20), -100_000, "TRANSFER", "TO BROKERAGE", "Transfer"],
        ...(k % 3 === 1 ? ([[m.day(22), 25_000, "EXTERNAL_TRANSFER", "FROM PARTNER", "Partner"]] as Flow[]) : []),
      ],
      growth: 0,
      fees: 0,
    };
  if (account === "card")
    return {
      flows: [
        [m.day(3), 30_000 + 100 * k + 12_345, "TRANSFER", "PAYMENT THANK YOU", "Transfer"],
        [m.day(9), -(30_000 + 100 * (k + 1)), "EXPENSE", "SPRINGFIELD GROCER", "Groceries"],
        [m.day(18), -12_345, "EXPENSE", "EXAMPLE DINER", "Dining"],
      ],
      growth: 0,
      fees: 0,
    };
  if (account === "brk") return { flows: [[m.day(20), 100_000, "TRANSFER", "FROM CHECKING", "Transfer"]], growth: k % 2 ? -21_111 : 43_210, fees: -1_234 };
  if (account === "ret")
    return {
      flows: [
        [m.to, 50_000, "CONTRIBUTION_EMPLOYEE", "EMPLOYEE DEFERRAL", "Retirement", "PERIOD"],
        [m.to, 25_000, "CONTRIBUTION_EMPLOYER", "EMPLOYER MATCH", "Retirement", "PERIOD"],
      ],
      growth: 12_000,
      fees: 0,
    };
  return { flows: [], growth: 0, fees: 0 };
}

const OPENING: Record<string, number> = { chk: 1_000_000, card: -42_345, brk: 5_000_000, ret: 2_000_000, sav: 400_000 };

function makeBook(): Book {
  const statements: BookStatement[] = [];
  const rows: BookRow[] = [];
  const ledgerAccounts: LedgerAccount[] = ACCOUNTS.map((a) => {
    let bal = OPENING[a.id]!;
    const segs: SegmentInput[] = [];
    for (const m of MONTHS) {
      if (a.id === "sav" && m.from < "2025-06-01") continue;
      const id = `st-${a.id}-${m.from}`;
      statements.push({
        id,
        accountId: a.id,
        documentId: `doc-${id}`,
        documentTitle: `${a.id}-${m.from}.pdf`,
        importedAt: "2026-04-01T00:00:00.000Z",
        status: "COMMITTED",
        isSummary: false,
        periodStart: m.from,
        periodEnd: m.to,
        deltaCents: 0,
      });
      const { flows, growth, fees } = flowsFor(a.id, m);
      const open = bal;
      bal += flows.reduce((t, f) => t + f[1], 0) + growth + fees;
      segs.push({
        accountId: a.id,
        importId: id,
        periodStart: m.from,
        periodEnd: m.to,
        openingCents: open,
        closingCents: bal,
        growthCents: growth,
        feesCents: fees,
        flows: flows.map(([date, cents, lane, payee, category, precision], j) => {
          const rowId = `r-${a.id}-${m.from}-${j}`;
          rows.push({
            id: rowId,
            date,
            precision: precision ?? "EXACT",
            statement: { start: m.from, end: m.to },
            bookedOn: date,
            amountCents: cents,
            lane,
            accountId: a.id,
            payee,
            merchantKey: payee,
            category,
            categoryGroup: null,
            counterpartyKind: null,
            counterpartyInstitution: null,
            counterpartyAccountHint: null,
            classifiedBy: null,
            transferMatchId: null,
            statementImportId: id,
            documentId: `doc-${id}`,
          });
          return { id: rowId, date, precision: precision ?? ("EXACT" as const), amountCents: cents, lane };
        }),
      });
    }
    return {
      ...a,
      institution: "Springfield Bank",
      subtype: a.subtype as LedgerAccount["subtype"],
      group: groupFor(a.subtype, a.type),
      isInvestment: a.type === "INVESTMENT",
      timeline: buildTimeline(a.id, segs, []),
      statementCount: segs.length,
      closed: false,
    };
  });
  const ledger = { accounts: ledgerAccounts, mergeDate: "2024-12-01", completeThrough: null, firstDay: null };
  refreshLedgerStatus(ledger, "2026-03-20");
  return {
    today: "2026-03-20",
    // Net worth runs into March; cash flow's last complete month is February.
    horizon: { cashFlow: "2026-03-15", netWorth: "2026-03-15" },
    ledger,
    accounts: ledgerAccounts.map((a) => ({ id: a.id, name: a.name, institution: a.institution, type: a.type, subtype: a.subtype, group: a.group, identifiers: [] })),
    statements,
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
  } as unknown as Book;
}

const ctx = (book: Book) => ({ book, db: {} as never });
const cents = (p: Proof) => ("cents" in p.figure ? p.figure.cents : NaN);
const links = (p: Proof): ProofLink[] =>
  p.blocks.flatMap((b) => (b.kind === "breakdown" ? b.items.flatMap((i) => (i.link ? [i.link] : [])) : b.kind === "chain" ? b.lines.flatMap((l) => (l.link ? [l.link] : [])) : []));

/** Every figure the Dashboard makes clickable, with what the card shows. */
function cards(s: ReturnType<typeof buildHomeSummary>): [string, ProofDescriptor | null | undefined, number | null | undefined][] {
  const nw = s.netWorth;
  const cf = s.cashFlow;
  return [
    ["net worth", nw.proofs?.total, nw.totalCents],
    ["assets", nw.proofs?.assets, nw.assetsCents],
    ["debts", nw.proofs?.debts, nw.debtsCents],
    ["liquid", nw.proofs?.liquid, nw.liquidCents],
    ...nw.groups.map((g): [string, ProofDescriptor, number] => [g.group, g.proof, g.cents]),
    ["1 month", nw.change.month.proof, nw.change.month.cents],
    ["12 months", nw.change.year.proof, nw.change.year.cents],
    ["YTD", nw.change.ytd.proof, nw.change.ytd.cents],
    ["from saving", nw.drivers?.proofs.principal, nw.drivers?.principalCents],
    ["from markets", nw.drivers?.proofs.growth, nw.drivers?.growthCents],
    ["income 12 mo", cf.last12?.proofs.income, cf.last12?.incomeCents],
    ["spending 12 mo", cf.last12?.proofs.spending, cf.last12?.spendingCents],
    ["saved 12 mo", cf.last12?.proofs.net, cf.last12?.netCents],
    ["last month's spending", cf.lastMonth?.proof, cf.lastMonth?.spendingCents],
    ...cf.categories.filter((c) => c.lastMonthCents).map((c): [string, ProofDescriptor | undefined, number] => [c.category, c.proof, c.lastMonthCents]),
  ];
}

describe("home summary proofs", () => {
  it("names, for every card figure, a proof that parses, builds and equals the card", async () => {
    const book = makeBook();
    const s = buildHomeSummary(book);
    expect(s.netWorth.asOf).toBe("2026-03-15");
    expect(s.cashFlow.through).toBe("2026-02-28");
    const list = cards(s);
    expect(list.length).toBeGreaterThan(18);
    for (const [label, descriptor, shown] of list) {
      expect(descriptor, label).toBeTruthy();
      expect(shown, label).not.toBeNull();
      expect(parseDescriptor(JSON.parse(JSON.stringify(descriptor))), label).toEqual(descriptor);
      const p = await buildProof(ctx(book), descriptor!);
      expect(cents(p), label).toBe(shown);
      expect(p.withheld, label).toBe(false);
      if (p.selfCheck) expect(p.selfCheck.ok, `${label}: ${p.selfCheck.explain}`).toBe(true);
    }
  });

  it("splits the twelve-month change into saving, markets and the rest", async () => {
    const book = makeBook();
    const s = buildHomeSummary(book);
    const d = s.netWorth.drivers!;
    expect(d.principalCents).not.toBe(0);
    expect(d.growthCents).not.toBe(0);
    const change = await buildProof(ctx(book), { report: "net-worth", metric: "change", granularity: "month", start: d.proofs.principal.report === "dashboard" ? d.proofs.principal.start : "", end: s.netWorth.asOf });
    expect(d.principalCents + d.growthCents + d.otherCents).toBe(cents(change));
  });
});

describe("dashboard proof", () => {
  it("rejects what isn't one of its figures", () => {
    expect(parseDescriptor({ report: "dashboard", figure: "luck", start: "2025-01-01", end: "2025-12-31" })).toEqual({ error: "figure must be saving or markets." });
    expect(parseDescriptor({ report: "dashboard", figure: "saving", start: "2025-12-31", end: "2025-01-01" })).toEqual({ error: "start is after end." });
  });

  it("chains its parts, and every part links to a proof that builds", async () => {
    const book = makeBook();
    const d = buildHomeSummary(book).netWorth.drivers!;
    for (const [descriptor, shown] of [
      [d.proofs.principal, d.principalCents],
      [d.proofs.growth, d.growthCents],
    ] as const) {
      const p = await buildProof(ctx(book), descriptor);
      const chain = p.blocks.find((b) => b.kind === "chain");
      expect(chain?.kind === "chain" && chain.lines.at(-1)).toMatchObject({ op: "=", value: { cents: shown } });
      const ls = links(p);
      expect(ls.length).toBeGreaterThan(2);
      for (const l of ls) {
        expect(parseDescriptor(JSON.parse(JSON.stringify(l.descriptor))), l.label).toEqual(l.descriptor);
        await buildProof(ctx(book), l.descriptor);
      }
    }
    // By month, the parts sum to the figure.
    const byMonth = (await buildProof(ctx(book), d.proofs.growth)).blocks.find((b) => b.kind === "breakdown");
    expect(byMonth?.kind === "breakdown" && byMonth.items.reduce((t, i) => t + ("cents" in i.value ? i.value.cents : 0), 0)).toBe(d.growthCents);
  });
});
