import { addDays, endOfMonth, ymd } from "../dates/isoDate.ts";
import type { StubLine, StubLineKind } from "../ingest/payroll/types.ts";
import type { Holding } from "../ingest/holdings/types.ts";
import type { BrokerageFacts, HoldingsFacts, ParsedAccountSection, ParsedDocument, ParsedTransaction, PayStubFacts } from "../ingest/types.ts";
import type { AwardsFile } from "../bonuses/awardStore.ts";
import type { BudgetSettings } from "../budget/settings.ts";
import { normalizeGarage, type GarageSettings } from "../car/settings.ts";
import type { GoalSettings } from "../goals/settings.ts";
import type { HsaExpense, HsaFile } from "../hsa/store.ts";
import type { TaxProfile } from "../tax/profile.ts";

/**
 * The demo household: made up from scratch, never from the owner's ledger. One simulation
 * runs day by day (paychecks, card spending, rent, sweeps into the brokerage account,
 * market moves) and every document is written from it, so the statements chain, pay
 * stubs prove themselves and tie to the deposits, transfers have both legs and every
 * month's net worth reconciles, exactly as real statements must.
 *
 * Two earners (about $2M a year with bonuses), a joint Chase checking account and card,
 * an Amex card and high-yield savings, a Fidelity brokerage account, a Roth IRA and two
 * 401(k)s: about $6.4M at the start of 2025, about $10M by mid-2026. Seeded, so the same
 * options always give the same data.
 */

export type DemoOptions = {
  /** First month, YYYY-MM (default 2025-01). */
  from?: string;
  /** Last month, YYYY-MM (default 2026-06). */
  through?: string;
  seed?: number;
};

export type DemoData = {
  documents: ParsedDocument[];
  taxProfile: TaxProfile;
  /** Bonus award letters (Bonuses page). */
  awards: AwardsFile;
  /** Monthly spending targets (Cash flow › Budget). */
  budget: BudgetSettings;
  /** Savings goals (Goals page). */
  goals: GoalSettings;
  /** The garage (Car page). */
  car: GarageSettings;
  /** Medical bills paid out of pocket and kept for the HSA (HSA page). */
  hsa: HsaFile;
  /** Closing balance of every account in the last month, cents. */
  closing: Record<string, number>;
};

export const DEMO_PARSER_ID = "demo";

// ---------------------------------------------------------------------------
// The household
// ---------------------------------------------------------------------------

const ALEX = { id: "alex", name: "Alex", printed: "ALEX RIVERA" };
const JORDAN = { id: "jordan", name: "Jordan", printed: "JORDAN RIVERA" };

type AccountDef = Pick<ParsedAccountSection, "institution" | "accountNumber" | "accountName" | "kind" | "subtype"> & { title: string; opening: number };

const ACCOUNTS = {
  checking: { institution: "Chase", accountNumber: "4417", accountName: "CHASE TOTAL CHECKING", kind: "CHECKING", subtype: "CHECKING", title: "Chase checking statement", opening: 8_150_000 },
  sapphire: { institution: "Chase", accountNumber: "8812", accountName: "CHASE SAPPHIRE RESERVE", kind: "CREDIT_CARD", subtype: "CREDIT_CARD", title: "Chase Sapphire statement", opening: -1_184_233 },
  platinum: { institution: "American Express", accountNumber: "21009", accountName: "AMERICAN EXPRESS PLATINUM CARD", kind: "CREDIT_CARD", subtype: "CREDIT_CARD", title: "Amex Platinum statement", opening: -1_862_410 },
  savings: { institution: "American Express", accountNumber: "6603", accountName: "AMERICAN EXPRESS HIGH YIELD SAVINGS", kind: "SAVINGS", subtype: "SAVINGS", title: "Amex savings statement", opening: 30_000_000 },
  brokerage: { institution: "Fidelity", accountNumber: "Z23-889104", accountName: "FIDELITY JOINT BROKERAGE", kind: "INVESTMENT", subtype: "BROKERAGE", title: "Fidelity brokerage statement", opening: 400_000_000 },
  roth: { institution: "Fidelity", accountNumber: "238-441902", accountName: "FIDELITY ROTH IRA", kind: "INVESTMENT", subtype: "ROTH_IRA", title: "Fidelity Roth IRA statement", opening: 38_000_000 },
  alex401k: { institution: "Fidelity", accountNumber: "71042", accountName: "HARBORVIEW CAPITAL 401(K) PLAN", kind: "INVESTMENT", subtype: "401K", title: "Harborview Capital 401(k) statement", opening: 115_000_000 },
  jordan401k: { institution: "Fidelity", accountNumber: "71388", accountName: "MERIDIAN HEALTH 401(K) PLAN", kind: "INVESTMENT", subtype: "401K", title: "Meridian Health 401(k) statement", opening: 56_000_000 },
} satisfies Record<string, AccountDef>;
type AccountKey = keyof typeof ACCOUNTS;

type Earner = {
  person: typeof ALEX;
  employer: string;
  /** How the bank prints the payroll deposit. */
  deposit: string;
  plan: AccountKey;
  /** Annual base salary, cents. */
  salary: Record<number, number>;
  /** Annual bonus: pay date and amount. */
  bonus: Record<number, { date: string; amount: number }>;
  /** Pre-tax health premium per paycheck. */
  health: number;
  /** Employer 401(k) match as a share of the deferral. */
  match: number;
};

