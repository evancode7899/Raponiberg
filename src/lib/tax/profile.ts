import type { Prisma, PrismaClient } from "@prisma/client";
import { ACCOUNT_TAX_KINDS, type AccountTaxKind } from "./facts/investments.ts";
import type { FilingStatus } from "./params.ts";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Everything the statements can't tell the tax module: who is in the household, the
 * dependents, last year's return (for the safe harbor), deductions paid outside the
 * tracked accounts, and per-person overrides. Stored as one JSON AppSetting; every
 * field has a default so a fresh install still produces a report.
 */

export type TaxPerson = {
  id: string;
  name: string;
  /** Uppercase tokens that identify this person on pay stubs and account owner lines. */
  match: string[];
};

export type Dependent = { name: string; birthYear: number };

/** Hand-entered amounts added on top of what the statements show. All cents. */
export type PersonExtras = {
  expectedBonus: number;
  otherIncome: number;
  /** Interest no tracked statement or readable 1099-INT shows (an account the app doesn't hold, a scanned 1099). */
  extraInterest: number;
  /**
   * Interest and dividends from US government obligations (Treasuries, government money
   * funds) beyond what the statements show: already in income, exempt from state tax.
   */
  usObligationIncome: number;
  extraShortTermGain: number;
  extraLongTermGain: number;
  capitalLossCarryover: number;
  /** Non-deductible IRA basis carried in from earlier years (Form 8606 line 14). */
  iraBasisCarryforward: number;
  hsaOutsidePayroll: number;
  otherAdjustments: number;
  otherStateTax: number;
  estimatedFederalExtra: number;
  estimatedCtExtra: number;
};

export type PriorYearReturn = {
  /** Form 1040 line 24 (total tax). */
  federalTotalTax: number | null;
  federalAgi: number | null;
  /** CT-1040 total income tax. */
  ctTotalTax: number | null;
};

export type PaymentAttribution = { kind: "ESTIMATE" | "BALANCE_DUE" | "REFUND" | "IGNORE"; taxYear: number };

/** What the filed return actually came to (positive: owed; negative: refund), to check the model. */
export type ActualReturn = { federalBalance: number | null; ctBalance: number | null };

/**
 * How the rest of the year's pay is forecast: repeat the latest regular paycheck or the
 * typical recent one (when the latest is a one-off), and when pay stops (a job ending).
 */
export type PayForecast = { paycheck: "LATEST" | "TYPICAL"; payThrough: string | null };

export const DEFAULT_PAY_FORECAST: PayForecast = { paycheck: "LATEST", payThrough: null };

export type PersonYearInputs = { extras: PersonExtras; pay: PayForecast };

/**
 * Where the household lived for Connecticut's purposes. A part-year resident (moved in
 * during the year, CT-1040NR/PY) is taxed only on income earned after `movedIn`: wages
 * from W-2s' Connecticut lines (else pay stubs paid on or after the date) and this share
 * of the year's investment income. Null fields are worked out: the share from the filed
 * CT-1040AW when there is one, else the share of the year after the move date.
 */
export type Residency = {
  ct: "FULL" | "PART_YEAR" | "NONRESIDENT";
  movedIn: string | null;
  investmentShare: number | null;
  /** Override for the whole CT-source figure (CT-SI line 30), when known. */
  sourceIncome: number | null;
};

export const RESIDENCY_KINDS: Residency["ct"][] = ["FULL", "PART_YEAR", "NONRESIDENT"];

/**
 * New York for the year: a full-year resident (IT-201), a part-year resident who moved
 * out on `movedOut` (IT-203), or a nonresident with New York wages (IT-203); and New York
 * City likewise. Null on the year's inputs: worked out from the year's filed New York
 * return, else from New York withholding on the W-2s and pay stubs.
 */
export type NyResidency = {
  state: "NONE" | "RESIDENT" | "PART_YEAR" | "NONRESIDENT";
  city: "NONE" | "RESIDENT" | "PART_YEAR";
  movedOut: string | null;
};

