import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * What the profile needs beyond the Book: birth years (for the age row), which big
 * expenses were one-offs, and the outlook's assumptions about the future. Nothing here
 * changes a past figure — those come only from statements and pay stubs. Stored as one
 * JSON AppSetting; all money is cents.
 */

export type NetWorthBucket = "CASH" | "LIQUID" | "ILLIQUID" | "DEFERRED_COMP" | "PHYSICAL" | "SHORT_DEBT" | "LONG_DEBT";

export const BUCKETS: { id: NetWorthBucket; label: string; debt: boolean; liquid: boolean }[] = [
  { id: "CASH", label: "Cash & cash equivalents", debt: false, liquid: true },
  { id: "LIQUID", label: "Liquid investments", debt: false, liquid: true },
  { id: "ILLIQUID", label: "Illiquid investments", debt: false, liquid: false },
  { id: "DEFERRED_COMP", label: "Deferred compensation", debt: false, liquid: false },
  { id: "PHYSICAL", label: "Physical assets", debt: false, liquid: false },
  { id: "SHORT_DEBT", label: "Consumer / short-term debts", debt: true, liquid: true },
  { id: "LONG_DEBT", label: "Long-term debts", debt: true, liquid: false },
];

/** A future one-off (house down payment, tuition, a car) the outlook subtracts. */
export type PlannedExpense = {
  id: string;
  year: number;
  label: string;
  amount: number;
  /** 1–12; June when unset. */
  month?: number;
};

/** Which regular paycheck sets a person's base salary: the latest one, or the typical recent one. */
export type PaycheckBasis = "LATEST" | "TYPICAL";

/** Where the living-cost starting figure comes from. */
export type LivingBasis = "TRAILING_12" | "LAST_YEAR" | "THIS_YEAR";

export type PersonOutlook = {
  paycheck: PaycheckBasis;
  /** Annual base salary typed in; null = the chosen paycheck × paychecks a year. */
  salary: number | null;
  /** Expected bonus as a share of this person's base salary (long term only); null = their lowest recent year. */
  bonusPct: number | null;
};

/**
 * When the forecast adds estimated bonuses (awards no letter or stub shows yet). Bonuses
 * already paid on a stub or scheduled on an award letter always count, on their dates.
 */
export type BonusEstimates = "AFTER_NEAR_TERM" | "NEXT_PAYOUT" | "NONE";

export type BonusLayer = {
  estimates: BonusEstimates;
  /** Share of a bonus kept after tax; null = computed from the tax brackets on top of base pay. */
  keepRate: number | null;
  /** Share of the after-tax bonus that's saved (the rest is spent). */
  savedShare: number;
};

export type OutlookAssumptions = {
  /** Last projected year. */
  horizonYear: number;
  /** The near term runs through December of this year: base pay only, never a bonus. Null = next year. */
  nearTermThrough: number | null;
  /** Person id → how their base pay (and long-term bonus) is set. */
  people: Record<string, PersonOutlook>;
  /** Household employer 401(k)/HSA money on base pay; null = from pay stubs. */
  employerMatch: number | null;
  /** Employee 401(k)/HSA deferrals (part of take-home that lands in illiquid accounts); null = from pay stubs. */
  deferrals: number | null;
  /** Share of base salary left after income tax, FICA and benefit deductions (deferrals stay in); null = computed. */
  takeHomeRate: number | null;
  livingBasis: LivingBasis;
  /** Annual living cost typed in; null = the chosen basis. */
  livingCost: number | null;
  /** Yearly raise on base salary (the 401(k)/HSA money scales with it). */
  salaryGrowth: number;
  livingGrowth: number;
  bonus: BonusLayer;
  /** Nominal annual return on everything invested. */
  returnRate: number;
  /** Retire ("walk away") at the start of this year; null = keep working through the horizon. */
  walkAwayYear: number | null;
  /** Pre-tax draw, as a share of start-of-year net worth, once retired. */
  withdrawalRate: number;
  /** Flat state rate on retirement draws (federal uses the real brackets). */
  /** A flat state rate on retirement draws (retiring elsewhere); null: Connecticut's brackets, the law the Taxes page uses. */
  stateTaxRate: number | null;
  /** Indexing of the standard deduction and brackets, and inflation for the purchasing-power view. */
  inflation: number;
  plannedExpenses: PlannedExpense[];
  /** FIRE: the age a conventional retirement starts (the Coast FIRE target). */
  retirementAge: number;
  /** FIRE stress test: standard deviation of a year's return. */
  volatility: number;
};