const EARNERS: Earner[] = [
  {
    person: ALEX,
    employer: "Harborview Capital Partners LP",
    deposit: "HARBORVIEW CAPIT PAYROLL",
    plan: "alex401k",
    salary: { 2025: 42_500_000, 2026: 45_000_000 },
    bonus: { 2025: { date: "2025-02-14", amount: 115_000_000 }, 2026: { date: "2026-02-13", amount: 128_000_000 } },
    health: 28_500,
    match: 0.5,
  },
  {
    person: JORDAN,
    employer: "Meridian Health Systems Inc",
    deposit: "MERIDIAN HEALTH PAYROLL",
    plan: "jordan401k",
    salary: { 2025: 28_500_000, 2026: 29_800_000 },
    bonus: { 2025: { date: "2025-03-14", amount: 14_000_000 }, 2026: { date: "2026-03-13", amount: 15_500_000 } },
    health: 9_500,
    match: 1,
  },
];

const LIMITS: Record<number, { deferral: number; ssWageBase: number }> = {
  2025: { deferral: 2_350_000, ssWageBase: 17_610_000 },
  2026: { deferral: 2_450_000, ssWageBase: 18_450_000 },
};
const limits = (year: number) => LIMITS[year] ?? LIMITS[2026]!;

/** Stock market by month (fictional, shaped like a real year: a spring dip, a strong second half). */
const EQUITY: Record<string, number> = {
  "2025-01": 0.027, "2025-02": -0.014, "2025-03": -0.058, "2025-04": -0.008, "2025-05": 0.062, "2025-06": 0.05,
  "2025-07": 0.022, "2025-08": 0.019, "2025-09": 0.035, "2025-10": 0.023, "2025-11": 0.002, "2025-12": 0.011,
  "2026-01": 0.014, "2026-02": -0.009, "2026-03": 0.021, "2026-04": 0.016, "2026-05": 0.008, "2026-06": 0.019,
};
const BONDS = 0.0035;
const equityReturn = (month: string) => EQUITY[month] ?? 0.006;

// ---------------------------------------------------------------------------
// Spending
// ---------------------------------------------------------------------------

/** A merchant: description, expected visits a month, dollar range, and the months it shows up in (default all). */
type Merchant = { d: string; n: number; lo: number; hi: number; months?: number[] };

const SAPPHIRE: Merchant[] = [
  { d: "WHOLE FOODS MARKET", n: 4, lo: 120, hi: 420 },
  { d: "TRADER JOE'S", n: 2, lo: 60, hi: 165 },
  { d: "INSTACART", n: 1, lo: 140, hi: 330 },
  { d: "STARBUCKS STORE", n: 5, lo: 6, hi: 15 },
  { d: "SWEETGREEN", n: 3, lo: 16, hi: 34 },
  { d: "TST* LUCA OSTERIA", n: 3, lo: 140, hi: 420 },
  { d: "DOORDASH", n: 3, lo: 38, hi: 95 },
  { d: "UBER TRIP", n: 4, lo: 18, hi: 68 },
  { d: "SHELL OIL", n: 2, lo: 55, hi: 96 },
  { d: "CVS/PHARMACY", n: 1, lo: 18, hi: 95 },
  { d: "EQUINOX", n: 1, lo: 285, hi: 285 },
  { d: "ICON PARKING", n: 1, lo: 42, hi: 85 },
];

const PLATINUM: Merchant[] = [
  { d: "AMAZON MKTPL", n: 3, lo: 35, hi: 380 },
  { d: "NORDSTROM", n: 0.6, lo: 240, hi: 1_400 },
  { d: "APPLE STORE", n: 0.2, lo: 900, hi: 2_400 },
  { d: "VERIZON WIRELESS", n: 1, lo: 238, hi: 252 },
  { d: "NETFLIX.COM", n: 1, lo: 24.99, hi: 24.99 },
  { d: "SPOTIFY USA", n: 1, lo: 19.99, hi: 19.99 },
  { d: "NYTIMES DIGITAL", n: 1, lo: 25, hi: 25 },
  { d: "THE CAPITAL GRILLE", n: 1.5, lo: 280, hi: 650 },
  { d: "NOBU RESTAURANT", n: 0.5, lo: 450, hi: 1_100 },
  { d: "BLUE BOTTLE COFFEE", n: 2, lo: 7, hi: 18 },
  { d: "DELTA AIR LINES", n: 0.4, lo: 900, hi: 3_800 },
  { d: "MARRIOTT HOTELS", n: 0.3, lo: 1_200, hi: 5_500 },
  { d: "AIRBNB", n: 0.2, lo: 2_000, hi: 7_000 },
  { d: "TICKETMASTER", n: 0.3, lo: 200, hi: 900 },
  { d: "SEPHORA", n: 0.5, lo: 60, hi: 240 },
  // Medical bills paid on the card: the HSA page finds them in the statements.
  { d: "PARK SLOPE DENTAL GROUP", n: 0.25, lo: 180, hi: 950 },
  { d: "CITYMD URGENT CARE", n: 0.15, lo: 150, hi: 450 },
  { d: "MANHATTAN EYE ASSOCIATES", n: 0.12, lo: 280, hi: 1_100 },
  { d: "LABCORP", n: 0.15, lo: 45, hi: 260 },
  { d: "FOUR SEASONS RESORT", n: 1, lo: 8_500, hi: 12_000, months: [7] },
  { d: "SAKS FIFTH AVENUE", n: 1, lo: 1_500, hi: 2_600, months: [12] },
  { d: "AMERICAN RED CROSS DONATION", n: 1, lo: 10_000, hi: 10_000, months: [12] },
];

