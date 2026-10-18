import { describe, expect, it } from "vitest";
import type { Lane } from "../../classifier/taxonomy";
import { NO_HOUSEHOLD } from "../../household/patterns";
import { employerKey, type StubLine } from "../../ingest/payroll/types";
import { groupFor, refreshLedgerStatus, type LedgerAccount } from "../../ledger/loadLedger";
import { buildTimeline, type SegmentInput } from "../../ledger/timeline";
import { expenseFingerprint } from "../../profile/annualMath";
import { buildAnnualProfile, type AnnualProfileReport, type YearProfile } from "../../profile/buildAnnualProfile";
import { rollTotalValue, rollValue } from "../../profile/rollLines";
import { buildAccountRollforwards } from "../../profile/rollforwards";
import { BUCKETS, DEFAULT_SETTINGS, PROFILE_SETTINGS_KEY, type FinancialProfileSettings } from "../../profile/settings";
import type { Book, BookBrokerage, BookRow, BookStatement, BookStub, BookTransferMatch } from "../load";
import { buildAnnualProof, parseAnnualDescriptor, type AnnualCashLine, type AnnualDescriptor } from "./annualProof";
import { buildProof, parseDescriptor, type Proof, type ProofLink } from "./index";
import type { ChainLine } from "./types";

// An invented household: Pat Example, paid every other Friday by Example Partners LP into
// checking ••1234 at Springfield Bank, with a card ••5678, a brokerage ••2468 and a 401(k),
// Dec 2024 – Mar 2026. Rent is paid on the 28th for the next month, and goes up with the
// payment for January 2026, so Cash flow (rent in the month it pays for) and the annual
// statement (each row on the day it's booked) differ by the raise in 2025. A transfer to the
// brokerage leaves on Dec 31, 2025 and lands Jan 2. Every name and amount is made up.