export const NY_STATE_KINDS: NyResidency["state"][] = ["NONE", "RESIDENT", "PART_YEAR", "NONRESIDENT"];
export const NY_CITY_KINDS: NyResidency["city"][] = ["NONE", "RESIDENT", "PART_YEAR"];

export type YearInputs = {
  priorYear: PriorYearReturn;
  actual: ActualReturn;
  /** Null: a full-year Connecticut resident, unless that year's filed CT return says otherwise. */
  residency: Residency | null;
  /** Null: worked out from the filed New York return or New York withholding. */
  nyResidency: NyResidency | null;
  people: Record<string, PersonYearInputs>;
  household: {
    mortgageInterest: number;
    propertyTax: number;
    charitableCash: number;
    charitableOther: number;
    dependentCareExpenses: number;
  };
  paymentOverrides: Record<string, PaymentAttribution>;
};

export type TaxProfile = {
  version: 1;
  persons: TaxPerson[];
  dependents: Dependent[];
  /** Account number → person id, or "JOINT" (split evenly when filing separately). */
  accountOwners: Record<string, string>;
  /**
   * Account number → its tax type, for a statement whose type the extractor doesn't
   * recognize (or reads wrongly). Takes precedence over the statement.
   */
  accountKinds: Record<string, AccountTaxKind>;
  /** Share of non-money-market fund/stock dividends that are qualified. */
  qualifiedDividendShare: number;
  /** Share of money-market dividends from US obligations (exempt from CT tax). */
  moneyMarketUsGovShare: number;
  /** Who claims the dependents when filing separately: a person id or "AUTO" (cheaper). */
  mfsDependentClaimant: string;
  /**
   * Accounts the household had whose statements can't be obtained (e.g. a closed
   * pre-marriage account). Money that went to or came from them is taken from the other
   * side's documents and labelled partial, instead of blocking figures.
   */
  unavailableAccounts?: UnavailableAccount[];
  years: Record<string, YearInputs>;
};

export type UnavailableAccount = { last4: string; note: string };

/** Each typed extra: its label and what it is for (Taxes › Inputs, and the report's list of typed figures). */
export const EXTRA_FIELDS: [keyof PersonExtras, string, string?][] = [
  ["expectedBonus", "Extra bonus not in the Forecast", "Gross, paid by the current employer before Dec 31, on top of what the Forecast already expects."],
  ["otherIncome", "Other taxable income", "Freelance, prizes, taxable state refunds, Schedule 1 line 8z…"],
  ["extraInterest", "Interest not in the statements", "An account the app doesn't track, or a 1099-INT it can't read"],
  [
    "usObligationIncome",
    "State-exempt US government interest",
    "Treasury or government money-fund income, already counted in interest or dividends, that New York and Connecticut don't tax (IT-201 line 28, CT Schedule 1 line 41).",
  ],
  ["extraShortTermGain", "Expected short-term gains (more sales)", "Gains (or losses, negative) from sales not yet on a statement."],
  ["extraLongTermGain", "Expected long-term gains (more sales)"],
  ["capitalLossCarryover", "Capital loss carried in from last year", "From last year's Schedule D carryover worksheet."],
  ["iraBasisCarryforward", "Non-deductible IRA basis from earlier years", "Form 8606 line 14 of last year's return."],
  ["hsaOutsidePayroll", "HSA contributions outside payroll"],
  ["otherAdjustments", "Other above-the-line deductions"],
  ["otherStateTax", "Tax owed to a state other than NY", "New York is worked out from the W-2s and stubs. Any other state's tax goes here: it's added to the total and credited against CT tax."],
  ["estimatedFederalExtra", "Federal estimated payments not in the ledger"],
  ["estimatedCtExtra", "CT estimated payments not in the ledger"],
];

export const EMPTY_EXTRAS: PersonExtras = {
  expectedBonus: 0,
  otherIncome: 0,
  extraInterest: 0,
  usObligationIncome: 0,
  extraShortTermGain: 0,
  extraLongTermGain: 0,
  capitalLossCarryover: 0,
  iraBasisCarryforward: 0,
  hsaOutsidePayroll: 0,
  otherAdjustments: 0,
  otherStateTax: 0,
  estimatedFederalExtra: 0,
  estimatedCtExtra: 0,
};

