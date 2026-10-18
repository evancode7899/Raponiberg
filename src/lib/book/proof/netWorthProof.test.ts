import { describe, expect, it } from "vitest";
import type { Lane } from "../../classifier/taxonomy";
import { NO_HOUSEHOLD } from "../../household/patterns";
import { groupFor, refreshLedgerStatus, type LedgerAccount } from "../../ledger/loadLedger";
import { buildTimeline, valueAt, withIdleWindows, type SegmentInput } from "../../ledger/timeline";
import type { Book, BookRow, BookStatement } from "../load";
import { buildNetWorth } from "../reports/netWorth";
import type { Finding } from "../types";
import { buildProof, parseDescriptor, type Proof, type ProofLink } from "./index";
import { buildNetWorthProof, type NetWorthDescriptor } from "./netWorthProof";

// An invented household: Pat Example at Springfield Bank, Jan – Apr 2025. Checking
// (••1234), a card (••5678) with one proven idle cycle, a quarterly brokerage statement,
// a 401(k) whose Feb – Mar comes from a year-to-date summary, an HSA first on file in
// March, and savings with a missing February. Every name and amount is made up.

type Flow = [date: string, cents: number, lane: Lane, payee: string, precision?: "PERIOD"];
type Seg = {
  account: string;
  from: string;
  to: string;
  open: number;
  close: number;
  growth?: number;
  fees?: number;
  flows?: Flow[];
  summary?: true;
};

const SEGS: Seg[] = [
  ...(["01", "02", "03", "04"] as const).map((m): Seg => {
    const flows: Flow[] = [
      [`2025-${m}-02`, -210_000, "EXPENSE", "SPRINGFIELD PROPERTY MGMT"],
      [`2025-${m}-14`, 512_345, "INCOME", "EXAMPLE PARTNERS LP PAYROLL"],
    ];
    if (m === "02") flows.push(["2025-02-10", -12_834, "TRANSFER", "CARD PAYMENT"], ["2025-02-20", 30_000, "EXTERNAL_TRANSFER", "FROM PARTNER"]);
    if (m === "03") flows.push(["2025-03-12", -4_101, "TRANSFER", "CARD PAYMENT"], ["2025-03-20", -100_000, "TRANSFER", "TO BROKERAGE"]);
    return {
      account: "chk",
      from: `2025-${m}-01`,
      to: m === "02" ? "2025-02-28" : m === "04" ? "2025-04-30" : `2025-${m}-31`,
      open: 0,
      close: 0,
      flows,
    };
  }),
  {
    account: "card",
    from: "2025-01-05",
    to: "2025-02-04",
    open: 0,
    close: -8_733,
    flows: [["2025-01-09", -8_733, "EXPENSE", "SPRINGFIELD GROCER"]],
  },
  {
    account: "card",
    from: "2025-02-05",
    to: "2025-03-04",
    open: -8_733,
    close: -4_101,
    flows: [
      ["2025-02-10", 12_834, "TRANSFER", "PAYMENT THANK YOU"],
      ["2025-02-11", -8_202, "EXPENSE", "EXAMPLE DINER"],
    ],
  },
  // 2025-03-05 – 04-04: no statement; proven idle, paid off from checking on Mar 12 (see makeBook).
  {
    account: "card",
    from: "2025-04-05",
    to: "2025-05-04",
    open: 0,
    close: -2_000,
    flows: [["2025-04-12", -2_000, "EXPENSE", "SPRINGFIELD HARDWARE"]],
  },
  {
    account: "brk",
    from: "2025-01-01",
    to: "2025-03-31",
    open: 5_000_000,
    close: 5_214_456,
    growth: 123_457,
    fees: -9_001,
    flows: [["2025-03-20", 100_000, "TRANSFER", "FROM CHECKING"]],
  },
  {
    account: "brk",
    from: "2025-04-01",
    to: "2025-04-30",
    open: 5_214_456,
    close: 5_164_456,
    growth: -50_000,
  },
  {
    account: "ret",
    from: "2025-01-01",
    to: "2025-01-31",
    open: 2_000_000,
    close: 2_060_000,
    growth: 10_000,
    flows: [["2025-01-31", 50_000, "CONTRIBUTION_EMPLOYEE", "EMPLOYEE DEFERRAL", "PERIOD"]],
  },
  {
    account: "ret",
    from: "2025-04-01",
    to: "2025-04-30",
    open: 2_300_000,
    close: 2_355_000,
    growth: 5_000,
    flows: [["2025-04-30", 50_000, "CONTRIBUTION_EMPLOYEE", "EMPLOYEE DEFERRAL", "PERIOD"]],
  },
  {
    account: "ret",
    from: "2025-01-01",
    to: "2025-04-30",
    open: 2_000_000,
    close: 2_355_000,
    growth: 115_000,
    summary: true,
    flows: [
      ["2025-04-30", 200_000, "CONTRIBUTION_EMPLOYEE", "EMPLOYEE DEFERRAL", "PERIOD"],
      ["2025-04-30", 40_000, "CONTRIBUTION_EMPLOYER", "EMPLOYER MATCH", "PERIOD"],
    ],
  },
  {
    account: "hsa",
    from: "2025-03-01",
    to: "2025-04-30",
    open: 300_000,
    close: 301_000,
    growth: 1_000,
  },
  {
    account: "sav",
    from: "2025-01-01",
    to: "2025-01-31",
    open: 400_000,
    close: 400_000,
  },
  // February missing: March opens higher than January closed.
  {
    account: "sav",
    from: "2025-03-01",
    to: "2025-04-30",
    open: 410_000,
    close: 410_000,
  },
];