const TODAY = "2026-04-20";
const EDGE = "2026-03-31";
const EMPLOYER = "Example Partners LP";
const MONTHS = Array.from({ length: 16 }, (_, i) => {
  const y = 2024 + Math.floor((i + 11) / 12);
  const m = ((i + 11) % 12) + 1;
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  return { start, end: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
});

type Flow = { date: string; cents: number; lane: Lane; payee: string; category: string };
const flows: Record<string, Flow[]> = { chk: [], card: [], brk: [], ret: [] };
const add = (account: string, date: string, cents: number, lane: Lane, payee: string, category: string) => flows[account]!.push({ date, cents, lane, payee, category });

for (const { start } of MONTHS) {
  const ym = start.slice(0, 7);
  add("chk", `${ym}-28`, ym >= "2025-12" ? -220_000 : -210_000, "EXPENSE", "SPRINGFIELD PROPERTY MGMT", "Housing & utilities");
  add("chk", `${ym}-10`, -61_234, "EXPENSE", "SPRINGFIELD GROCER", "Groceries");
  add("chk", `${ym}-27`, 1_234, "INCOME", "SPRINGFIELD BANK INTEREST", "Interest");
  add("card", `${ym}-15`, -34_567, "EXPENSE", "EXAMPLE DINER", "Restaurants");
  add("card", `${ym}-25`, 34_567, "TRANSFER", "PAYMENT THANK YOU", "Transfer");
  add("chk", `${ym}-25`, -34_567, "TRANSFER", "CARD PAYMENT", "Transfer");
}
add("chk", "2025-04-15", -123_400, "EXPENSE", "IRS USATAXPYMT", "Taxes");
add("chk", "2025-05-20", 45_600, "INCOME", "IRS TREAS 310 TAX REF", "Other income");
add("chk", "2026-01-15", -98_700, "EXPENSE", "IRS USATAXPYMT", "Taxes");
add("chk", "2025-06-12", -180_000, "EXPENSE", "SPRINGFIELD FURNITURE", "Home");
add("chk", "2026-02-10", -95_000, "EXPENSE", "EXAMPLE TRAVEL CO", "Travel");
add("chk", "2025-08-05", 15_000, "INCOME", "ZELLE FROM SAM SAMPLE", "P2P & reimbursements");
add("chk", "2025-09-09", 32_100, "INCOME", "EXAMPLE MARKETPLACE PAYOUT", "Other income");
add("chk", "2025-07-01", 50_000, "EXTERNAL_TRANSFER", "FROM SAM SAMPLE (UNTRACKED)", "Partner accounts (untracked)");
// In flight over the year end.
add("chk", "2025-12-31", -100_000, "TRANSFER", "TO BROKERAGE ••2468", "Transfer");
add("brk", "2026-01-02", 100_000, "TRANSFER", "FROM CHECKING ••1234", "Transfer");

// Pay: every other Friday from Jan 3, 2025; a bonus each March; one check after the edge.
const statements: BookStatement[] = [];
const rows: BookRow[] = [];
const stubs: BookStub[] = [];
let n = 0;
{
  const ytd = { regular: 0, bonus: 0, reimb: 0, fed: 0, k401: 0, hsa: 0, s125: 0, er: 0 };
  let year = "2025";
  for (let d = Date.UTC(2025, 0, 3); d <= Date.UTC(2026, 3, 10); d += 14 * 86_400_000) {
    const payDate = new Date(d).toISOString().slice(0, 10);
    if (payDate.slice(0, 4) !== year) {
      year = payDate.slice(0, 4);
      for (const k of Object.keys(ytd) as (keyof typeof ytd)[]) ytd[k] = 0;
    }
    const regular = payDate >= "2026-01-01" ? 400_000 : 384_615;
    const c = { regular, bonus: payDate === "2025-03-14" ? 500_000 : 0, reimb: payDate === "2025-05-09" ? 7_500 : 0 };
    const cur = { ...c, fed: Math.round((c.regular + c.bonus) * 0.18), k401: Math.round(c.regular * 0.06), hsa: 15_000, s125: 21_000, er: Math.round(c.regular * 0.04) };
    for (const k of Object.keys(ytd) as (keyof typeof ytd)[]) ytd[k] += cur[k];
    const net = cur.regular + cur.bonus + cur.reimb - cur.fed - cur.k401 - cur.hsa - cur.s125;
    const line = (name: string, kind: StubLine["kind"], k: keyof typeof ytd): StubLine => ({ name, kind, current: cur[k] || null, ytd: ytd[k] });
    let depositId: string | null = null;
    if (payDate <= EDGE) {
      depositId = `pay-${payDate}`;
      add("chk", payDate, net, "INCOME", "EXAMPLE PARTNERS LP PAYROLL", "Paycheck");
      add("ret", payDate, cur.k401, "CONTRIBUTION_EMPLOYEE", "EMPLOYEE DEFERRAL", "Retirement");
      add("ret", payDate, cur.er, "CONTRIBUTION_EMPLOYER", "EMPLOYER MATCH", "Retirement");
    }
    stubs.push({
      id: `s${++n}`,
      documentId: `d${n}`,
      documentTitle: `stub ${payDate}.pdf`,
      importedAt: "2026-04-15T00:00:00Z",
      source: "TRINET",
      employee: "PAT EXAMPLE",
      employer: EMPLOYER,
      employerKey: employerKey(EMPLOYER),
      personId: "pat",
      payDate,
      periodStart: new Date(d - 18 * 86_400_000).toISOString().slice(0, 10),
      periodEnd: new Date(d - 5 * 86_400_000).toISOString().slice(0, 10),
      federalFilingStatus: null,
      lines: [
        line("Regular Salary", "REGULAR", "regular"),
        line("Annual Bonus", "BONUS", "bonus"),
        line("Expense Reimbursement", "NONTAXABLE", "reimb"),
        line("Federal Income Tax", "FEDERAL_TAX", "fed"),
        line("401(k)", "RETIREMENT_PRETAX", "k401"),
        line("HSA", "HSA", "hsa"),
        line("Medical", "SECTION125", "s125"),
        line("401(k) Match", "EMPLOYER_RETIREMENT", "er"),
      ],
      printed: { grossCurrent: null, grossYtd: null, withheldCurrent: null, withheldYtd: null, netCurrent: net, netYtd: null },
      deposits: [{ last4: "1234", amount: net }],
      warnings: [],
      depositTransactionId: depositId,
    });
  }
}

const ACCOUNTS = [
  { id: "chk", name: "Pat's checking ••1234", type: "CHECKING", subtype: "CHECKING", open: 1_500_000 },
  { id: "card", name: "Pat's card ••5678", type: "CREDIT_CARD", subtype: "CREDIT_CARD", open: -12_000 },
  { id: "brk", name: "Example brokerage ••2468", type: "INVESTMENT", subtype: "BROKERAGE", open: 5_000_000 },
  { id: "ret", name: "Example 401(k)", type: "INVESTMENT", subtype: "401K", open: 3_000_000 },
];

const ledgerAccounts: LedgerAccount[] = ACCOUNTS.map((a) => {
  const segs: SegmentInput[] = [];
  let bal = a.open;
  for (const m of MONTHS) {
    const id = `st-${a.id}-${m.start}`;
    const mine = flows[a.id]!.filter((f) => f.date >= m.start && f.date <= m.end);
    const growth = a.type === "INVESTMENT" ? Math.round(bal * 0.005) : 0;
    const open = bal;
    bal += mine.reduce((t, f) => t + f.cents, 0) + growth;
    statements.push({ id, accountId: a.id, documentId: `doc-${id}`, documentTitle: `${a.id}-${m.start}.pdf`, importedAt: "2026-04-15T00:00:00.000Z", status: "COMMITTED", isSummary: false, periodStart: m.start, periodEnd: m.end, deltaCents: 0 });
    segs.push({
      accountId: a.id,
      importId: id,
      periodStart: m.start,
      periodEnd: m.end,
      openingCents: open,
      closingCents: bal,
      growthCents: growth,
      feesCents: 0,
      flows: mine.map((f, i) => {
        const rowId = f.category === "Paycheck" ? `pay-${f.date}` : `r-${a.id}-${f.date}-${i}`;
        rows.push({
          id: rowId,
          date: f.date,
          precision: "EXACT",
          statement: { start: m.start, end: m.end },
          bookedOn: f.date,
          amountCents: f.cents,
          lane: f.lane,
          accountId: a.id,
          payee: f.payee,
          merchantKey: null,
          category: f.category,
          categoryGroup: null,
          counterpartyKind: null,
          counterpartyInstitution: null,
          counterpartyAccountHint: null,
          classifiedBy: null,
          transferMatchId: null,
          statementImportId: id,
          documentId: `doc-${id}`,
        });
        return { id: rowId, date: f.date, precision: "EXACT" as const, amountCents: f.cents, lane: f.lane };
      }),
    });
  }
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    institution: "Springfield Bank",
    subtype: a.subtype as LedgerAccount["subtype"],
    group: groupFor(a.subtype, a.type),
    isInvestment: a.type === "INVESTMENT",
    timeline: buildTimeline(a.id, segs, []),
    statementCount: segs.length,
    closed: false,
  };
});