export const DEFAULT_PROFILE: TaxProfile = {
  version: 1,
  persons: [{ id: "me", name: "Me", match: [] }],
  dependents: [],
  accountOwners: {},
  accountKinds: {},
  qualifiedDividendShare: 1,
  moneyMarketUsGovShare: 0,
  mfsDependentClaimant: "AUTO",
  years: {},
};

export function emptyYear(): YearInputs {
  return {
    priorYear: { federalTotalTax: null, federalAgi: null, ctTotalTax: null },
    actual: { federalBalance: null, ctBalance: null },
    residency: null,
    nyResidency: null,
    people: {},
    household: { mortgageInterest: 0, propertyTax: 0, charitableCash: 0, charitableOther: 0, dependentCareExpenses: 0 },
    paymentOverrides: {},
  };
}

export function yearInputs(profile: TaxProfile, year: number): YearInputs {
  const y = profile.years[String(year)] ?? emptyYear();
  const base = emptyYear();
  return {
    priorYear: { ...base.priorYear, ...y.priorYear },
    actual: { ...base.actual, ...y.actual },
    residency: y.residency ?? null,
    nyResidency: y.nyResidency ?? null,
    household: { ...base.household, ...y.household },
    paymentOverrides: { ...y.paymentOverrides },
    people: Object.fromEntries(
      profile.persons.map((p) => [p.id, { extras: { ...EMPTY_EXTRAS, ...y.people?.[p.id]?.extras }, pay: { ...DEFAULT_PAY_FORECAST, ...y.people?.[p.id]?.pay } }]),
    ),
  };
}

export const TAX_PROFILE_KEY = "taxProfile.v1";

export async function loadTaxProfile(db: Db): Promise<TaxProfile> {
  const row = await db.appSetting.findUnique({ where: { key: TAX_PROFILE_KEY } });
  if (!row) return structuredClone(DEFAULT_PROFILE);
  try {
    return normalizeProfile(JSON.parse(row.value) as Partial<TaxProfile>);
  } catch {
    return structuredClone(DEFAULT_PROFILE);
  }
}

export async function saveTaxProfile(db: Db, profile: unknown): Promise<TaxProfile> {
  const p = normalizeProfile(profile as Partial<TaxProfile>);
  const value = JSON.stringify(p);
  await db.appSetting.upsert({ where: { key: TAX_PROFILE_KEY }, create: { key: TAX_PROFILE_KEY, value }, update: { value } });
  return p;
}

const int = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : d);
const intOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
const share = (v: unknown, d: number) => (typeof v === "number" && v >= 0 && v <= 1 ? v : d);