export type FinancialProfileSettings = {
  version: 1;
  /** Person id → birth year (for the age row). */
  birthYears: Record<string, number>;
  /** Spending categories whose rows always count as non-recurring. */
  nonRecurringCategories: string[];
  /** Transaction fingerprint → label: individual expenses marked as one-offs. */
  oneOffs: Record<string, string>;
  outlook: OutlookAssumptions;
};

export const DEFAULT_PERSON_OUTLOOK: PersonOutlook = { paycheck: "TYPICAL", salary: null, bonusPct: null };
export const DEFAULT_BONUS_LAYER: BonusLayer = { estimates: "AFTER_NEAR_TERM", keepRate: null, savedShare: 1 };

export const DEFAULT_OUTLOOK: OutlookAssumptions = {
  horizonYear: new Date().getFullYear() + 20,
  nearTermThrough: null,
  people: {},
  employerMatch: null,
  deferrals: null,
  takeHomeRate: null,
  livingBasis: "TRAILING_12",
  livingCost: null,
  salaryGrowth: 0.03,
  livingGrowth: 0.025,
  bonus: DEFAULT_BONUS_LAYER,
  returnRate: 0.05,
  walkAwayYear: null,
  withdrawalRate: 0.035,
  stateTaxRate: null,
  inflation: 0.025,
  plannedExpenses: [],
  retirementAge: 65,
  volatility: 0.15,
};

export const DEFAULT_SETTINGS: FinancialProfileSettings = {
  version: 1,
  birthYears: {},
  nonRecurringCategories: [],
  oneOffs: {},
  outlook: DEFAULT_OUTLOOK,
};

export const PROFILE_SETTINGS_KEY = "financialProfile.v1";