const legOf = (accountId: string, date: string) => {
  const r = rows.find((x) => x.accountId === accountId && x.date === date && x.lane === "TRANSFER")!;
  return { transactionId: r.id, accountId, date, amountCents: r.amountCents };
};
const matches: BookTransferMatch[] = [{ id: "m-1", status: "CONFIRMED", differenceCents: 0, legs: [legOf("chk", "2025-12-31"), legOf("brk", "2026-01-02")] }];

const brokerage: BookBrokerage[] = [
  {
    id: "bf-1",
    documentId: "doc-st-brk-2025-12-01",
    institution: "Springfield Bank",
    accountNumber: "X2468",
    ownerLine: "PAT EXAMPLE",
    kind: "TAXABLE",
    periodStart: "2025-12-01",
    periodEnd: "2025-12-31",
    isYearEnd: true,
    endingValue: null,
    income: { dividends: 23_456, interest: 0, capGainDistShort: 0, capGainDistLong: 0, taxExempt: 0, taxDeferred: 0 },
    realized: null,
    incomeRows: [],
    distributions: [],
    contributionsYtd: null,
    isChet: false,
  },
];

function makeBook(): Book {
  const ledger = { accounts: ledgerAccounts, mergeDate: "2024-12-01", completeThrough: null, firstDay: null };
  refreshLedgerStatus(ledger, TODAY);
  return {
    today: TODAY,
    horizon: { cashFlow: EDGE, netWorth: EDGE },
    ledger,
    accounts: ledgerAccounts.map((a) => ({ id: a.id, name: a.name, institution: a.institution, type: a.type, subtype: a.subtype, group: a.group, identifiers: a.id === "brk" ? ["X2468"] : [] })),
    statements,
    rows,
    rowById: new Map(rows.map((r) => [r.id, r])),
    stubs,
    brokerage,
    holdings: [],
    matches,
    documents: [],
    decisions: { version: 1, confirmed: [], rejected: [] },
    classifiedWith: null,
    household: NO_HOUSEHOLD,
    classifiedWithHousehold: null,
    taxProfile: {
      version: 1,
      persons: [{ id: "pat", name: "Pat Example", match: ["PAT EXAMPLE"] }],
      dependents: [],
      accountOwners: {},
      accountKinds: {},
      qualifiedDividendShare: 1,
      moneyMarketUsGovShare: 0,
      mfsDependentClaimant: "AUTO",
      years: {},
    },
    taxDocs: null,
    persons: [{ id: "pat", name: "Pat Example", match: ["PAT EXAMPLE"] }],
    idle: { proven: [], unproven: [] },
    integrity: { checks: [], findings: [], inferences: [], accepted: [], stale: [], retired: [] },
    passes: [],
  } as unknown as Book;
}