// ---------------------------------------------------------------------------
// Holdings
// ---------------------------------------------------------------------------

type Position = { symbol: string | null; name: string; kind: Holding["kind"]; weight: number; price: number; bond?: boolean; basis: number; expenseRatio: number | null };

const BROKERAGE_MIX: Position[] = [
  { symbol: "VTI", name: "VANGUARD TOTAL STOCK MARKET ETF", kind: "ETF", weight: 0.38, price: 290.1, basis: 0.72, expenseRatio: 0.0003 },
  { symbol: "VOO", name: "VANGUARD S&P 500 ETF", kind: "ETF", weight: 0.14, price: 538.8, basis: 0.68, expenseRatio: 0.0003 },
  { symbol: "VXUS", name: "VANGUARD TOTAL INTL STOCK ETF", kind: "ETF", weight: 0.14, price: 59.6, basis: 0.88, expenseRatio: 0.0005 },
  { symbol: "BND", name: "VANGUARD TOTAL BOND MARKET ETF", kind: "ETF", weight: 0.1, price: 71.6, bond: true, basis: 1.02, expenseRatio: 0.0003 },
  { symbol: "AAPL", name: "APPLE INC", kind: "STOCK", weight: 0.05, price: 250.4, basis: 0.41, expenseRatio: null },
  { symbol: "MSFT", name: "MICROSOFT CORP", kind: "STOCK", weight: 0.05, price: 421.5, basis: 0.55, expenseRatio: null },
  { symbol: "NVDA", name: "NVIDIA CORP", kind: "STOCK", weight: 0.04, price: 134.3, basis: 0.22, expenseRatio: null },
  { symbol: "GOOGL", name: "ALPHABET INC CL A", kind: "STOCK", weight: 0.03, price: 189.3, basis: 0.6, expenseRatio: null },
  // Cash takes whatever the weights leave, so positions add up to the balance exactly.
  { symbol: "SPAXX", name: "FIDELITY GOVERNMENT MONEY MARKET", kind: "CASH", weight: 0, price: 1, basis: 1, expenseRatio: 0.0042 },
];

const ROTH_MIX: Position[] = [
  { symbol: "FXAIX", name: "FIDELITY 500 INDEX FUND", kind: "FUND", weight: 0.7, price: 199.6, basis: 0.64, expenseRatio: 0.00015 },
  { symbol: "FTIHX", name: "FIDELITY TOTAL INTL INDEX FUND", kind: "FUND", weight: 0.2, price: 14.2, basis: 0.9, expenseRatio: 0.0006 },
  { symbol: "FXNAX", name: "FIDELITY US BOND INDEX FUND", kind: "FUND", weight: 0, price: 10.4, bond: true, basis: 1.04, expenseRatio: 0.00025 },
];

const PLAN_MIX: Position[] = [{ symbol: null, name: "FIDELITY FREEDOM 2055 FUND K6", kind: "FUND", weight: 0, price: 14.1, basis: 0.8, expenseRatio: 0.00045 }];

// ---------------------------------------------------------------------------

