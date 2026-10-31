import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Lane } from "../../classifier/taxonomy";
import { analyzeFire, firePlans, stressTest } from "../../fire/fire";
import { accessFigures, longTermCells, longTermTable, planValue, STRESS_PATHS, stressFigures, type AccessFigure, type StressFigure } from "../../fire/longTerm";
import { projectOutlook } from "../../profile/outlook";
import { MORTGAGE_FIGURES, mortgageFigures } from "../../mortgage/figures";
import { normalizeMortgageInputs, withLinks } from "../../mortgage/inputs";
import { buildMortgageLinks } from "../../mortgage/links";
import { RENT_VS_BUY_FIGURES, rentVsBuyFigures } from "../../home-budget/rentVsBuy";
import { estimateFigures, yearEstimate } from "../../profile/yearEstimate";
import { buildForecast, homeForecast, taxLink } from "../../forecast/forecast";
import { forecastInputs, loadForecastData, type ForecastData } from "../../forecast/load";
import { GOALS_KEY, type Goal } from "../../goals/settings";
import { computeLenderMax, computeMaxApproval, defaultHomeBudgetInputs } from "../../home-budget/homeBudgetModel";
import { defaultFunds, linkHome, type FundsConfig } from "../../home-budget/homeLinked";
import { NO_HOUSEHOLD } from "../../household/patterns";
import { employerKey, type StubLine } from "../../ingest/payroll/types";
import { groupFor, refreshLedgerStatus, type LedgerAccount } from "../../ledger/loadLedger";
import { buildTimeline, type SegmentInput } from "../../ledger/timeline";
import { expenseFingerprint } from "../../profile/annualMath";
import { DEFAULT_SETTINGS, PROFILE_SETTINGS_KEY, type FinancialProfileSettings } from "../../profile/settings";
import { buildTaxReport } from "../../tax/buildTaxReport";
import type { Book, BookRow, BookStatement, BookStub } from "../load";
import { buildGoals, goalForecastOf } from "../reports/goals";
import { buildHomeFunds, buildHomeSpending } from "../reports/homeFunds";
import { buildProof, parseDescriptor, type Proof, type ProofLink } from "./index";
import { chainReAdds } from "./common";
import type { PlanningDescriptor } from "./planningProof";
import type { ChainLine } from "./types";

// The forecast proof's invented household (Pat Example, Springfield Bank; every name and
// amount made up), with three invented goals and an invented home search on top.

process.env.BONUS_AWARDS_FILE = path.join(__dirname, "no-such-bonus-awards.json");