// Checking's balances chain from $10,000.00 on Jan 1.
{
  let bal = 1_000_000;
  for (const s of SEGS.filter((x) => x.account === "chk")) {
    s.open = bal;
    bal += s.flows!.reduce((t, f) => t + f[1], 0);
    s.close = bal;
  }
}

const ACCOUNTS = [
  {
    id: "chk",
    name: "Pat's checking ••1234",
    type: "CHECKING",
    subtype: "CHECKING",
  },
  {
    id: "card",
    name: "Pat's card ••5678",
    type: "CREDIT_CARD",
    subtype: "CREDIT_CARD",
  },
  {
    id: "brk",
    name: "Example brokerage ••2468",
    type: "INVESTMENT",
    subtype: "BROKERAGE",
  },
  { id: "ret", name: "Example 401(k)", type: "INVESTMENT", subtype: "401K" },
  { id: "hsa", name: "Example HSA", type: "INVESTMENT", subtype: "HSA" },
  {
    id: "sav",
    name: "Pat's savings ••9753",
    type: "SAVINGS",
    subtype: "SAVINGS",
  },
];

function makeBook(extra: { findings?: Finding[] } = {}): Book {
  const statements: BookStatement[] = [];
  const rows: BookRow[] = [];
  const inputs = new Map<string, { statements: SegmentInput[]; summaries: SegmentInput[] }>();
  SEGS.forEach((s, k) => {
    const id = `st-${s.account}-${s.from}${s.summary ? "-ytd" : ""}`;
    statements.push({
      id,
      accountId: s.account,
      documentId: `doc-${k}`,
      documentTitle: `${s.account}-${s.from}${s.summary ? "-summary" : ""}.pdf`,
      importedAt: "2025-05-01T00:00:00.000Z",
      status: "COMMITTED",
      isSummary: !!s.summary,
      periodStart: s.from,
      periodEnd: s.to,
      deltaCents: 0,
    });
    const flows = (s.flows ?? []).map(([date, cents, lane, payee, precision], i) => {
      const rowId = `r-${k}-${i}`;
      if (!s.summary)
        rows.push({
          id: rowId,
          date,
          precision: precision ?? "EXACT",
          statement: { start: s.from, end: s.to },
          bookedOn: date,
          amountCents: cents,
          lane,
          accountId: s.account,
          payee,
          merchantKey: null,
          category: lane === "INCOME" ? "Paycheck" : lane === "EXPENSE" ? "Groceries" : lane === "EXTERNAL_TRANSFER" ? "Partner" : "Transfer",
          categoryGroup: null,
          counterpartyKind: null,
          counterpartyInstitution: null,
          counterpartyAccountHint: null,
          classifiedBy: null,
          transferMatchId: null,
          statementImportId: id,
          documentId: `doc-${k}`,
        });
      return {
        id: rowId,
        date,
        precision: precision ?? ("EXACT" as const),
        amountCents: cents,
        lane,
      };
    });
    const seg: SegmentInput = {
      accountId: s.account,
      importId: id,
      periodStart: s.from,
      periodEnd: s.to,
      openingCents: s.open,
      closingCents: s.close,
      growthCents: s.growth ?? 0,
      feesCents: s.fees ?? 0,
      flows,
    };
    const b = inputs.get(s.account) ?? { statements: [], summaries: [] };
    (s.summary ? b.summaries : b.statements).push(seg);
    inputs.set(s.account, b);
  });
  const idle = {
    accountId: "card",
    from: "2025-03-05",
    to: "2025-04-04",
    payerIds: ["chk"],
    trailing: false,
    openingCents: -4_101,
    payoff: [{ transactionId: "r-pay", date: "2025-03-12", amountCents: -4_101 }],
  };
  const ledgerAccounts: LedgerAccount[] = ACCOUNTS.map((a) => {
    const x = inputs.get(a.id)!;
    let timeline = buildTimeline(a.id, x.statements, x.summaries);
    if (a.id === "card") timeline = withIdleWindows(timeline, [idle]);
    return {
      ...a,
      institution: "Springfield Bank",
      subtype: a.subtype as LedgerAccount["subtype"],
      group: groupFor(a.subtype, a.type),
      isInvestment: a.type === "INVESTMENT",
      timeline,
      statementCount: x.statements.length,
      closed: false,
    };
  });
  const ledger = {
    accounts: ledgerAccounts,
    mergeDate: "2024-12-01",
    completeThrough: null,
    firstDay: null,
  };
  refreshLedgerStatus(ledger, "2025-05-15");
  return {
    today: "2025-05-15",
    horizon: { cashFlow: "2025-04-30", netWorth: "2025-04-30" },
    ledger,
    accounts: ledgerAccounts.map((a) => ({
      id: a.id,
      name: a.name,
      institution: a.institution,
      type: a.type,
      subtype: a.subtype,
      group: a.group,
      identifiers: [],
    })),
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
    idle: { proven: [idle], unproven: [] },
    integrity: {
      checks: [],
      findings: extra.findings ?? [],
      inferences: [],
      accepted: [],
      stale: [],
      retired: [],
    },
    passes: [],
  } as unknown as Book;
}