/** mulberry32: small, fast, deterministic. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dayOfWeek = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
/** The date, or the Friday before it when it falls on a weekend. */
const businessDay = (iso: string) => (dayOfWeek(iso) === 6 ? addDays(iso, -1) : dayOfWeek(iso) === 0 ? addDays(iso, -2) : iso);
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthsBetween(from: string, through: string): { year: number; month: number; key: string }[] {
  const out = [];
  let [y, m] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = through.split("-").map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    out.push({ year: y, month: m, key: `${y}-${String(m).padStart(2, "0")}` });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

type Ytd = Record<string, number>;
type Paycheck = { earner: Earner; stub: PayStubFacts; deferral: number; employer: number };

/** One paycheck, with every line's year-to-date figure carried from the last. */
function paycheck(e: Earner, ytd: Ytd, payDate: string, kind: "REGULAR" | "BONUS", gross: number, period: [string, string] | null): Paycheck {
  const year = Number(payDate.slice(0, 4));
  const lim = limits(year);
  const regular = kind === "REGULAR";
  const deferral = regular ? Math.min(Math.round(lim.deferral / 24) + 1, lim.deferral - (ytd.RETIREMENT_PRETAX ?? 0)) : 0;
  const health = regular ? e.health : 0;
  const employer = Math.round(deferral * e.match);
  const ficaWages = gross - health;
  const fedWages = gross - deferral - health;
  // Supplemental wages: 22% up to $1M a year, 37% beyond.
  let federal: number;
  if (regular) federal = Math.round(fedWages * 0.24);
  else {
    const before = ytd.BONUS ?? 0;
    const at22 = Math.max(0, Math.min(gross, 100_000_000 - before));
    federal = Math.round(at22 * 0.22 + (gross - at22) * 0.37);
  }
  const ssRoom = Math.max(0, lim.ssWageBase - (ytd.ssWages ?? 0));
  const ss = Math.round(Math.min(ficaWages, ssRoom) * 0.062);
  const medWagesBefore = ytd.medWages ?? 0;
  const over = Math.max(0, medWagesBefore + ficaWages - 20_000_000) - Math.max(0, medWagesBefore - 20_000_000);
  const medicare = Math.round(ficaWages * 0.0145 + over * 0.009);
  const state = Math.round(fedWages * 0.0699);

  const current: Partial<Record<StubLineKind, number>> = {
    [kind]: gross,
    RETIREMENT_PRETAX: deferral,
    SECTION125: health,
    FEDERAL_TAX: federal,
    SOCIAL_SECURITY: ss,
    MEDICARE: medicare,
    STATE_TAX: state,
    EMPLOYER_RETIREMENT: employer,
  };
  for (const [k, v] of Object.entries(current)) ytd[k] = (ytd[k] ?? 0) + v;
  ytd.ssWages = (ytd.ssWages ?? 0) + Math.min(ficaWages, ssRoom);
  ytd.medWages = medWagesBefore + ficaWages;

  const LINES: [StubLineKind, string][] = [
    ["REGULAR", "Regular Salary"],
    ["BONUS", "Annual Bonus"],
    ["RETIREMENT_PRETAX", "401(k) Pre-Tax"],
    ["SECTION125", "Medical Pre-Tax"],
    ["FEDERAL_TAX", "Federal Income Tax"],
    ["SOCIAL_SECURITY", "Social Security Tax"],
    ["MEDICARE", "Medicare Tax"],
    ["STATE_TAX", "CT State Income Tax"],
    ["EMPLOYER_RETIREMENT", "401(k) Employer Match"],
  ];
  const lines: StubLine[] = LINES.filter(([k]) => (ytd[k] ?? 0) !== 0).map(([k, name]) => ({ name, kind: k, current: current[k] ?? 0, ytd: ytd[k] ?? 0 }));
  const withheldKinds: StubLineKind[] = ["RETIREMENT_PRETAX", "SECTION125", "FEDERAL_TAX", "SOCIAL_SECURITY", "MEDICARE", "STATE_TAX"];
  const withheld = withheldKinds.reduce((t, k) => t + (current[k] ?? 0), 0);
  const withheldYtd = withheldKinds.reduce((t, k) => t + (ytd[k] ?? 0), 0);
  const grossYtd = (ytd.REGULAR ?? 0) + (ytd.BONUS ?? 0);
  const net = gross - withheld;
  const stub: PayStubFacts = {
    source: "ADP",
    employee: e.person.printed,
    employer: e.employer,
    payrollCode: null,
    payDate,
    periodStart: period?.[0] ?? null,
    periodEnd: period?.[1] ?? null,
    federalFilingStatus: "Married filing jointly",
    lines,
    printed: { grossCurrent: gross, grossYtd, withheldCurrent: withheld, withheldYtd, netCurrent: net, netYtd: grossYtd - withheldYtd },
    deposits: [{ last4: ACCOUNTS.checking.accountNumber, amount: net }],
    warnings: [],
  };
  return { earner: e, stub, deferral, employer };
}

/** Positions adding up to `total` exactly; the weightless position takes the remainder. */
function positions(mix: Position[], total: number, equityIndex: number, bondIndex: number): Holding[] {
  const out: Holding[] = [];
  let rest = total;
  const filler = mix.find((p) => p.weight === 0)!;
  for (const p of mix) {
    if (p === filler) continue;
    const value = Math.round(total * p.weight);
    rest -= value;
    out.push(holding(p, value, equityIndex, bondIndex));
  }
  out.push(holding(filler, rest, equityIndex, bondIndex));
  return out;
}

function holding(p: Position, valueCents: number, equityIndex: number, bondIndex: number): Holding {
  const price = p.kind === "CASH" ? 1 : Math.round(p.price * (p.bond ? bondIndex : equityIndex) * 100) / 100;
  return {
    symbol: p.symbol,
    name: p.name,
    kind: p.kind,
    quantity: Math.round((valueCents / 100 / price) * 1000) / 1000,
    price,
    valueCents,
    costBasisCents: p.kind === "CASH" ? null : Math.round((valueCents * p.basis) / (p.bond ? bondIndex : equityIndex)),
    expenseRatio: p.expenseRatio,
  };
}

export function generateDemoData(opts: DemoOptions = {}): DemoData {
  const random = rng(opts.seed ?? 20250101);
  const between = (lo: number, hi: number) => Math.round((lo + random() * (hi - lo)) * 100);
  const months = monthsBetween(opts.from ?? "2025-01", opts.through ?? "2026-06");
  const documents: ParsedDocument[] = [];
  const balance = Object.fromEntries(Object.entries(ACCOUNTS).map(([k, a]) => [k, a.opening])) as Record<AccountKey, number>;
  const ytd = new Map<string, Ytd>();
  let equityIndex = 1;
  let bondIndex = 1;
  let brokerageIncome = { dividends: 0, interest: 0, capGainDistShort: 0, capGainDistLong: 0, taxExempt: 0, taxDeferred: 0 };
  let realized: BrokerageFacts["realized"] = null;

  for (const { year, month, key } of months) {
    const start = ymd(year, month, 1);
    const end = endOfMonth(start);
    const label = `${MONTH_NAMES[month - 1]} ${year}`;
    if (month === 1) {
      ytd.clear();
      brokerageIncome = { dividends: 0, interest: 0, capGainDistShort: 0, capGainDistLong: 0, taxExempt: 0, taxDeferred: 0 };
      realized = null;
    }
    const rows = Object.fromEntries(Object.keys(ACCOUNTS).map((k) => [k, [] as ParsedTransaction[]])) as Record<AccountKey, ParsedTransaction[]>;
    const add = (acct: AccountKey, date: string, description: string, amountCents: number, section: string) =>
      rows[acct].push({ date, datePrecision: "EXACT", description, amountCents, section });
    const opening = { ...balance };

    // Pay.
    const checks: Paycheck[] = [];
    for (const e of EARNERS) {
      const y = ytd.get(e.person.id) ?? {};
      ytd.set(e.person.id, y);
      const perCheck = Math.round(e.salary[year]! / 24);
      const runs: { date: string; kind: "REGULAR" | "BONUS"; gross: number; period: [string, string] | null }[] = [
        { date: businessDay(ymd(year, month, 15)), kind: "REGULAR", gross: perCheck, period: [start, ymd(year, month, 15)] },
        { date: businessDay(end), kind: "REGULAR", gross: perCheck, period: [ymd(year, month, 16), end] },
      ];
      const bonus = e.bonus[year];
      if (bonus && bonus.date.startsWith(key)) runs.push({ date: bonus.date, kind: "BONUS", gross: bonus.amount, period: null });
      runs.sort((a, b) => a.date.localeCompare(b.date));
      for (const r of runs) checks.push(paycheck(e, y, r.date, r.kind, r.gross, r.period));
    }
    for (const p of checks) {
      add("checking", p.stub.payDate, `${p.earner.deposit} PPD`, p.stub.printed.netCurrent, "Deposits");
      if (p.deferral) add(p.earner.plan, p.stub.payDate, "Payroll contribution - Pre-tax", p.deferral, "Employee contributions");
      if (p.employer) add(p.earner.plan, p.stub.payDate, "Employer matching contribution", p.employer, "Employer contributions");
      documents.push({
        parserId: DEMO_PARSER_ID,
        parserVersion: 1,
        institution: "ADP",
        kind: "PAYSTUB",
        title: `${p.earner.employer} pay stub ${p.stub.payDate}`,
        periodStart: p.stub.payDate,
        periodEnd: p.stub.payDate,
        sections: [],
        payStubs: [p.stub],
        warnings: [],
      });
    }

    // Household bills from checking.
    add("checking", businessDay(ymd(year, month, 1)), "BEACON PROPERTY MGMT RENT PAYMENT", -1_450_000, "Withdrawals");
    add("checking", ymd(year, month, 6), "EVERSOURCE ENERGY BILL PAY", -between(month >= 6 && month <= 8 ? 340 : 190, month >= 6 && month <= 8 ? 520 : 330), "Withdrawals");
    add("checking", ymd(year, month, 8), "BRIGHT HORIZONS DAYCARE TUITION", -(year === 2025 ? 345_000 : 362_500), "Withdrawals");
    add("checking", ymd(year, month, 18), "GEICO AUTO INSURANCE", -28_640, "Withdrawals");
    const tax = { "2025-04": [4_500_000, 1_150_000], "2025-06": [2_000_000, 500_000], "2025-09": [2_000_000, 500_000], "2026-01": [2_000_000, 500_000], "2026-04": [3_800_000, 900_000], "2026-06": [2_000_000, 500_000] }[key];
    if (tax) {
      add("checking", businessDay(ymd(year, month, 15)), "IRS USATAXPYMT", -tax[0]!, "Withdrawals");
      add("checking", businessDay(ymd(year, month, 15)), "CT DRS TAX PAYMENT", -tax[1]!, "Withdrawals");
    }

    // Cards: pay last month's balance in full on the 12th, then this month's spending.
    const payDay = businessDay(ymd(year, month, 12));
    if (opening.sapphire < 0) {
      add("checking", payDay, "Payment To Chase Card Ending IN 8812", opening.sapphire, "Withdrawals");
      add("sapphire", payDay, "Payment Thank You-Mobile", -opening.sapphire, "Payments");
    }
    if (opening.platinum < 0) {
      add("checking", payDay, "AMERICAN EXPRESS ACH PMT", opening.platinum, "Withdrawals");
      add("platinum", payDay, "AUTOPAY PAYMENT RECEIVED - THANK YOU", -opening.platinum, "Payments");
    }
    const days = Number(end.slice(8));
    const spend = (acct: AccountKey, merchants: Merchant[]) => {
      for (const m of merchants) {
        if (m.months && !m.months.includes(month)) continue;
        let visits = Math.floor(m.n) + (random() < m.n - Math.floor(m.n) ? 1 : 0);
        while (visits-- > 0) add(acct, ymd(year, month, 1 + Math.floor(random() * days)), m.d, -between(m.lo, m.hi), "Purchases");
      }
    };
    spend("sapphire", SAPPHIRE);
    spend("platinum", PLATINUM);
    add("platinum", ymd(year, month, 3), "PLATINUM UBER CASH CREDIT", 1_500, "Credits");
    if (month === 2) add("platinum", ymd(year, month, 1), "PLATINUM CARD ANNUAL FEE", -69_500, "Fees");

    // Savings: interest monthly, a top-up from checking in March and September.
    if (month === 3 || month === 9) {
      add("checking", ymd(year, month, 20), "AMERICAN EXPRESS TRANSFER", -2_500_000, "Withdrawals");
      add("savings", ymd(year, month, 20), "EXTERNAL ACH DEPOSIT INTERNET TRANSFER FROM JPMORGAN CHASE BANK NA DDA ACCOUNT XXXXX4417", 2_500_000, "Deposits");
    }
    const savingsBefore = opening.savings + rows.savings.reduce((t, r) => t + r.amountCents, 0);
    add("savings", end, "INTEREST PAYMENT", Math.round(savingsBefore * (year === 2025 ? 0.039 : 0.035) / 12), "Deposits");

    // Sweep checking into the brokerage account: right after a bonus, and on the 22nd.
    const sweepDays = [...checks.filter((c) => c.stub.lines.some((l) => l.kind === "BONUS" && l.current)).map((c) => addDays(c.stub.payDate, 3)),businessDay(ymd(year, month, 22))].sort();
    for (const day of sweepDays) {
      const bal = opening.checking + rows.checking.filter((r) => r.date <= day).reduce((t, r) => t + r.amountCents, 0);
      const amount = Math.floor((bal - 15_000_000) / 100_000) * 100_000;
      if (amount < 2_500_000) continue;
      add("checking", day, "FID BKG SVC LLC MONEYLINE", -amount, "Withdrawals");
      add("brokerage", day, "Electronic Funds Transfer Received JPMORGAN CHASE BANK NA ****4417", amount, "Deposits");
    }

    // Markets.
    const eq = equityReturn(key);
    equityIndex *= 1 + eq;
    bondIndex *= 1 + BONDS;
    const growth: Partial<Record<AccountKey, number>> = {};
    const grow = (acct: AccountKey, r: number) => {
      const flows = rows[acct].reduce((t, x) => t + x.amountCents, 0);
      growth[acct] = Math.round(opening[acct] * r + flows * (r / 2));
    };
    grow("brokerage", 0.86 * eq + 0.1 * BONDS + 0.04 * 0.0033);
    grow("roth", 0.9 * eq + 0.1 * BONDS);
    grow("alex401k", 0.88 * eq + 0.12 * BONDS);
    grow("jordan401k", 0.88 * eq + 0.12 * BONDS);

    // Close every account and write its statement.
    for (const acct of Object.keys(ACCOUNTS) as AccountKey[]) {
      const def = ACCOUNTS[acct];
      rows[acct].sort((a, b) => a.date.localeCompare(b.date));
      const flows = rows[acct].reduce((t, r) => t + r.amountCents, 0);
      balance[acct] = opening[acct] + flows + (growth[acct] ?? 0);
      if (acct === "checking") {
        let running = opening.checking;
        for (const r of rows.checking) {
          running += r.amountCents;
          if (running < 0) throw new Error(`Demo data: checking goes negative on ${r.date}: ${rows.checking.map((x) => `${x.date} ${x.description} ${x.amountCents}`).join("; ")}; opening ${opening.checking}`);
        }
      }
      const section: ParsedAccountSection = {
        institution: def.institution,
        accountNumber: def.accountNumber,
        accountName: def.accountName,
        kind: def.kind,
        subtype: def.subtype,
        periodStart: start,
        periodEnd: end,
        openingBalanceCents: opening[acct],
        closingBalanceCents: balance[acct],
        growthCents: growth[acct] ?? 0,
        feesCents: 0,
        transactions: rows[acct],
        checks: [],
      };
      const doc: ParsedDocument = {
        parserId: DEMO_PARSER_ID,
        parserVersion: 1,
        institution: def.institution,
        kind: "STATEMENT",
        title: `${def.title} ${label}`,
        periodStart: start,
        periodEnd: end,
        sections: [section],
        warnings: [],
      };
      const mix = acct === "brokerage" ? BROKERAGE_MIX : acct === "roth" ? ROTH_MIX : def.subtype === "401K" ? PLAN_MIX : null;
      if (mix) doc.holdings = [{ accountNumber: def.accountNumber, asOf: end, positions: positions(mix, balance[acct], equityIndex, bondIndex), printedTotalCents: balance[acct] } satisfies HoldingsFacts];
      if (acct === "brokerage") doc.brokerageFacts = [brokerageFacts(balance.brokerage, month, start, end)];
      documents.push(doc);
    }
  }

  /** The brokerage account's tax figures: dividends quarterly, money-market income monthly, a year-end gain distribution and a rebalancing sale. */
  function brokerageFacts(value: number, month: number, start: string, end: string): BrokerageFacts {
    const incomeRows: BrokerageFacts["incomeRows"] = [];
    const held = positions(BROKERAGE_MIX, value, equityIndex, bondIndex);
    for (const h of held) {
      const quarterEnd = month % 3 === 0;
      const amount =
        h.kind === "CASH" ? Math.round((h.valueCents * 0.041) / 12) : quarterEnd ? Math.round(h.valueCents * (h.symbol === "BND" ? 0.009 : h.kind === "STOCK" ? 0.0015 : 0.0038)) : 0;
      if (!amount) continue;
      incomeRows.push({ date: addDays(end, -2), security: h.name, cusip: "", kind: "DIVIDEND", amount, nonQualified: h.kind === "CASH" || h.symbol === "BND", moneyMarket: h.kind === "CASH" });
      brokerageIncome.dividends += amount;
    }
    if (month === 12) {
      const dist = Math.round(value * 0.0012);
      incomeRows.push({ date: addDays(end, -10), security: "VANGUARD TOTAL INTL STOCK ETF", cusip: "", kind: "CAP_GAIN_LT", amount: dist, nonQualified: false, moneyMarket: false });
      brokerageIncome.capGainDistLong += dist;
      realized = { shortTerm: 0, longTerm: 18_420_000 };
    }
    if (month === 3 && start.startsWith("2026")) realized = { shortTerm: -312_000, longTerm: 6_150_000 };
    return {
      accountNumber: ACCOUNTS.brokerage.accountNumber,
      ownerLine: `${ALEX.printed} AND ${JORDAN.printed} - JOINT WROS`,
      kind: "TAXABLE",
      periodStart: start,
      periodEnd: end,
      isYearEnd: false,
      endingValue: value,
      income: { ...brokerageIncome },
      realized: realized ? { ...realized } : null,
      incomeRows,
      distributions: [],
      contributionsYtd: null,
      isChet: false,
    };
  }

  const owners: Record<string, string> = {};
  for (const [k, a] of Object.entries(ACCOUNTS)) owners[a.accountNumber] = k === "alex401k" || k === "roth" ? ALEX.id : k === "jordan401k" ? JORDAN.id : "JOINT";
  const taxProfile: TaxProfile = {
    version: 1,
    persons: [ALEX, JORDAN].map((p) => ({ id: p.id, name: p.name, match: [p.printed] })),
    dependents: [{ name: "Riley", birthYear: 2021 }],
    accountOwners: owners,
    accountKinds: {},
    qualifiedDividendShare: 0.9,
    moneyMarketUsGovShare: 0.6,
    mfsDependentClaimant: "AUTO",
    years: {},
  };
  const [alex] = EARNERS;
  const awards: AwardsFile = {
    version: 1,
    letters: [
      {
        id: "harborview",
        title: "Harborview Capital annual bonus letters",
        employer: alex!.employer,
        terms: "Paid in full each February; forfeited if employment ends before the payment date.",
        awards: Object.entries(alex!.bonus).map(([year, b]) => ({
          year: Number(year) - 1,
          baseSalary: (alex!.salary[Number(year) - 1] ?? alex!.salary[Number(year)]!) / 100,
          totalBonus: b.amount / 100,
          payments: [{ kind: "UPFRONT" as const, from: b.date.slice(0, 7), to: b.date.slice(0, 7), amount: b.amount / 100 }],
        })),
      },
    ],
    stubOnly: EARNERS.slice(1).map((e) => ({ employer: e.employer, note: "Annual bonus with no letter: the stub is the record." })),
  };
  const budget: BudgetSettings = {
    version: 1,
    targets: { "Housing & utilities": 1_550_000, Groceries: 180_000, Dining: 160_000, Transportation: 50_000, "Health & insurance": 90_000, "Shopping & gifts": 600_000, "Travel & entertainment": 450_000 },
  };
  const goals: GoalSettings = {
    version: 1,
    goals: [
      { id: "emergency", name: "Emergency fund", kind: "EMERGENCY_FUND", targetCents: null, months: 6, targetDate: null, groups: ["Cash"], accountIds: [] },
      { id: "lake-house", name: "Lake house down payment", kind: "AMOUNT", targetCents: 120_000_000, months: null, targetDate: "2028-06-30", groups: ["Cash"], accountIds: [] },
    ],
  };
  // A receipts log as if brought in from a spreadsheet: most still waiting, one paid back.
  const hsaExpense = (date: string, cents: number, provider: string, patient: string, kind: HsaExpense["kind"], reimbursedOn: string | null = null): HsaExpense => ({
    id: `demo-hsa-${date}-${cents}`,
    date,
    amountCents: cents,
    provider,
    patient,
    kind,
    notes: "",
    receipt: true,
    receiptRef: "",
    source: "IMPORT",
    paidWith: null,
    reimbursement: reimbursedOn ? { date: reimbursedOn, withdrawal: null, note: "" } : null,
    createdAt: "2026-06-30T12:00:00.000Z",
    updatedAt: "2026-06-30T12:00:00.000Z",
  });
  const hsa: HsaFile = {
    version: 1,
    expenses: [
      hsaExpense("2025-02-11", 34_500, "Riverside Pediatrics well visit", "Riley", "MEDICAL", "2025-12-15"),
      hsaExpense("2025-04-03", 182_000, "Knee MRI and orthopedist", "Alex", "HOSPITAL"),
      hsaExpense("2025-06-19", 64_250, "Physical therapy, 6 sessions", "Alex", "THERAPY"),
      hsaExpense("2025-09-08", 41_000, "Eye exam and contacts", "Jordan", "VISION"),
      hsaExpense("2026-01-22", 289_600, "Wisdom teeth extraction", "Jordan", "DENTAL"),
      { ...hsaExpense("2026-03-30", 12_875, "Prescription refill", "Alex", "PHARMACY"), receipt: false },
    ],
    dismissed: [],
    ignoredMerchants: [],
    settings: { openedOn: "2024-01-01", growthRate: null, marginalRate: null, planYear: null },
  };
  return { documents, taxProfile, awards, budget, goals, car: demoCar(documents), hsa, closing: Object.fromEntries(Object.entries(balance)) };
}

/**
 * The household's cars. The Volvo, bought in January 2025: its gas station charges logged
 * with gallons and odometer (all but every third, which stay as bare statement charges), a
 * few value checks and service visits; insurance and parking come from the statements.
 * A second car, an older Honda bought in March 2026, with its own fill-ups and a parking
 * permit shared between the two.
 */
function demoCar(documents: ParsedDocument[]): GarageSettings {
  const fills = documents
    .flatMap((d) => d.sections.flatMap((s) => s.transactions))
    .filter((t) => t.description === "SHELL OIL" && t.date >= "2025-01-08")
    .sort((a, b) => a.date.localeCompare(b.date));
  let odometer = 18_400;
  const entries: Record<string, unknown>[] = [];
  fills.forEach((t, i) => {
    const cents = -t.amountCents;
    const price = 329 + ((i * 7) % 40);
    const gallons = Math.round((cents / price) * 1000) / 1000;
    odometer += Math.round(gallons * (25.5 + ((i * 3) % 7) * 0.6));
    if (i % 3 !== 2) entries.push({ id: `fuel-${i}`, carId: "volvo", date: t.date, kind: "FUEL", item: "Gas", cents, gallons, odometer });
  });
  entries.push(
    { id: "svc-24", carId: "volvo", date: "2025-06-14", kind: "MAINTENANCE", item: "24k service", note: "Dealer", cents: 18_940 },
    { id: "svc-32", carId: "volvo", date: "2025-12-02", kind: "MAINTENANCE", item: "32k service", note: "Dealer", cents: 42_615 },
    { id: "tires", carId: "volvo", date: "2026-03-09", kind: "REPAIR", item: "Four tires", cents: 91_240 },
    { id: "wash", carId: "volvo", date: "2026-04-18", kind: "CARE", item: "Detail", cents: 18_500 },
    { id: "dashcam", carId: "volvo", date: "2025-01-15", kind: "EQUIPMENT", item: "Dashcam", cents: 24_999 },
    { id: "reg", carId: "volvo", date: "2026-01-20", kind: "TAX_REG", item: "Registration renewal", cents: 12_000, months: 24 },
    { id: "tax", carId: "volvo", date: "2025-07-25", kind: "TAX_REG", item: "Car property tax", cents: 61_200, months: 12 },
    { id: "permit", carId: "shared", date: "2026-04-01", kind: "PARKING", item: "Residential parking permits (both cars)", cents: 24_000, months: 12 },
  );
  let hondaOdo = 61_200;
  for (const [i, date] of ["2026-03-14", "2026-03-30", "2026-04-17", "2026-05-06", "2026-05-24", "2026-06-12"].entries()) {
    const gallons = 10.2 + ((i * 5) % 7) * 0.31;
    hondaOdo += Math.round(gallons * (28.4 + ((i * 2) % 5) * 0.5));
    entries.push({ id: `crv-fuel-${i}`, carId: "crv", date, kind: "FUEL", item: "Gas", cents: Math.round(gallons * (335 + ((i * 11) % 30))), gallons: Math.round(gallons * 1000) / 1000, odometer: hondaOdo });
  }
  entries.push({ id: "crv-oil", carId: "crv", date: "2026-05-02", kind: "MAINTENANCE", item: "Oil change", note: "Quick lube", cents: 7_995, odometer: 62_350 });
  return normalizeGarage({
    version: 2,
    defaultCarId: "volvo",
    cars: [
      {
        id: "volvo",
        vehicle: { make: "Volvo", model: "XC60", year: 2023, trim: "B5 Core", color: "Silver", purchaseDate: "2025-01-08", purchaseOdometer: 18_400, inServiceDate: "2023-03-01", tankGallons: 18.8 },
        purchase: { priceCents: 3_890_000, feesCents: 120_000, registrationCents: 40_000, salesTaxCents: 245_000, downPaymentCents: 4_295_000 },
        plan: { sellAtMiles: 120_000, residualCents: 900_000, warrantyMiles: 50_000, warrantyYears: 4, depreciation: "MARKET" },
        values: [
          { id: "v1", date: "2025-01-08", privateCents: 3_650_000, tradeInCents: 3_300_000, source: "KBB" },
          { id: "v2", date: "2025-07-01", privateCents: 3_420_000, tradeInCents: 3_100_000, source: "KBB" },
          { id: "v3", date: "2026-01-05", privateCents: 3_210_000, tradeInCents: 2_900_000, source: "KBB" },
          { id: "v4", date: "2026-05-20", privateCents: 3_080_000, tradeInCents: 2_790_000, source: "Edmunds" },
        ],
        serviceVisits: [
          { id: "s16", date: "2025-01-08", milestoneMiles: 16_000, note: "Done by the dealer before delivery" },
          { id: "s24", date: "2025-06-14", odometer: 23_910, milestoneMiles: 24_000, note: "" },
          { id: "s32", date: "2025-12-02", odometer: 31_420, milestoneMiles: 32_000, note: "" },
        ],
      },
      {
        id: "crv",
        vehicle: { make: "Honda", model: "CR-V", year: 2019, trim: "EX", color: "Blue", purchaseDate: "2026-03-01", purchaseOdometer: 61_200, inServiceDate: "2018-11-20", tankGallons: 14 },
        purchase: { priceCents: 2_150_000, feesCents: 59_900, registrationCents: 21_000, salesTaxCents: 135_450, downPaymentCents: 2_366_350 },
        plan: { sellAtMiles: 130_000, residualCents: 500_000, warrantyMiles: 100_000, warrantyYears: 10, serviceEveryMonths: 12 },
        values: [{ id: "c1", date: "2026-03-01", privateCents: 2_080_000, tradeInCents: 1_810_000, source: "KBB" }],
        serviceRules: [
          { item: "Engine oil & filter", everyMiles: 7500 },
          { item: "Tire rotation", everyMiles: 7500 },
          { item: "Cabin air filter", everyMiles: 15000 },
          { item: "Engine air filter", everyMiles: 30000 },
        ],
        serviceVisits: [{ id: "c60", date: "2026-05-02", odometer: 62_350, milestoneMiles: 60_000, note: "Quick lube" }],
      },
    ],
    entries,
  });
}