export async function loadProfileSettings(db: Db): Promise<FinancialProfileSettings> {
  const row = await db.appSetting.findUnique({ where: { key: PROFILE_SETTINGS_KEY } });
  if (!row) return structuredClone(DEFAULT_SETTINGS);
  try {
    return normalizeSettings(JSON.parse(row.value) as Partial<FinancialProfileSettings>);
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

/**
 * Saves the fields present in `raw` over the stored settings (an `outlook` object
 * replaces the stored one whole), so pages that own different parts — one-off tags on
 * Annual report and Cash flow, assumptions on FIRE, birth years in Settings — can't
 * overwrite each other's edits.
 */
export async function saveProfileSettings(db: Db, raw: unknown): Promise<FinancialProfileSettings> {
  const current = await loadProfileSettings(db);
  const s = normalizeSettings({ ...current, ...(raw as Partial<FinancialProfileSettings>) });
  const value = JSON.stringify(s);
  await db.appSetting.upsert({ where: { key: PROFILE_SETTINGS_KEY }, create: { key: PROFILE_SETTINGS_KEY, value }, update: { value } });
  return s;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const cents = (v: unknown) => (num(v) ? Math.round(v) : null);
const rate = (v: unknown, d: number, lo = -0.5, hi = 1) => (num(v) && v >= lo && v <= hi ? v : d);
const year = (v: unknown) => (num(v) && v >= 1900 && v <= 2200 ? Math.round(v) : null);
const str = (v: unknown, d = "") => (typeof v === "string" ? v.slice(0, 200) : d);
const record = <T,>(v: unknown, f: (x: unknown) => T | null): Record<string, T> =>
  Object.fromEntries(
    Object.entries(v && typeof v === "object" ? v : {})
      .map(([k, x]) => [k, f(x)] as const)
      .filter((e): e is readonly [string, T] => e[1] != null),
  );

function personOutlook(v: unknown): PersonOutlook | null {
  if (!v || typeof v !== "object") return null;
  const x = v as Partial<PersonOutlook>;
  return {
    paycheck: x.paycheck === "LATEST" ? "LATEST" : "TYPICAL",
    salary: cents(x.salary),
    bonusPct: num(x.bonusPct) && x.bonusPct >= 0 && x.bonusPct <= 10 ? x.bonusPct : null,
  };
}

/** Coerces untrusted JSON (from the API) into well-formed settings. */
export function normalizeSettings(raw: Partial<FinancialProfileSettings> | null | undefined): FinancialProfileSettings {
  const r = raw ?? {};
  const o = (r.outlook ?? {}) as Partial<OutlookAssumptions>;
  const d = DEFAULT_OUTLOOK;
  // Before 2026-10 `bonus` was a household dollar figure; that shape resets to the layer's defaults.
  const b = (o.bonus && typeof o.bonus === "object" ? o.bonus : {}) as Partial<BonusLayer> & { include?: unknown };
  // Before the bonus schedule, the layer was on/off (`include`); off meant no estimates.
  const estimates: BonusEstimates =
    b.estimates === "AFTER_NEAR_TERM" || b.estimates === "NEXT_PAYOUT" || b.estimates === "NONE" ? b.estimates : b.include === false ? "NONE" : DEFAULT_BONUS_LAYER.estimates;
  return {
    version: 1,
    birthYears: record(r.birthYears, year),
    nonRecurringCategories: Array.isArray(r.nonRecurringCategories) ? r.nonRecurringCategories.filter((c) => typeof c === "string") : [],
    oneOffs: record(r.oneOffs, (v) => (typeof v === "string" ? v.slice(0, 200) : null)),
    outlook: {
      horizonYear: year(o.horizonYear) ?? d.horizonYear,
      nearTermThrough: year(o.nearTermThrough),
      people: record(o.people, personOutlook),
      employerMatch: cents(o.employerMatch),
      deferrals: cents(o.deferrals),
      takeHomeRate: num(o.takeHomeRate) && o.takeHomeRate > 0 && o.takeHomeRate <= 1 ? o.takeHomeRate : null,
      livingBasis: o.livingBasis === "LAST_YEAR" || o.livingBasis === "THIS_YEAR" ? o.livingBasis : "TRAILING_12",
      livingCost: cents(o.livingCost),
      salaryGrowth: rate(o.salaryGrowth, d.salaryGrowth),
      livingGrowth: rate(o.livingGrowth, d.livingGrowth),
      bonus: {
        estimates,
        keepRate: num(b.keepRate) && b.keepRate > 0 && b.keepRate <= 1 ? b.keepRate : null,
        savedShare: rate(b.savedShare, DEFAULT_BONUS_LAYER.savedShare, 0, 1),
      },
      returnRate: rate(o.returnRate, d.returnRate),
      walkAwayYear: year(o.walkAwayYear),
      withdrawalRate: rate(o.withdrawalRate, d.withdrawalRate, 0, 0.2),
      // 5% was the old default every saved file carries, never a choice: it reads as untyped (the real brackets).
      stateTaxRate: num(o.stateTaxRate) && o.stateTaxRate >= 0 && o.stateTaxRate <= 0.2 && o.stateTaxRate !== 0.05 ? o.stateTaxRate : null,
      inflation: rate(o.inflation, d.inflation, -0.05, 0.2),
      plannedExpenses: (Array.isArray(o.plannedExpenses) ? o.plannedExpenses : [])
        .filter((e) => e && typeof e.id === "string" && year(e.year) != null && num(e.amount))
        .map((e) => ({
          id: e.id,
          year: year(e.year)!,
          label: str(e.label),
          amount: Math.round(e.amount),
          ...(num(e.month) && e.month >= 1 && e.month <= 12 ? { month: Math.round(e.month) } : {}),
        })),
      retirementAge: num(o.retirementAge) && o.retirementAge >= 40 && o.retirementAge <= 80 ? Math.round(o.retirementAge) : d.retirementAge,
      volatility: rate(o.volatility, d.volatility, 0, 0.5),
    },
  };
}