/** Coerces untrusted JSON (from the API) into a well-formed profile. */
export function normalizeProfile(raw: Partial<TaxProfile> | null | undefined): TaxProfile {
  const r = raw ?? {};
  const persons = Array.isArray(r.persons) && r.persons.length
    ? r.persons
        .filter((p) => p && typeof p.id === "string" && p.id)
        .map((p) => ({
          id: p.id,
          name: typeof p.name === "string" && p.name ? p.name : p.id,
          match: Array.isArray(p.match) ? p.match.filter((m) => typeof m === "string" && m).map((m) => m.toUpperCase()) : [],
        }))
    : DEFAULT_PROFILE.persons;
  const dependents = Array.isArray(r.dependents)
    ? r.dependents.filter((d) => d && typeof d.name === "string").map((d) => ({ name: d.name, birthYear: int(d.birthYear, new Date().getFullYear()) }))
    : DEFAULT_PROFILE.dependents;
  const years: Record<string, YearInputs> = {};
  for (const [k, y] of Object.entries(r.years ?? {})) {
    if (!/^\d{4}$/.test(k) || !y) continue;
    const base = emptyYear();
    years[k] = {
      priorYear: {
        federalTotalTax: intOrNull(y.priorYear?.federalTotalTax),
        federalAgi: intOrNull(y.priorYear?.federalAgi),
        ctTotalTax: intOrNull(y.priorYear?.ctTotalTax),
      },
      actual: { federalBalance: intOrNull(y.actual?.federalBalance), ctBalance: intOrNull(y.actual?.ctBalance) },
      residency: normalizeResidency(y.residency),
      nyResidency: normalizeNyResidency(y.nyResidency),
      household: Object.fromEntries(Object.keys(base.household).map((f) => [f, int((y.household as Record<string, unknown> | undefined)?.[f])])) as YearInputs["household"],
      paymentOverrides: Object.fromEntries(
        Object.entries(y.paymentOverrides ?? {}).filter(
          ([, a]) => a && ["ESTIMATE", "BALANCE_DUE", "REFUND", "IGNORE"].includes(a.kind) && Number.isInteger(a.taxYear),
        ),
      ),
      people: Object.fromEntries(
        Object.entries(y.people ?? {}).map(([id, p]) => [
          id,
          {
            extras: Object.fromEntries(Object.keys(EMPTY_EXTRAS).map((f) => [f, int((p?.extras as Record<string, unknown> | undefined)?.[f])])) as PersonExtras,
            pay: {
              paycheck: p?.pay?.paycheck === "TYPICAL" ? "TYPICAL" : "LATEST",
              payThrough: typeof p?.pay?.payThrough === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.pay.payThrough) ? p.pay.payThrough : null,
            },
          },
        ]),
      ),
    };
  }
  return {
    version: 1,
    persons,
    dependents,
    accountOwners: Object.fromEntries(Object.entries(r.accountOwners ?? {}).filter(([, v]) => typeof v === "string")),
    accountKinds: Object.fromEntries(Object.entries(r.accountKinds ?? {}).filter(([, v]) => ACCOUNT_TAX_KINDS.includes(v))),
    qualifiedDividendShare: share(r.qualifiedDividendShare, DEFAULT_PROFILE.qualifiedDividendShare),
    moneyMarketUsGovShare: share(r.moneyMarketUsGovShare, DEFAULT_PROFILE.moneyMarketUsGovShare),
    mfsDependentClaimant: typeof r.mfsDependentClaimant === "string" ? r.mfsDependentClaimant : "AUTO",
    unavailableAccounts: (Array.isArray(r.unavailableAccounts) ? r.unavailableAccounts : [])
      .filter((a) => a && typeof a.last4 === "string" && /^\d{4}$/.test(a.last4))
      .map((a) => ({ last4: a.last4, note: typeof a.note === "string" ? a.note.slice(0, 200) : "" })),
    years,
  };
}

function normalizeResidency(r: Partial<Residency> | null | undefined): Residency | null {
  if (!r || !RESIDENCY_KINDS.includes(r.ct as Residency["ct"])) return null;
  return {
    ct: r.ct as Residency["ct"],
    movedIn: typeof r.movedIn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.movedIn) ? r.movedIn : null,
    investmentShare: typeof r.investmentShare === "number" && r.investmentShare >= 0 && r.investmentShare <= 1 ? r.investmentShare : null,
    sourceIncome: intOrNull(r.sourceIncome),
  };
}

function normalizeNyResidency(r: Partial<NyResidency> | null | undefined): NyResidency | null {
  if (!r || !NY_STATE_KINDS.includes(r.state as NyResidency["state"])) return null;
  const state = r.state as NyResidency["state"];
  // The City follows the State: no City residence without State residence.
  const city = state === "NONE" || state === "NONRESIDENT" ? "NONE" : NY_CITY_KINDS.includes(r.city as NyResidency["city"]) ? (r.city as NyResidency["city"]) : "NONE";
  return { state, city: state === "PART_YEAR" && city === "RESIDENT" ? "PART_YEAR" : city, movedOut: typeof r.movedOut === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.movedOut) ? r.movedOut : null };
}

export function ageAtYearEnd(d: Dependent, year: number): number {
  return year - d.birthYear;
}

export type { FilingStatus };