const furniture = rows.find((r) => r.payee === "SPRINGFIELD FURNITURE")!;
const SETTINGS: FinancialProfileSettings = { ...structuredClone(DEFAULT_SETTINGS), birthYears: { pat: 1990 }, oneOffs: { [expenseFingerprint(furniture)]: "New sofa" }, nonRecurringCategories: ["Travel"] };
const fakeDb = { appSetting: { findUnique: async ({ where }: { where: { key: string } }) => (where.key === PROFILE_SETTINGS_KEY ? { value: JSON.stringify(SETTINGS) } : null) } } as never;

const book = makeBook();
const profile: AnnualProfileReport = buildAnnualProfile(book, SETTINGS);
const rolls = buildAccountRollforwards(book);
const ctx = { book, db: fakeDb };

// ---------------------------------------------------------------------------
// Every figure the two pages make clickable, with the value the page computes for it.

type Wired = { d: AnnualDescriptor; page: number | null };
const CASH: [AnnualCashLine, (y: YearProfile) => number | null][] = [
  ["other-income", (y) => y.cash!.waterfall.otherIncome],
  ["gross", (y) => y.cash!.waterfall.grossCash],
  ["withholding", (y) => y.cash!.waterfall.withholding],
  ["taxes-paid", (y) => y.cash!.waterfall.additionalTaxes],
  ["refunds", (y) => y.cash!.waterfall.refunds],
  ["deductions", (y) => y.cash!.waterfall.otherDeductions],
  ["employer", (y) => y.cash!.waterfall.employer],
  ["net-cash", (y) => y.cash!.waterfall.netCash],
  ["living", (y) => y.cash!.waterfall.living],
  ["one-offs", (y) => y.cash!.waterfall.nonRecurring],
  ["saved", (y) => y.cash!.waterfall.saved],
  ["reimbursements", (y) => y.cash!.reimbursements],
  ["tax-rate", () => null],
  ["savings-of-gross", () => null],
  ["savings-of-net", () => null],
];

function wired(): Wired[] {
  const out: Wired[] = [];
  for (const y of profile.years) {
    const year = y.year;
    if (y.cash) {
      for (const [line, f] of CASH) out.push({ d: { report: "annual", figure: "cash", year, line }, page: f(y) });
      for (const s of y.cash.spending) out.push({ d: { report: "annual", figure: "category", year, category: s.category }, page: s.cents });
    }
    const n = y.netWorth;
    if (n) {
      for (const b of BUCKETS) if (n.buckets[b.id] !== 0) out.push({ d: { report: "annual", figure: "bucket", year, bucket: b.id }, page: b.debt ? -n.buckets[b.id] : n.buckets[b.id] });
      out.push({ d: { report: "annual", figure: "net-worth", year, line: "net-worth" }, page: n.netWorth });
      out.push({ d: { report: "annual", figure: "net-worth", year, line: "assets" }, page: n.grossAssets });
      out.push({ d: { report: "annual", figure: "net-worth", year, line: "debt" }, page: -n.grossDebt });
      out.push({ d: { report: "annual", figure: "net-worth", year, line: "liquid" }, page: n.liquid });
      out.push({ d: { report: "annual", figure: "net-worth", year, line: "illiquid" }, page: n.illiquid });
      out.push({ d: { report: "annual", figure: "net-worth", year, line: "in-transit" }, page: n.inTransit });
    }
    if (y.change) {
      out.push({ d: { report: "annual", figure: "net-worth", year, line: "change" }, page: y.change.cents });
      out.push({ d: { report: "annual", figure: "net-worth", year, line: "change-pct" }, page: null });
    }
    if (y.bridge) for (const line of ["cashSaved", "investmentGrowth", "outsideMoney", "newlyTracked", "inTransit", "unexplainedSavings", "total"] as const) out.push({ d: { report: "annual", figure: "bridge", year, line }, page: y.bridge[line] });
  }
  for (const a of rolls.accounts)
    for (const x of a.years) {
      for (const line of ["opening", "employee", "employer", "deposits", "withdrawals", "after-contributions", "income", "market", "fees", "closing"] as const)
        out.push({ d: { report: "annual", figure: "rollforward", year: x.year, accountId: a.id, line }, page: rollValue(x, line) });
      out.push({ d: { report: "annual", figure: "rollforward", year: x.year, accountId: a.id, line: "return" }, page: null });
    }
  for (const year of rolls.years)
    for (const line of ["closing", "contributions", "growth"] as const) {
      const xs = rolls.accounts.flatMap((a) => a.years.filter((x) => x.year === year));
      if (xs.length) out.push({ d: { report: "annual", figure: "rollforward-total", year, line }, page: xs.reduce((s, x) => s + rollTotalValue(x, line), 0) });
    }
  return out;
}

