import { describe, expect, it } from "vitest";
import type { Lane } from "../../classifier/taxonomy";
import { NO_HOUSEHOLD } from "../../household/patterns";
import { employerKey, type StubLine } from "../../ingest/payroll/types";
import { groupFor, refreshLedgerStatus, type LedgerAccount } from "../../ledger/loadLedger";
import { buildTimeline, type SegmentInput } from "../../ledger/timeline";
import { expenseFingerprint } from "../../profile/annualMath";
import { buildAnnualProfile, type AnnualProfileReport } from "../../profile/buildAnnualProfile";
import { buildAccountRollforwards, type RollforwardReport } from "../../profile/rollforwards";
import { DEFAULT_SETTINGS, PROFILE_SETTINGS_KEY, type FinancialProfileSettings } from "../../profile/settings";
import type { Book, BookBrokerage, BookRow, BookStatement, BookStub, BookTransferMatch } from "../load";
import { resolveReimbursements, rowFingerprint } from "../reimbursements";
import { buildCashFlowReport } from "../reports/cashFlow";
import type { ReimbursementLinksFile } from "../../reimbursements/store";
import { buildAnnualProof, parseAnnualDescriptor, type AnnualDescriptor } from "./annualProof";
import { buildProof, parseDescriptor, type Proof, type ProofLink } from "./index";
import { chainReAdds } from "./common";
import { annualFigures } from "./figures";
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
/** Every figure the Annual page and the roll-forwards show (figures.ts, the list the live sweep walks too). */
function wired(): Wired[] {
  return annualFigures(profile, rolls).map((f) => ({ d: f.descriptor as AnnualDescriptor, page: f.shown && "cents" in f.shown ? f.shown.cents : null }));
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

const reAdds = chainReAdds;

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

  it("counts each row where Cash flow does, so the annual statement and Cash flow agree to the cent", async () => {
    for (const d of [
      { report: "annual", figure: "cash", year: 2025, line: "living" },
      { report: "annual", figure: "category", year: 2025, category: "Housing & utilities" },
    ] as AnnualDescriptor[]) {
      const p = await buildProof(ctx, d);
      expect(chains(p)[0]!.lines.find((l) => l.label === "Counted by the day the ledger books each row"), JSON.stringify(d)).toBeUndefined();
      expect(p.selfCheck?.ok, JSON.stringify(d)).not.toBe(false);
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

  it("walks from Cash flow's saved from take-home to saved incl. retirement, to the cent", async () => {
    for (const y of profile.years.filter((v) => v.cash)) {
      const p = await buildProof(ctx, { report: "annual", figure: "cash", year: y.year, line: "saved" });
      const walk = chains(p).find((c) => c.title === "From Cash flow's saved from take-home")!;
      expect(reAdds(walk.lines), y.label).toEqual([]);
      const cf = buildCashFlowReport(book, { granularity: "year", from: `${y.year}-01-01`, to: y.asOf }).periods[0]!;
      expect(walk.lines[0]!.value, y.label).toEqual({ cents: cf.netCents });
      expect(walk.lines.at(-1)!.value, y.label).toEqual({ cents: y.cash!.waterfall.saved });
      expect(y.cash!.savedBridge.unexplained, y.label).toBe(0);
    }
    const lines = chains(await buildProof(ctx, { report: "annual", figure: "cash", year: 2025, line: "saved" })).find((c) => c.title.startsWith("From Cash flow"))!.lines;
    expect(lines.find((l) => l.label === "Pat Example: 401(k) and HSA deferrals")?.link?.descriptor).toMatchObject({ report: "pay", lines: ["deferrals"] });
    expect(lines.find((l) => l.label === "Brokerage dividends & distributions")).toMatchObject({ op: "+", value: { cents: 23_456 } });
    expect(lines.some((l) => l.label.startsWith("Net pay"))).toBe(false);
  });

  it("names pay Cash flow never sees: year-to-date only, an account with no statements", () => {
    // The year's first stub is missing (its pay lives on in the next stub's year to date), and
    // one paycheck's stub says it went to ••9999, an account with no statements.
    const first = stubs.find((s) => s.payDate.startsWith("2025"))!;
    const elsewhere = stubs.find((s) => s.payDate === "2025-06-20")!;
    const variant = { ...book, stubs: book.stubs.filter((s) => s !== first).map((s) => (s === elsewhere ? { ...s, depositTransactionId: null, deposits: [{ last4: "9999", amount: s.printed.netCurrent }] } : s)) } as Book;
    const b = buildAnnualProfile(variant, SETTINGS).years.find((y) => y.year === 2025)!.cash!.savedBridge;
    expect(b.payYtdOnly).toBe(first.printed.netCurrent);
    expect(b.payNotDeposited).toBe(elsewhere.printed.netCurrent);
    // Both deposits are still on Cash flow, now tied to no stub.
    expect(b.depositsWithoutStub).toBe(first.printed.netCurrent + elsewhere.printed.netCurrent);
    expect(b.unexplained).toBe(0);
    expect(b.saved).toBe(profile.years.find((y) => y.year === 2025)!.cash!.waterfall.saved);
  });

  it("points a calendar year's saved from take-home on Cash flow to the Annual statement", async () => {
    const year = await buildProof(ctx, { report: "cash-flow", metric: "net", granularity: "year", start: "2025-01-01", end: "2025-12-31" });
    const facts = year.blocks.find((b) => b.kind === "facts" && b.title === "On the Annual statement");
    expect(facts && facts.kind === "facts" && facts.items[0]!.link?.descriptor).toEqual({ report: "annual", figure: "cash", year: 2025, line: "saved" });
    const month = await buildProof(ctx, { report: "cash-flow", metric: "net", granularity: "month", start: "2025-01-01", end: "2025-01-31" });
    expect(month.blocks.some((b) => b.kind === "facts")).toBe(false);
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

// ---------------------------------------------------------------------------
// Reimbursement links: the May 9 stub's $75 expense reimbursement paid back $50 of the
// May 10 groceries and $25 of the May 15 diner bill; the Aug 5 Zelle paid back the Aug 15
// diner bill in part. Totals stay put; the money moves into the charges' categories.

describe("reimbursement links", () => {
  const ids: Record<string, string[]> = { chk: ["1234"], card: ["5678"], brk: ["X2468"], ret: ["R9999"] };
  const base = makeBook();
  const linkedBase = { ...base, accounts: base.accounts.map((a) => ({ ...a, identifiers: ids[a.id] ?? [] })) } as Book;
  const row = (account: string, date: string, payee: string) => rows.find((r) => r.accountId === account && r.date === date && r.payee === payee)!;
  const groceries = row("chk", "2025-05-10", "SPRINGFIELD GROCER");
  const diner = row("card", "2025-05-15", "EXAMPLE DINER");
  const augDiner = row("card", "2025-08-15", "EXAMPLE DINER");
  const junGroceries = row("chk", "2025-06-10", "SPRINGFIELD GROCER");
  const zelle = row("chk", "2025-08-05", "ZELLE FROM SAM SAMPLE");
  const fp = (r: BookRow) => rowFingerprint(r, linkedBase.accounts);
  const stubLine = { kind: "stub" as const, stub: { employerKey: employerKey(EMPLOYER), payDate: "2025-05-09", line: "Expense Reimbursement", cents: 7_500 } };
  const at = (n: number) => `2026-04-0${n}T00:00:00Z`;
  const file: ReimbursementLinksFile = {
    version: 1,
    links: [
      { id: "l1", expense: fp(groceries), source: stubLine, cents: 5_000, note: "Q2 report", linkedAt: at(1) },
      { id: "l2", expense: fp(diner), source: stubLine, cents: 2_500, note: null, linkedAt: at(2) },
      // The stub line is used up: this one waits.
      { id: "l3", expense: fp(junGroceries), source: stubLine, cents: 100, note: null, linkedAt: at(3) },
      { id: "l4", expense: fp(augDiner), source: { kind: "row", row: fp(zelle) }, cents: 10_000, note: null, linkedAt: at(4) },
      { id: "l5", expense: { ...fp(groceries), date: "2019-01-01" }, source: stubLine, cents: 1, note: null, linkedAt: at(5) },
    ],
  };
  const linked = { ...linkedBase, reimbursements: resolveReimbursements(file, linkedBase) } as Book;
  const linkedProfile = buildAnnualProfile(linked, SETTINGS);
  const y0 = profile.years.find((y) => y.year === 2025)!.cash!;
  const y1 = linkedProfile.years.find((y) => y.year === 2025)!.cash!;
  const cat = (c: typeof y0, name: string) => c.spending.find((s) => s.category === name)?.cents ?? 0;

  it("applies links that fit and says why the others wait", () => {
    const st = linked.reimbursements!;
    expect(st.links.map((l) => [l.id, l.status])).toEqual([
      ["l1", "APPLIED"],
      ["l2", "APPLIED"],
      ["l3", "WAITING"],
      ["l4", "APPLIED"],
      ["l5", "WAITING"],
    ]);
    expect(st.links.find((l) => l.id === "l3")!.reason).toMatch(/payback is \$75\.00 and other links already use \$75\.00/);
    expect(st.links.find((l) => l.id === "l5")!.reason).toMatch(/isn't on any statement/);
    expect(st.rows).toHaveLength(6);
    expect(st.rows.reduce((t, r) => t + r.amountCents, 0)).toBe(0);
  });

  it("moves the money into the charges' categories and leaves living cost alone", () => {
    expect(y1.waterfall.living).toBe(y0.waterfall.living);
    expect(y1.waterfall.saved).toBe(y0.waterfall.saved);
    expect(cat(y1, "Groceries")).toBe(cat(y0, "Groceries") - 5_000);
    expect(cat(y1, "Restaurants")).toBe(cat(y0, "Restaurants") - 12_500);
    expect(y1.payLinked).toBe(7_500);
    expect(y1.reimbursements).toBe(y0.reimbursements - 17_500);
  });

  it("keeps cash flow's net month by month, with the credit in the charge's category", () => {
    const before = buildCashFlowReport(base, { granularity: "month" }).periods;
    const after = buildCashFlowReport(linked, { granularity: "month" }).periods;
    expect(after.map((p) => p.netCents)).toEqual(before.map((p) => p.netCents));
    const may0 = before.find((p) => p.start === "2025-05-01")!;
    const may1 = after.find((p) => p.start === "2025-05-01")!;
    expect(may1.spendingCents).toBe(may0.spendingCents - 7_500);
    expect(may1.incomeByCategory.find((c) => c.category === "Paycheck")!.cents).toBe(may0.incomeByCategory.find((c) => c.category === "Paycheck")!.cents - 7_500);
  });

  it("proves the year's cash lines and categories with the links applied", async () => {
    const ctx2 = { book: linked, db: fakeDb };
    // The year's cash lines and categories, as the page lists them (figures.ts).
    const ds = annualFigures(linkedProfile, { accounts: [], years: [] } as unknown as RollforwardReport).flatMap((f): [AnnualDescriptor, number][] => {
      const d = f.descriptor as AnnualDescriptor;
      return (d.figure === "cash" || d.figure === "category") && d.year === 2025 && f.shown && "cents" in f.shown ? [[d, f.shown.cents]] : [];
    });
    expect(ds.length).toBeGreaterThan(y1.spending.length);
    for (const [d, page] of ds) {
      const p = await buildProof(ctx2, d);
      const what = JSON.stringify(d);
      expect(p.figure, what).toEqual({ cents: page });
      expect(p.selfCheck?.ok, `${what}: ${p.selfCheck?.explain}`).toBe(true);
      for (const c of chains(p)) expect(reAdds(c.lines), `${what} · ${c.title}`).toEqual([]);
    }
    const reimb = await buildProof(ctx2, { report: "annual", figure: "cash", year: 2025, line: "reimbursements" });
    expect(chains(reimb)[0]!.lines.find((l) => l.label === "Linked to the charges they paid back")).toMatchObject({ op: "−", value: { cents: 7_500 } });
  });
});