const bal = (date: string, x: Partial<Extract<NetWorthDescriptor, { metric: "balance" }>> = {}): NetWorthDescriptor => ({
  report: "net-worth",
  metric: "balance",
  date,
  ...x,
});
const chg = (start: string, end: string, x: Partial<Extract<NetWorthDescriptor, { metric: "change" }>> = {}): NetWorthDescriptor => ({
  report: "net-worth",
  metric: "change",
  granularity: "month",
  start,
  end,
  ...x,
});
const cents = (p: Proof) => ("cents" in p.figure ? p.figure.cents : NaN);
const rowsOf = (p: Proof) => p.blocks.flatMap((b) => (b.kind === "rows" ? b.groups : []));
const links = (p: Proof): ProofLink[] =>
  p.blocks.flatMap((b) =>
    b.kind === "breakdown" ? b.items.flatMap((i) => (i.link ? [i.link] : [])) : b.kind === "chain" ? b.lines.flatMap((l) => (l.link ? [l.link] : [])) : [],
  );

describe("net-worth balance proof", () => {
  it("matches every month-end the report shows, household and each account, and re-adds exactly", () => {
    const book = makeBook();
    const report = buildNetWorth(book, { granularity: "month" });
    expect(report.periods.length).toBe(4);
    for (const p of report.periods) {
      const h = buildNetWorthProof(book, bal(p.end));
      expect(cents(h), p.label).toBe(p.household.closingCents);
      expect(h.selfCheck, p.label).toMatchObject({ ok: true, deltaCents: 0 });
      for (const a of p.byAccount) {
        const one = buildNetWorthProof(book, bal(p.end, { accountIds: [a.accountId] }));
        expect(cents(one), `${a.accountId} ${p.label}`).toBe(a.closingCents);
        expect(one.selfCheck?.ok, `${a.accountId} ${p.label}`).toBe(true);
      }
      // The opening of each period is the balance the day before it starts.
      expect(cents(buildNetWorthProof(book, bal(addDay(p.start, -1))))).toBe(p.household.openingCents);
    }
  });

  it("re-adds on any day: inside an investment statement, a derived stretch, an idle cycle and a gap", () => {
    const book = makeBook();
    for (const date of ["2025-01-01", "2025-02-15", "2025-03-04", "2025-03-20", "2025-04-04", "2025-04-17"]) {
      const p = buildNetWorthProof(book, bal(date));
      const expected = book.ledger.accounts.filter((a) => a.timeline.firstDay! <= date).reduce((t, a) => t + valueAt(a.timeline, date).cents, 0);
      expect(cents(p), date).toBe(expected);
      expect(p.selfCheck?.ok, date).toBe(true);
    }
  });

  it("names the statement behind each balance, with its opening, rows and the day's share of market change", () => {
    const book = makeBook();
    const p = buildNetWorthProof(book, bal("2025-02-15", { accountIds: ["brk"] }));
    const [g] = rowsOf(p);
    expect(g!.statement).toMatchObject({
      account: "Example brokerage ••2468",
      periodStart: "2025-01-01",
      periodEnd: "2025-03-31",
      status: "COMMITTED",
      documentTitle: "brk-2025-01-01.pdf",
    });
    expect(g!.statement.id.startsWith("st-brk-2025-01-01")).toBe(true);
    expect(g!.rows[0]).toMatchObject({
      payee: "Opening balance",
      countedCents: 5_000_000,
    });
    const growth = g!.rows.find((r) => r.payee === "Market change")!;
    expect(growth.share).toBeCloseTo(46 / 90, 12);
    expect(growth.amountCents).toBe(123_457);
    // The March deposit hasn't happened yet on Feb 15.
    expect(g!.rows.some((r) => r.payee === "FROM CHECKING")).toBe(false);
    expect(p.estimates.some((e) => e.detail.includes("investment statement"))).toBe(true);

    const chk = rowsOf(buildNetWorthProof(book, bal("2025-02-15", { accountIds: ["chk"] })))[0]!;
    expect(chk.rows.map((r) => r.payee)).toEqual(["Opening balance", "SPRINGFIELD PROPERTY MGMT", "CARD PAYMENT", "EXAMPLE PARTNERS LP PAYROLL"]);
    expect(chk.rows[1]).toMatchObject({
      id: expect.stringMatching(/^r-/),
      date: "2025-02-02",
      category: "Groceries",
    });
  });

  it("lists a derived stretch, an interpolated gap and an idle cycle as estimates", () => {
    const book = makeBook();
    const ret = buildNetWorthProof(book, bal("2025-02-28", { accountIds: ["ret"] }));
    expect(rowsOf(ret)[0]!.statement).toMatchObject({
      status: "DERIVED",
      periodStart: "2025-02-01",
      periodEnd: "2025-03-31",
    });
    expect(rowsOf(ret)[0]!.statement.documentTitle).toContain("summary");
    expect(ret.estimates.map((e) => e.detail).join(" ")).toContain("year-end summary");
    expect(ret.selfCheck?.ok).toBe(true);

    const sav = buildNetWorthProof(book, bal("2025-02-14", { accountIds: ["sav"] }));
    expect(rowsOf(sav)[0]!.rows.map((r) => r.payee)).toEqual(["Closing balance, last statement before the gap", "Interpolated toward the next statement's opening"]);
    expect(sav.estimates[0]!.detail).toContain("gap between statements");
    expect(sav.selfCheck?.ok).toBe(true);

    const card = buildNetWorthProof(book, bal("2025-03-20", { accountIds: ["card"] }));
    expect(cents(card)).toBe(0);
    expect(rowsOf(card)[0]!.statement).toMatchObject({
      status: "IDLE",
      periodStart: "2025-03-05",
      periodEnd: "2025-04-04",
    });
    expect(rowsOf(card)[0]!.rows.map((r) => r.payee)).toEqual(["Balance carried in", "Paid off from the bank"]);
    expect(card.estimates.map((e) => e.id)).toContain("idle:card:2025-03-05");
  });

  it("splits assets from debts, and leaves an account out until its first statement", () => {
    const book = makeBook();
    const assets = buildNetWorthProof(book, bal("2025-01-31", { side: "assets" }));
    const debts = buildNetWorthProof(book, bal("2025-01-31", { side: "debts" }));
    expect(cents(assets) + cents(debts)).toBe(cents(buildNetWorthProof(book, bal("2025-01-31"))));
    expect(cents(debts)).toBe(-8_733);
    expect(debts.describes).toMatch(/^Debts/);
    const feb = buildNetWorthProof(book, bal("2025-02-28"));
    const accounts = feb.blocks.find((b) => b.title === "By account");
    expect(accounts?.kind === "breakdown" && accounts.items.some((i) => i.label === "Example HSA")).toBe(false);
  });
});