const chains = (p: Proof) => p.blocks.flatMap((b) => (b.kind === "chain" ? [b] : []));
const links = (p: Proof): (ProofLink & { value?: ChainLine["value"] })[] =>
  p.blocks.flatMap((b) =>
    b.kind === "breakdown"
      ? b.items.flatMap((i) => (i.link ? [{ ...i.link, value: i.value }] : []))
      : b.kind === "chain"
        ? b.lines.flatMap((l) => (l.link ? [{ ...l.link, value: l.value }] : []))
        : [],
  );

/** Every money step of a chain (lines up to each "=") re-adds to the "=" line. */
function reAdds(lines: ChainLine[]): string[] {
  const bad: string[] = [];
  let acc: number | null = null;
  let additive = true;
  for (const l of lines) {
    const cents = "cents" in l.value ? l.value.cents : null;
    if (l.op === "=") {
      if (additive && acc != null && cents != null && acc !== cents) bad.push(`${l.label}: parts ${acc} ≠ ${cents}`);
      acc = cents;
      additive = true;
    } else if (l.op === "×" || l.op === "÷" || cents == null) additive = false;
    else if (l.op === "−") acc = (acc ?? 0) - cents;
    else if (l.op === "+" || acc == null) acc = (acc ?? 0) + cents;
    else additive = false;
  }
  return bad;
}