const TODAY = "2026-04-20";
const EDGE = "2026-03-31";
const EMPLOYER = "Example Partners LP";
const MONTHS = Array.from({ length: 15 }, (_, i) => {
  const y = 2025 + Math.floor(i / 12);
  const m = (i % 12) + 1;
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  return { start, end: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
});

type Flow = { date: string; cents: number; lane: Lane; payee: string; category: string };

const flows: Record<string, Flow[]> = { chk: [], card: [], brk: [], ret: [] };
const add = (account: string, date: string, cents: number, lane: Lane, payee: string, category: string) => flows[account]!.push({ date, cents, lane, payee, category });

for (const { start } of MONTHS) {
  const ym = start.slice(0, 7);
  add("chk", `${ym}-01`, -210_000, "EXPENSE", "SPRINGFIELD PROPERTY MGMT", "Rent");
  add("chk", `${ym}-10`, -61_234, "EXPENSE", "SPRINGFIELD GROCER", "Groceries");
  add("card", `${ym}-15`, -34_567, "EXPENSE", "EXAMPLE DINER", "Restaurants");
  add("card", `${ym}-25`, 34_567, "TRANSFER", "PAYMENT THANK YOU", "Transfer");
  add("chk", `${ym}-25`, -34_567, "TRANSFER", "CARD PAYMENT", "Transfer");
}
// Tax payments, one-offs and a reimbursement.
add("chk", "2025-04-15", -123_400, "EXPENSE", "IRS USATAXPYMT", "Taxes");
add("chk", "2026-01-15", -98_700, "EXPENSE", "IRS USATAXPYMT", "Taxes");
add("chk", "2025-06-12", -180_000, "EXPENSE", "SPRINGFIELD FURNITURE", "Home");
add("chk", "2026-02-10", -95_000, "EXPENSE", "EXAMPLE TRAVEL CO", "Travel");
add("chk", "2025-08-05", 15_000, "INCOME", "ZELLE FROM SAM SAMPLE", "P2P & reimbursements");

// Pay: every other Friday from Jan 3, 2025; a raise in 2026, a bonus each March, one check after the edge.
type Check = { regular: number; bonus: number; reimb: number };
const PAY: [string, Check][] = [];
for (let d = Date.UTC(2025, 0, 3); d <= Date.UTC(2026, 3, 10); d += 14 * 86_400_000) {
  const date = new Date(d).toISOString().slice(0, 10);
  const regular = date >= "2026-03-27" ? 410_000 : date >= "2026-01-01" ? 400_000 : 384_615;
  const bonus = date === "2025-03-14" ? 500_000 : date === "2026-04-10" ? 250_000 : 0;
  PAY.push([date, { regular, bonus, reimb: date === "2025-05-09" ? 7_500 : 0 }]);
}

const statements: BookStatement[] = [];
const rows: BookRow[] = [];
const stubs: BookStub[] = [];

let n = 0;
{
  const ytd = { regular: 0, bonus: 0, reimb: 0, fed: 0, k401: 0, hsa: 0, s125: 0, er: 0 };
  let year = "2025";
  for (const [payDate, c] of PAY) {
    if (payDate.slice(0, 4) !== year) {
      year = payDate.slice(0, 4);
      for (const k of Object.keys(ytd) as (keyof typeof ytd)[]) ytd[k] = 0;
    }
    const cur = { ...c, fed: Math.round((c.regular + c.bonus) * 0.18), k401: Math.round(c.regular * 0.06), hsa: 15_000, s125: 21_000, er: Math.round(c.regular * 0.04) };
    for (const k of Object.keys(ytd) as (keyof typeof ytd)[]) ytd[k] += cur[k];
    const net = cur.regular + cur.bonus + cur.reimb - cur.fed - cur.k401 - cur.hsa - cur.s125;
    const line = (name: string, kind: StubLine["kind"], k: keyof typeof ytd): StubLine => ({ name, kind, current: cur[k] || null, ytd: ytd[k] });
    let depositId: string | null = null;
    if (payDate <= EDGE) {
      depositId = `pay-${payDate}`;
      flows.chk!.push({ date: payDate, cents: net, lane: "INCOME", payee: "EXAMPLE PARTNERS LP PAYROLL", category: "Paycheck" });
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
      periodStart: new Date(Date.parse(payDate) - 18 * 86_400_000).toISOString().slice(0, 10),
      periodEnd: new Date(Date.parse(payDate) - 5 * 86_400_000).toISOString().slice(0, 10),
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
  { id: "card", name: "Pat's card ••5678", type: "CREDIT_CARD", subtype: "CREDIT_CARD", open: 0 },
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

function makeBook(): Book {
  const ledger = { accounts: ledgerAccounts, mergeDate: "2024-12-01", completeThrough: null, firstDay: null };
  refreshLedgerStatus(ledger, TODAY);
  return {
    today: TODAY,
    horizon: { cashFlow: EDGE, netWorth: EDGE },
    ledger,
    accounts: ledgerAccounts.map((a) => ({ id: a.id, name: a.name, institution: a.institution, type: a.type, subtype: a.subtype, group: a.group, identifiers: [] })),
    statements,
    rows,
    rowById: new Map(rows.map((r) => [r.id, r])),
    stubs,
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
const travel = rows.find((r) => r.payee === "EXAMPLE TRAVEL CO")!;

/** The owner's saved settings: two tagged one-offs; `outlook` patched per test. */
function settings(outlook: Partial<FinancialProfileSettings["outlook"]> = {}): FinancialProfileSettings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    birthYears: { pat: 1990 },
    oneOffs: { [expenseFingerprint(furniture)]: "New sofa", [expenseFingerprint(travel)]: "" },
    outlook: { ...structuredClone(DEFAULT_SETTINGS.outlook), ...outlook },
  };
}


/** Three invented goals: an emergency fund in cash, half the brokerage toward a down payment by 2028, and a $1M milestone. */
const GOALS: Goal[] = [
  { id: "ef", name: "Emergency fund", kind: "EMERGENCY_FUND", targetCents: null, months: 6, targetDate: null, groups: ["Cash"], accountIds: [], funding: "SET_ASIDE", shares: {} },
  { id: "down", name: "Down payment", kind: "AMOUNT", targetCents: 15_000_000, months: null, targetDate: "2028-06-30", groups: [], accountIds: ["brk", "chk"], funding: "SET_ASIDE", shares: { brk: 0.5 } },
  { id: "mil", name: "Net worth milestone", kind: "AMOUNT", targetCents: 100_000_000, months: null, targetDate: null, groups: ["Cash", "Taxable investments", "Retirement"], accountIds: [], funding: "TRACK", shares: {} },
];

const planningDb = (s: FinancialProfileSettings) =>
  ({
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === PROFILE_SETTINGS_KEY ? { value: JSON.stringify(s) } : where.key === GOALS_KEY ? { value: JSON.stringify({ version: 1, goals: GOALS }) } : null,
    },
  }) as never;

const P = (x: Record<string, unknown>) => ({ report: "planning", ...x }) as PlanningDescriptor;
const FIRE = { walkAwayYear: 2040, withdrawalRate: 0.04, stateTaxRate: 0.05, retirementAge: 55 };
const HOME_INPUTS = { ...defaultHomeBudgetInputs(), budgetHomePrice: 650_000, marketRentMonthly: 2_900 };
const HOME_FUNDS: FundsConfig = { ...defaultFunds(), buyAt: "2028-06" };

const chains = (p: Proof) => p.blocks.flatMap((b) => (b.kind === "chain" ? [b] : []));
const links = (p: Proof): (ProofLink & { value?: ChainLine["value"]; source?: ChainLine["source"] })[] =>
  p.blocks.flatMap((b) =>
    b.kind === "breakdown"
      ? b.items.flatMap((i) => (i.link ? [{ ...i.link, value: i.value }] : []))
      : b.kind === "chain"
        ? b.lines.flatMap((l) => (l.link ? [{ ...l.link, value: l.value, source: l.source }] : []))
        : [],
  );

const reAdds = chainReAdds;

const FIRE_FIGS = ["fire-number", "lean-number", "fat-number", "coast-number", "fi-year", "fi-year-base", "lean-year", "fat-year", "coast-year", "savings-rate", "years-saved", "runway", "progress"];
const GOAL_FIGS = ["current", "target", "to-go", "lands", "needed"];
const HOME_FIGS = ["cash", "salary", "income-tax", "gains-tax", "max-price", "lender-max", "lender-income"];
const strip = (d: PlanningDescriptor) => JSON.stringify(d.page === "home" ? { ...d, inputs: undefined } : d);

describe("planning proofs (FIRE, Goals, Home budget, Taxes)", () => {
  const book = makeBook();
  const ctx = () => ({ book, db: planningDb(settings()) });
  let data: ForecastData;
  let descriptors: PlanningDescriptor[] = [];
  beforeAll(async () => {
    data = await loadForecastData(ctx().db, book);
    const s = data.profile.seeds!;
    const f = buildForecast(forecastInputs(data)!, { ...data.profile.settings.outlook, ...FIRE });
    const fa = analyzeFire(firePlans(f).full, firePlans(f).base, { asOf: s.start.asOf, retirementAge: FIRE.retirementAge });
    descriptors = [
      ...FIRE_FIGS.map((figure) => P({ page: "fire", figure, fire: FIRE })),
      ...fa.milestones.filter((m) => /^(nw|fi)-/.test(m.id)).map((m) => P({ page: "fire", figure: "milestone", milestone: m.id, fire: FIRE })),
      ...GOALS.flatMap((g) => GOAL_FIGS.map((figure) => P({ page: "goals", figure, goalId: g.id }))),
      P({ page: "goals", figure: "spending" }),
      ...HOME_FIGS.flatMap((figure) => [P({ page: "home", figure, inputs: HOME_INPUTS, funds: HOME_FUNDS }), P({ page: "home", figure, inputs: HOME_INPUTS, funds: { ...HOME_FUNDS, buyAt: null } })]),
      P({ page: "taxes", figure: "bonus-expected", year: 2026, personId: "pat" }),
      P({ page: "taxes", figure: "projected-gross", year: 2026, personId: "pat" }),
    ];
  });

  it("proves every figure: the page's value, parts that re-add, chains that re-add", async () => {
    const s = data.profile.seeds!;
    const saved = data.profile.settings.outlook;
    const a = { ...saved, ...FIRE };
    const f = buildForecast(forecastInputs(data)!, a);
    const plans = firePlans(f);
    const fa = analyzeFire(plans.full, plans.base, { asOf: s.start.asOf, retirementAge: a.retirementAge });
    const shared = buildForecast(forecastInputs(data)!, saved);
    const goals = buildGoals(book, { version: 1, goals: GOALS }, goalForecastOf(shared), data.profile.settings);
    const home = (buyAt: string | null) => linkHome({ ...buildHomeFunds(book), forecast: homeForecast(shared, s), spending: buildHomeSpending(book, data.profile.settings) }, HOME_INPUTS, { ...HOME_FUNDS, buyAt }, 2026);
    const tax = buildTaxReport(book, 2026, { forecast: taxLink(shared) });
    if (tax.blocked) throw new Error("tax blocked");
    const pat = tax.people.find((p) => p.id === "pat")!;
    const page = (d: PlanningDescriptor): Proof["figure"] | undefined => {
      if (d.page === "fire")
        return (
          {
            "fire-number": { cents: fa.now.fireNumber },
            "lean-number": { cents: fa.now.leanNumber },
            "fat-number": { cents: fa.now.fatNumber },
            "coast-number": fa.now.coastNumber != null ? { cents: fa.now.coastNumber } : undefined,
            "fi-year": { text: fa.fi ? String(fa.fi.year) : "Not in 60 yrs" },
            "fi-year-base": { text: fa.fiBase ? String(fa.fiBase.year) : "Not in 60 yrs" },
            "savings-rate": fa.savingsRate != null ? { ratio: fa.savingsRate } : undefined,
            progress: { ratio: fa.now.progress },
          } as Record<string, Proof["figure"] | undefined>
        )[d.figure];
      if (d.page === "goals") {
        if (d.figure === "spending") return { cents: goals.monthlySpending!.cents };
        const g = goals.goals.find((x) => x.goal.id === d.goalId)!;
        if (d.figure === "current") return { cents: g.currentCents };
        if (d.figure === "target" && g.targetCents != null) return { cents: g.targetCents };
        if (d.figure === "needed" && g.neededMonthlyCents != null) return { cents: g.neededMonthlyCents };
        return undefined;
      }
      if (d.page === "home") {
        const L = home(d.funds?.buyAt ?? null);
        if (d.figure === "cash") return { cents: Math.round(L.ins.cashForHome * 100) };
        if (d.figure === "salary") return { cents: Math.round(L.ins.annualHouseholdSalary * 100) };
        if (d.figure === "income-tax") return { ratio: L.ins.incomeTaxRate };
        if (d.figure === "gains-tax") return { ratio: L.ins.capitalGainsTaxRate };
        if (d.figure === "max-price") return { cents: Math.round(computeMaxApproval(L.ins).impliedMaxHomeValue * 100) };
        if (d.figure === "lender-max") return { cents: Math.round(computeLenderMax(L.ins, L.lender.income).impliedMaxHomeValue * 100) };
        return { cents: Math.round(L.lender.income * 100) };
      }
      if (d.page !== "taxes") return undefined;
      if (d.figure === "bonus-expected") return { cents: pat.fromForecast!.bonus };
      return { cents: pat.payroll.find((e) => e.active)!.projected.gross };
    };
    let compared = 0;
    for (const d of descriptors) {
      const p = await buildProof(ctx(), d);
      const label = strip(d);
      expect(p.report, label).toBe("planning");
      expect(p.blocks.length, label).toBeGreaterThan(0);
      if (p.selfCheck) expect(p.selfCheck, label).toMatchObject({ ok: true, deltaCents: 0 });
      for (const c of chains(p)) expect(reAdds(c.lines), `${label} ${c.title}`).toEqual([]);
      const want = page(d);
      if (want) {
        expect(p.figure, label).toEqual(want);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(25);
  });

  it("emits links that parse, build, and open the figure the line shows", async () => {
    const c = ctx();
    let followed = 0;
    for (const d of descriptors) {
      const p = await buildProof(c, d);
      for (const l of links(p)) {
        const from = `${l.label} from ${strip(d)}`;
        const parsed = parseDescriptor(JSON.parse(JSON.stringify(l.descriptor)));
        expect(parsed, from).not.toHaveProperty("error");
        const q = await buildProof(c, parsed as never);
        if (q.selfCheck) expect(q.selfCheck.ok, from).toBe(true);
        if (l.value && "cents" in l.value && "cents" in q.figure && l.source !== "assumption" && l.descriptor.report !== "forecast") expect(q.figure.cents, from).toBe(l.value.cents);
        followed++;
      }
    }
    expect(followed).toBeGreaterThan(80);
  });

  it("links a projected line to its forecast ledger cell only when the cell opens exactly that value", async () => {
    const c = ctx();
    const seen = new Set<string>();
    let monthLinks = 0;
    let unlinked = 0;
    for (const d of descriptors) {
      const p = await buildProof(c, d);
      for (const b of p.blocks) {
        if (b.kind !== "chain") continue;
        for (const l of b.lines) {
          if (l.source === "estimate" && !l.link) unlinked++;
          if (l.link?.descriptor.report !== "forecast" || l.link.descriptor.figure !== "month") continue;
          const from = `${l.label} from ${strip(d)}`;
          expect(l.source, from).toBe("estimate");
          const parsed = parseDescriptor(JSON.parse(JSON.stringify(l.link.descriptor)));
          expect(parsed, from).toEqual(l.link.descriptor);
          const q = await buildProof(c, parsed as never);
          expect(q.withheld, from).toBe(false);
          if (q.selfCheck) expect(q.selfCheck.ok, from).toBe(true);
          expect(q.figure, from).toEqual(l.value);
          seen.add(JSON.stringify(l.link.descriptor));
          monthLinks++;
        }
      }
    }
    // Months, forecast years, and balances and flows both.
    expect(monthLinks).toBeGreaterThan(20);
    expect([...seen].some((x) => x.includes('"through"'))).toBe(true);
    expect([...seen].some((x) => x.includes('"netWorth"'))).toBe(true);
    // Some lines no cell holds (take-home, bonus kept, the no-bonus plan, liquid growth) stay unlinked estimates.
    expect(unlinked).toBeGreaterThan(0);
  });

  it("leaves lines no ledger cell holds unlinked", async () => {
    const base = await buildProof(ctx(), P({ page: "fire", figure: "fi-year-base", fire: FIRE }));
    const nw = chains(base).flatMap((b) => b.lines).filter((l) => l.label.startsWith("Net worth on Jan 1"));
    expect(nw.length).toBeGreaterThan(0);
    expect(nw.every((l) => !l.link)).toBe(true);
    const sr = await buildProof(ctx(), P({ page: "fire", figure: "savings-rate", fire: FIRE }));
    const lines = chains(sr)[0]!.lines;
    expect(lines.find((l) => l.label === "Take-home from base pay")?.link).toBeUndefined();
    expect(lines.find((l) => l.label === "Bonus kept after tax")?.link).toBeUndefined();
    expect(lines.find((l) => l.label === "Living cost")?.link?.descriptor).toMatchObject({ report: "forecast", figure: "month", line: "living", through: expect.stringMatching(/-12$/) });
  });

  it("shows projected months as estimates and typed inputs as assumptions", async () => {
    const fi = await buildProof(ctx(), P({ page: "fire", figure: "fi-year", fire: FIRE }));
    const lines = chains(fi).flatMap((b) => b.lines);
    expect(lines.find((l) => l.label.startsWith("Net worth on Jan 1"))).toMatchObject({ source: "estimate" });
    expect(lines.find((l) => l.label === "Withdrawal rate")).toMatchObject({ source: "assumption", value: { ratio: 0.04 } });
    expect(lines.find((l) => l.label === "Federal income tax")).toMatchObject({ source: "law" });
    const cash = await buildProof(ctx(), P({ page: "home", figure: "cash", inputs: HOME_INPUTS, funds: HOME_FUNDS }));
    const cl = chains(cash)[0]!.lines;
    expect(cl.find((l) => l.label.startsWith("What the forecast adds by Jun 2028"))).toMatchObject({ source: "estimate" });
    expect(cl.find((l) => l.label === "Share to put into the home")).toMatchObject({ source: "assumption", value: { ratio: 0.8 } });
    expect(cl[0]!.link?.descriptor).toMatchObject({ report: "net-worth", metric: "balance", accountIds: ["chk"] });
    const lands = await buildProof(ctx(), P({ page: "goals", figure: "lands", goalId: "down" }));
    expect(chains(lands).flatMap((b) => b.lines).some((l) => l.source === "estimate" && /money at the end of/.test(l.label) && l.link?.descriptor.report === "forecast")).toBe(true);
    const ef = await buildProof(ctx(), P({ page: "goals", figure: "target", goalId: "ef" }));
    expect(chains(ef)[0]!.lines[1]).toMatchObject({ label: "Months of spending", source: "assumption" });
  });

  it("takes FIRE's settings from the page, not only the saved ones", async () => {
    const a = await buildProof(ctx(), P({ page: "fire", figure: "fire-number", fire: FIRE }));
    const b = await buildProof(ctx(), P({ page: "fire", figure: "fire-number", fire: { ...FIRE, withdrawalRate: 0.035 } }));
    expect("cents" in a.figure && "cents" in b.figure && b.figure.cents > a.figure.cents).toBe(true);
  });

  it("proves FIRE › Plan's long-term table, its bridge tiles and the stress test as the page builds them (SSOT F4)", async () => {
    // One context, as the sweep has: the forecast and FIRE's plans are worked out once for every cell.
    const c = ctx();
    const a = { ...data.profile.settings.outlook, ...FIRE };
    const f = buildForecast(forecastInputs(data)!, a);
    const plans = firePlans(f);
    const fa = analyzeFire(plans.full, plans.base, { asOf: data.profile.seeds!.start.asOf, retirementAge: a.retirementAge });
    // As PlanTab → LongTermView builds it in the browser.
    const full = projectOutlook(plans.full);
    const base = plans.base === plans.full ? full : projectOutlook(plans.base);
    const table = longTermTable({ r: data.profile, s: data.profile.seeds!, full, base, plan: fa.plan, pay: f.pay, schedule: f.schedule });
    const cells = longTermCells(table);
    expect(cells.length).toBeGreaterThan(100);
    expect(new Set(cells.map((x) => `${x.row}@${x.col}`)).size).toBe(cells.length);
    for (const x of cells) {
      const p = await buildProof(c, P({ page: "fire", figure: "plan-cell", fire: FIRE, row: x.row, col: x.col }));
      expect(p.figure, `${x.row} @ ${x.col}`).toEqual(planValue(x.value));
    }
    const access = accessFigures(fa.plan, fa.fi?.year ?? null);
    expect(access).not.toBeNull();
    for (const [metric, v] of Object.entries(access!.figures)) {
      const p = await buildProof(c, P({ page: "fire", figure: "access", fire: FIRE, metric: metric as AccessFigure }));
      expect(p.figure, metric).toEqual(planValue(v));
    }
    const st = stressFigures(stressTest(fa.plan, { volatility: 0.15, paths: STRESS_PATHS }), fa.fi?.year ?? null);
    for (const [metric, v] of Object.entries(st)) {
      if (!planValue(v)) continue;
      const p = await buildProof(c, P({ page: "fire", figure: "stress", fire: FIRE, metric: metric as StressFigure, volatility: 0.15 }));
      expect(p.figure, metric).toEqual(planValue(v));
    }
    // A cell the table doesn't have is no figure.
    const none = await buildProof(c, P({ page: "fire", figure: "plan-cell", fire: FIRE, row: "salary", col: "1999" }));
    expect(none.withheld).toBe(true);
  });

  it("proves Mortgage and Rent vs buy as the pages work them out (SSOT F4)", async () => {
    const c = ctx();
    // Mortgage: the page's inputs (a typed return over the link), the links as api/mortgage/links has them.
    const inputs = normalizeMortgageInputs({ principal: 350_000, extraMonthly: 400, investReturn: 0.065, typed: { investReturn: true }, lumps: [{ id: "l1", label: "Example bonus", month: 3, year: 2028, amount: 10_000, repeat: true, untilYear: 2031 }], retiredField: 1 });
    expect(inputs).not.toHaveProperty("retiredField");
    const { links } = await buildMortgageLinks(c.db, book);
    const m = mortgageFigures(withLinks(inputs, links));
    for (const figure of MORTGAGE_FIGURES) {
      const v = m.values[figure];
      const want = "cents" in v ? { cents: v.cents! } : { ratio: v.ratio! };
      const p = await buildProof(c, P({ page: "mortgage", figure, inputs }));
      expect(p.figure, figure).toEqual(want);
      const linked = chains(p).flatMap((b) => b.lines).find((l) => l.label === "Investment return");
      expect(linked, figure).toMatchObject({ source: "assumption", value: { ratio: 0.065 } });
    }
    // Rent vs buy: Home budget's linked inputs, as the tab gets them.
    const shared = buildForecast(forecastInputs(data)!, data.profile.settings.outlook);
    const L = linkHome({ ...buildHomeFunds(book), forecast: homeForecast(shared, data.profile.seeds!), spending: buildHomeSpending(book, data.profile.settings) }, HOME_INPUTS, HOME_FUNDS, 2026);
    const r = rentVsBuyFigures(L.ins);
    for (const figure of RENT_VS_BUY_FIGURES) {
      const v = r.values[figure];
      const p = await buildProof(c, P({ page: "home", figure, inputs: HOME_INPUTS, funds: HOME_FUNDS }));
      expect(p.figure, figure).toEqual(typeof v === "string" ? { text: v } : { cents: Math.round(v * 100) });
    }
  });

  it("proves every line of the annual statement's whole-year estimate as the page works it out (SSOT F4)", async () => {
    const c = ctx();
    const e = yearEstimate(data);
    expect(e).not.toBeNull();
    const figs = estimateFigures(e!);
    expect(Object.keys(figs)).toEqual(expect.arrayContaining(["salary", "gross", "saved", "net-worth", "change"]));
    for (const [line, v] of Object.entries(figs)) {
      const p = await buildProof(c, P({ page: "annual-estimate", line }));
      expect(p.figure, line).toEqual(v);
    }
    expect((await buildProof(c, P({ page: "annual-estimate", line: "moon" }))).withheld).toBe(true);
  });

  it("parses descriptors and rejects bad ones", () => {
    expect(parseDescriptor({ report: "planning", page: "fire", figure: "fire-number" })).toEqual({ report: "planning", page: "fire", figure: "fire-number" });
    expect(parseDescriptor({ report: "planning", page: "fire", figure: "nope" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "planning", page: "fire", figure: "milestone", milestone: "x" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "planning", page: "goals", figure: "lands" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "planning", page: "home", figure: "cash", inputs: { cashForHome: "lots", hoaMonthly: 100, evil: 1 } })).toEqual({ report: "planning", page: "home", figure: "cash", inputs: { hoaMonthly: 100 }, funds: {} });
    expect(parseDescriptor({ report: "planning", page: "taxes", figure: "bonus-expected", year: "2026", personId: "pat" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "planning", page: "moon" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "planning", page: "fire", figure: "plan-cell", row: "salary" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "planning", page: "mortgage", figure: "advantage" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "planning", page: "annual-estimate", line: "bridge:total" })).toEqual({ report: "planning", page: "annual-estimate", line: "bridge:total" });
    expect(parseDescriptor({ report: "planning", page: "annual-estimate", line: "<script>" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "planning", page: "mortgage", figure: "nope", inputs: {} })).toHaveProperty("error");
    expect(parseDescriptor({ report: "planning", page: "fire", figure: "access", metric: "moon" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "planning", page: "fire", figure: "stress", metric: "p50" })).toHaveProperty("error");
    expect(parseDescriptor({ report: "planning", page: "fire", figure: "stress", metric: "p50", volatility: 0.15 })).toEqual({ report: "planning", page: "fire", figure: "stress", metric: "p50", volatility: 0.15 });
  });
});

describe("a goal funded from bank cash (SSOT F · J)", () => {
  it("is withheld by a finding on the cards whose balance comes off that cash, on the page and in its proof", () => {
    const book = makeBook();
    // The card owes $500 at the edge.
    const card = book.ledger.accounts.find((a) => a.id === "card")!;
    card.timeline = buildTimeline("card", [{ accountId: "card", importId: "card-owes", periodStart: "2026-03-01", periodEnd: EDGE, openingCents: 0, closingCents: -50_000, growthCents: -50_000, feesCents: 0, flows: [] }], []);
    const finding = { id: "statement.gap:card", check: "statement.gap" as const, status: "MISSING" as const, title: "Card statement missing", detail: "", fix: "", scope: { accountId: "card", from: EDGE, to: EDGE, affects: ["NET_WORTH" as const] } };
    const withFinding = { ...book, integrity: { ...book.integrity, findings: [finding] } } as Book;
    const ef = buildGoals(withFinding, { version: 1, goals: GOALS }, null, settings()).goals.find((g) => g.goal.id === "ef")!;
    expect(ef.blockerAccountIds).toContain("card");
    expect(ef.blockers.map((b) => b.id)).toEqual(["statement.gap:card"]);
  });
});