describe("net-worth change proof", () => {
  it("re-adds every period's change from its parts, as the report decomposes it", () => {
    const book = makeBook();
    for (const g of ["month", "quarter"] as const) {
      for (const p of buildNetWorth(book, { granularity: g }).periods) {
        const proof = buildNetWorthProof(book, chg(p.start, p.end, { granularity: g }));
        expect(cents(proof), `${g} ${p.label}`).toBe(p.household.closingCents - p.household.openingCents);
        expect(proof.selfCheck, `${g} ${p.label}`).toMatchObject({
          ok: true,
          deltaCents: 0,
        });
        const chain = proof.blocks[0]!;
        if (chain.kind !== "chain") throw new Error("no chain");
        expect(chain.lines.at(-1)!.value).toEqual({
          cents: p.household.closingCents,
        });
        expect(chain.lines[0]!.value).toEqual({
          cents: p.household.openingCents,
        });
        // Read as written, each line under its own sign, the chain works out to the closing.
        const worked = chain.lines.slice(0, -1).reduce((t, l) => t + (l.op === "−" ? -1 : 1) * ("cents" in l.value ? l.value.cents : NaN), 0);
        expect(worked, `${g} ${p.label}`).toBe(p.household.closingCents);
        for (const a of p.byAccount) {
          const one = buildNetWorthProof(book, chg(p.start, p.end, { granularity: g, accountIds: [a.accountId] }));
          expect(cents(one), `${a.accountId} ${p.label}`).toBe(a.closingCents - a.openingCents);
          expect(one.selfCheck?.ok, `${a.accountId} ${p.label}`).toBe(true);
        }
      }
    }
  });

  it("shows the HSA entering with its balance, and the 401(k) contributions from pay", () => {
    const book = makeBook();
    const mar = buildNetWorthProof(book, chg("2025-03-01", "2025-03-31"));
    const chain = mar.blocks[0]!;
    if (chain.kind !== "chain") throw new Error("no chain");
    const line = (label: string) => chain.lines.find((l) => l.label.startsWith(label));
    const amount = (label: string) => {
      const v = line(label)?.value;
      return v && "cents" in v ? v.cents : 0;
    };
    expect(line("Balances already in accounts")?.value).toEqual({
      cents: 300_000,
    });
    expect(amount("Retirement contributions")).toBeGreaterThan(0);
    expect(amount("Employer")).toBeGreaterThan(0);
    expect(line("Income")?.link?.descriptor).toMatchObject({
      report: "cash-flow",
      metric: "income",
      start: "2025-03-01",
      end: "2025-03-31",
    });
  });

  it("sums a range the way the page does: its months, each linking to its own proof", async () => {
    const book = makeBook();
    const months = buildNetWorth(book, { granularity: "month" }).periods;
    const p = buildNetWorthProof(book, chg("2025-01-01", "2025-04-30"));
    expect(cents(p)).toBe(months.at(-1)!.household.closingCents - months[0]!.household.openingCents);
    expect(p.selfCheck?.ok).toBe(true);
    const byMonth = p.blocks.find((b) => b.title === "By month");
    if (byMonth?.kind !== "breakdown") throw new Error("no months");
    expect(byMonth.items.reduce((t, i) => t + ("cents" in i.value ? i.value.cents : 0), 0)).toBe(cents(p));
    const ctx = { book, db: {} as never };
    for (const i of byMonth.items) expect((await buildProof(ctx, i.link!.descriptor)).figure).toEqual(i.value);
    const byAccount = p.blocks.find((b) => b.title === "By account");
    if (byAccount?.kind !== "breakdown") throw new Error("no accounts");
    expect(byAccount.items.reduce((t, i) => t + ("cents" in i.value ? i.value.cents : 0), 0)).toBe(cents(p));
    for (const i of byAccount.items) expect((await buildProof(ctx, i.link!.descriptor)).figure).toEqual(i.value);
  });

  it("checks a change from the day before it starts (the opening), a balance only on its day", () => {
    const finding: Finding = {
      id: "statement.gap:x",
      check: "statement.gap",
      status: "MISSING",
      title: "A statement is missing",
      detail: "",
      fix: "",
      scope: {
        accountId: "sav",
        from: "2025-02-28",
        to: "2025-02-28",
        affects: ["NET_WORTH"],
      },
    };
    const book = makeBook({ findings: [finding] });
    const mar = buildNetWorthProof(book, chg("2025-03-01", "2025-03-31"));
    expect(mar.withheld).toBe(true);
    expect(mar.checks.find((c) => c.id === "statement.gap")?.state).toBe("open");
    expect(buildNetWorthProof(book, bal("2025-03-31")).withheld).toBe(false);
    expect(buildNetWorthProof(book, chg("2025-03-01", "2025-03-31", { accountIds: ["chk"] })).withheld).toBe(false);
    expect(mar.checks.map((c) => c.id)).toEqual([
      "statement.held",
      "statement.chain",
      "statement.gap",
      "statement.history",
      "statement.overdue",
      "transfer.unmatched",
      "transfer.decisions",
      "ledger.consistency",
      "ledger.freshness",
      "networth.reconciles",
    ]);
  });
});