describe("annual statement proofs", () => {
  it("has proven years with a bridge on the invented household", () => {
    expect(profile.years.map((y) => y.year)).toEqual([2024, 2025, 2026]);
    const y = profile.years[1]!;
    expect(y.cash && y.netWorth && y.bridge).toBeTruthy();
    expect(y.netWorth!.inTransit).toBe(100_000);
  });

  it("proves every wired figure: same value as the page, parts that re-add, chains that re-add", async () => {
    const all = wired();
    expect(all.length).toBeGreaterThan(150);
    for (const { d, page } of all) {
      const p = await buildProof(ctx, d);
      const what = JSON.stringify(d);
      expect(p.withheld, what).toBe(false);
      if (page != null) expect(p.figure, what).toEqual({ cents: page });
      expect(p.selfCheck?.ok, `${what}: ${p.selfCheck?.explain}`).toBe(true);
      for (const c of chains(p)) expect(reAdds(c.lines), `${what} · ${c.title}`).toEqual([]);
    }
  });

  it("ratios re-divide to what the page shows", async () => {
    const y = profile.years[1]!;
    const p = await buildProof(ctx, { report: "annual", figure: "cash", year: 2025, line: "tax-rate" });
    expect(p.figure).toEqual({ ratio: y.cash!.waterfall.cashTaxRate });
    const r = await buildProof(ctx, { report: "annual", figure: "rollforward", year: 2025, accountId: "ret", line: "return" });
    expect(r.figure).toEqual({ ratio: rolls.accounts.find((a) => a.id === "ret")!.years.find((x) => x.year === 2025)!.returnRatio });
  });

  it("emits links that parse and build, and a link's value is its proof's figure where they're the same figure", async () => {
    const seen = new Set<string>();
    let followed = 0;
    for (const { d } of wired()) {
      for (const l of links(await buildProof(ctx, d))) {
        const key = JSON.stringify(l.descriptor);
        if (seen.has(key)) continue;
        seen.add(key);
        const parsed = parseDescriptor(JSON.parse(key));
        expect(parsed, l.label).not.toHaveProperty("error");
        const q = await buildProof(ctx, parsed as AnnualDescriptor);
        expect(q.figure, `${l.label} → ${key}`).not.toEqual({ text: "—" });
        followed++;
      }
    }
    expect(followed).toBeGreaterThan(40);
  });

  it("links pay lines straight to the pay stubs, spending and income to Cash flow, balances to Net worth", async () => {
    const gross = await buildProof(ctx, { report: "annual", figure: "cash", year: 2025, line: "gross" });
    const salary = links(gross).find((l) => l.descriptor.report === "pay")!;
    expect(salary.descriptor).toEqual({ report: "pay", basis: "ytd", personId: "pat", year: 2025, through: "2025-12-31", lines: ["base"] });
    expect((await buildProof(ctx, salary.descriptor)).figure).toEqual(salary.value);
    const living = await buildProof(ctx, { report: "annual", figure: "cash", year: 2025, line: "living" });
    const spending = links(living).find((l) => l.descriptor.report === "cash-flow")!;
    expect((await buildProof(ctx, spending.descriptor)).figure).toEqual(spending.value);
    const nw = await buildProof(ctx, { report: "annual", figure: "net-worth", year: 2025, line: "net-worth" });
    const bal = links(nw).find((l) => l.descriptor.report === "net-worth")!;
    expect((await buildProof(ctx, bal.descriptor)).figure).toEqual(bal.value);
  });

  it("shows the rent raise as the labelled difference between Cash flow and the annual statement", async () => {
    for (const d of [
      { report: "annual", figure: "cash", year: 2025, line: "living" },
      { report: "annual", figure: "category", year: 2025, category: "Housing & utilities" },
    ] as AnnualDescriptor[]) {
      const p = await buildProof(ctx, d);
      const diff = chains(p)[0]!.lines.find((l) => l.label === "Counted by the day the ledger books each row");
      expect(diff, JSON.stringify(d)).toMatchObject({ op: "+", value: { cents: 10_000 } });
    }
  });

  it("keeps tax payments, refunds, one-offs and dividends on their own lines", async () => {
    const other = await buildProof(ctx, { report: "annual", figure: "cash", year: 2025, line: "other-income" });
    const lines = chains(other)[0]!.lines;
    expect(lines.find((l) => l.label === "Other income: tax-authority rows")).toMatchObject({ op: "−", value: { cents: 45_600 } });
    expect(lines.find((l) => l.label.endsWith("dividends & distributions"))).toMatchObject({ value: { cents: 23_456 } });
    const refunds = await buildProof(ctx, { report: "annual", figure: "cash", year: 2025, line: "refunds" });
    expect(refunds.figure).toEqual({ cents: 45_600 });
    expect(refunds.blocks.find((b) => b.kind === "rows")).toBeTruthy();
    const oneOffs = await buildProof(ctx, { report: "annual", figure: "cash", year: 2026, line: "one-offs" });
    expect(chains(oneOffs)[0]!.lines.map((l) => l.label)).toContain("Travel (1 row)");
    const transit = await buildProof(ctx, { report: "annual", figure: "bridge", year: 2026, line: "inTransit" });
    expect(chains(transit)[0]!.lines.some((l) => l.label.startsWith("Matched transfers in flight, 2025-12-31") && l.op === "−")).toBe(true);
  });

  it("withholds a figure whose section is withheld, and says what's missing", () => {
    const p = buildAnnualProof(book, profile, { report: "annual", figure: "net-worth", year: 2024, line: "change" });
    expect(p.withheld).toBe(true);
    expect(buildAnnualProof(book, profile, { report: "annual", figure: "cash", year: 2019, line: "gross" }).withheld).toBe(true);
  });

  it("parses descriptors and rejects bad ones", () => {
    expect(parseAnnualDescriptor({ report: "annual", figure: "cash", year: 2025, line: "saved" })).toEqual({ report: "annual", figure: "cash", year: 2025, line: "saved" });
    expect(parseAnnualDescriptor({ report: "annual", figure: "cash", year: 2025, line: "horoscope" })).toHaveProperty("error");
    expect(parseAnnualDescriptor({ report: "annual", figure: "bucket", year: 2025, bucket: "GOLD" })).toHaveProperty("error");
    expect(parseAnnualDescriptor({ report: "annual", figure: "rollforward", year: 2025, line: "closing" })).toHaveProperty("error");
    expect(parseAnnualDescriptor({ report: "annual", figure: "nope", year: 2025 })).toHaveProperty("error");
    expect(parseAnnualDescriptor({ report: "annual", figure: "cash", line: "saved" })).toHaveProperty("error");
  });
});