describe("net-worth as a registered proof kind", () => {
  it("parses its recipes and rejects bad ones", () => {
    expect(
      parseDescriptor({
        report: "net-worth",
        metric: "balance",
        date: "2025-01-31",
        accountIds: [],
      }),
    ).toEqual({ report: "net-worth", metric: "balance", date: "2025-01-31" });
    expect(
      parseDescriptor({
        report: "net-worth",
        metric: "change",
        granularity: "quarter",
        start: "2025-01-01",
        end: "2025-03-31",
        accountIds: ["chk"],
      }),
    ).toEqual({
      report: "net-worth",
      metric: "change",
      granularity: "quarter",
      start: "2025-01-01",
      end: "2025-03-31",
      accountIds: ["chk"],
    });
    expect(parseDescriptor({ report: "net-worth" })).toHaveProperty("error");
    expect(
      parseDescriptor({
        report: "net-worth",
        metric: "balance",
        date: "Jan 31",
      }),
    ).toHaveProperty("error");
    expect(
      parseDescriptor({
        report: "net-worth",
        metric: "balance",
        date: "2025-01-31",
        side: "both",
      }),
    ).toHaveProperty("error");
    expect(
      parseDescriptor({
        report: "net-worth",
        metric: "change",
        granularity: "week",
        start: "2025-01-01",
        end: "2025-01-31",
      }),
    ).toHaveProperty("error");
    expect(
      parseDescriptor({
        report: "net-worth",
        metric: "change",
        granularity: "month",
        start: "2025-02-01",
        end: "2025-01-31",
      }),
    ).toHaveProperty("error");
  });

  it("emits links that parse, build and re-add, and open exactly the part they came from", async () => {
    const ctx = { book: makeBook(), db: {} as never };
    const roots: NetWorthDescriptor[] = [
      bal("2025-04-30"),
      bal("2025-02-15", { side: "assets" }),
      chg("2025-01-01", "2025-04-30"),
      chg("2025-01-01", "2025-03-31", { granularity: "quarter" }),
      chg("2025-01-01", "2025-04-30", { accountIds: ["ret"] }),
    ];
    let seen = 0;
    for (const d of roots) {
      const p = await buildProof(ctx, d);
      expect(p.selfCheck?.ok, JSON.stringify(d)).toBe(true);
      for (const l of links(p)) {
        const parsed = parseDescriptor(JSON.parse(JSON.stringify(l.descriptor)));
        expect(parsed, l.label).not.toHaveProperty("error");
        const q = await buildProof(ctx, parsed as NetWorthDescriptor);
        expect(q.selfCheck?.ok, l.label).toBe(true);
        seen++;
      }
      // Opening and closing lines open the balances they show.
      for (const b of p.blocks)
        if (b.kind === "chain")
          for (const l of b.lines.filter((x) => x.link?.descriptor.report === "net-worth"))
            expect((await buildProof(ctx, l.link!.descriptor)).figure, l.label).toEqual(l.value);
    }
    expect(seen).toBeGreaterThan(10);
  });
});

function addDay(iso: string, n: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
