import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../dataDir.ts";
import { COVERAGES, type Coverage } from "./types.ts";

/**
 * What each health plan covers (data/medical-plans.json), transcribed from its plan
 * documents: the Summary of Benefits and Coverage, the certificate of coverage and its
 * schedule of benefits, and any state amendment. These run to hundreds of pages of prose
 * and tables no reader can take in reliably, so, like the K-1 statements, they are read in
 * chat and written to this file (the app never calls a model: see AGENTS.md). It is the
 * owner's file: gitignored, backed up with data/, and it survives database rebuilds.
 *
 * One entry per plan and coverage period: a medical plan now, a dental and a vision plan
 * when their documents arrive. The Medical page shows each, and holds its limits to what
 * the plan's own EOBs print (lib/medical/report.ts).
 */

/** Individual and family amounts of a deductible, out-of-pocket limit or annual maximum; null where the plan sets none (a dental plan's family deductible it doesn't print). */
export type PlanAmounts = { individualCents: number | null; familyCents: number | null };

/** A deductible or limit, in and out of network. */
export type NetworkAmounts = { inNetwork: PlanAmounts; outOfNetwork: PlanAmounts | null };

/** A set amount the plan pays toward an item (a $200 frame allowance), every so often. */
export type Allowance = { id: string; service: string; cents: number; per: LimitPeriod; note?: string };

/** What you pay for a service, in and out of network, as the plan prints it ("10% coinsurance", "No charge"). */
export type CostShare = { service: string; inNetwork: string; outOfNetwork: string; note?: string };

export const LIMIT_PERIODS = ["CALENDAR_YEAR", "PLAN_YEAR", "12_MONTHS", "24_MONTHS", "36_MONTHS", "60_MONTHS", "3_YEARS", "10_YEARS", "LIFETIME"] as const;
/** The rolling windows, in months: a "2 in 12 months" cleaning is counted back from today. */
export const ROLLING_MONTHS: Partial<Record<LimitPeriod, number>> = { "12_MONTHS": 12, "24_MONTHS": 24, "36_MONTHS": 36, "60_MONTHS": 60, "3_YEARS": 36, "10_YEARS": 120 };
export type LimitPeriod = (typeof LIMIT_PERIODS)[number];

/** A cap on how much of a service the plan covers (60 therapy visits a year). */
export type ServiceLimit = {
  id: string;
  service: string;
  limit: number;
  /** "visits", "days", "exams", "cycles"… */
  unit: string;
  per: LimitPeriod;
  /** Procedure-code prefixes (CPT/HCPCS) that count toward it; with none, the claims can't tell, and the page lists the limit only. */
  codes?: string[];
  /** Codes under those prefixes that don't count (an acupuncture code inside the physical-medicine range). */
  exceptCodes?: string[];
  /** Counted per person (the default) or for the whole family. */
  perPerson?: boolean;
  /** Who it applies to ("Up to age 14"). */
  ages?: string;
  note?: string;
};

export type HealthPlan = {
  /** Stable key: insurer, plan and the period's start ("aetna-hdhp-2026-07"). */
  id: string;
  coverage: Coverage;
  insurer: string;
  name: string;
  /** POS, PPO, HMO, EPO, DHMO… */
  type?: string;
  /** The employer the group plan is through. */
  sponsor?: string;
  network?: string;
  coverageFrom: string;
  coverageTo: string;
  /** Who it covers ("Individual + Family"). */
  covers?: string;
  /** What the deductible and out-of-pocket limit reset on. The EOBs' balances say which, when the documents disagree. */
  accumulator: "CALENDAR_YEAR" | "PLAN_YEAR";
  /** A high-deductible plan that qualifies you to contribute to an HSA. */
  hsaEligible: boolean;
  /** Each person meets their own deductible inside the family's (an embedded deductible). */
  embeddedDeductible?: boolean;
  /** Medical plans have both; a dental plan a deductible, a vision plan often neither. */
  deductible: NetworkAmounts | null;
  outOfPocket: NetworkAmounts | null;
  /** The most the plan pays in a year (dental), in and out of network combined. */
  annualMaximum?: PlanAmounts | null;
  allowances?: Allowance[];
  /** What doesn't count toward the out-of-pocket limit. */
  outOfPocketExcludes?: string[];
  /** Services covered before the deductible. */
  beforeDeductible?: string[];
  /** Cost shares by kind of care ("If you visit a provider's office", "Prescription drugs"…). */
  services: { group: string; items: CostShare[] }[];
  limits: ServiceLimit[];
  excluded: string[];
  /** Covered with limits, beyond the table. */
  otherCovered: string[];
  /** Rules worth knowing: referrals, preauthorization penalties, surprise bills, a state's own rules. */
  rules: { title: string; text: string }[];
  /** The documents it was read from, by path in the statements folder. */
  sources: { file: string; title: string; date?: string }[];
  notes?: string[];
};

export type HealthPlansFile = { version: 1; plans: HealthPlan[] };

export function healthPlansFile(): string {
  return process.env.MEDICAL_PLANS_FILE || path.join(dataDir(), "medical-plans.json");
}

const isDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const centsOrNull = (v: unknown) => v === null || Number.isInteger(v);
const isAmounts = (a: unknown) => !!a && typeof a === "object" && centsOrNull((a as PlanAmounts).individualCents) && centsOrNull((a as PlanAmounts).familyCents);

/** What's wrong with a plan entry, or null: the page lists these instead of trusting a half-written file. */
export function planProblem(p: Partial<HealthPlan>): string | null {
  if (!p.id || !p.name || !p.insurer) return "needs an id, a name and an insurer";
  if (!COVERAGES.includes(p.coverage as Coverage)) return `coverage must be one of ${COVERAGES.join(", ")}`;
  if (!isDate(p.coverageFrom) || !isDate(p.coverageTo) || p.coverageFrom! > p.coverageTo!) return "needs coverageFrom and coverageTo (YYYY-MM-DD, in order)";
  if (p.coverage === "MEDICAL" && (!isAmounts(p.deductible?.inNetwork) || !isAmounts(p.outOfPocket?.inNetwork))) return "needs the in-network deductible and out-of-pocket limit (individualCents, familyCents)";
  for (const [k, v] of [["deductible", p.deductible], ["outOfPocket", p.outOfPocket]] as const) if (v != null && (!isAmounts(v.inNetwork) || (v.outOfNetwork != null && !isAmounts(v.outOfNetwork)))) return `${k} needs individualCents and familyCents (cents, or null)`;
  if (p.annualMaximum != null && !isAmounts(p.annualMaximum)) return "annualMaximum needs individualCents and familyCents (cents, or null)";
  for (const a of p.allowances ?? []) if (!a.id || !Number.isInteger(a.cents) || !LIMIT_PERIODS.includes(a.per)) return `allowance "${a.service ?? a.id}" needs an id, cents and a period`;
  if (!Array.isArray(p.services) || !Array.isArray(p.limits) || !Array.isArray(p.excluded) || !Array.isArray(p.otherCovered) || !Array.isArray(p.rules) || !Array.isArray(p.sources)) return "needs services, limits, excluded, otherCovered, rules and sources (lists, empty if none)";
  for (const l of p.limits) if (!l.id || !(l.limit > 0) || !LIMIT_PERIODS.includes(l.per)) return `limit "${l.service ?? l.id}" needs an id, a limit above 0 and a period`;
  return null;
}

/** The plans on file, and the entries that couldn't be used. No file reads as no plans. */
export function readHealthPlans(file = healthPlansFile()): { plans: HealthPlan[]; problems: { id: string; problem: string }[] } {
  if (!existsSync(file)) return { plans: [], problems: [] };
  let raw: Partial<HealthPlansFile>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Partial<HealthPlansFile>;
  } catch (e) {
    return { plans: [], problems: [{ id: path.basename(file), problem: `isn't valid JSON (${e instanceof Error ? e.message : String(e)})` }] };
  }
  const plans: HealthPlan[] = [];
  const problems: { id: string; problem: string }[] = [];
  for (const p of Array.isArray(raw.plans) ? raw.plans : []) {
    const problem = planProblem(p);
    if (problem) problems.push({ id: p?.id ?? "(no id)", problem });
    else plans.push(p);
  }
  return { plans: plans.sort((a, b) => a.coverage.localeCompare(b.coverage) || b.coverageFrom.localeCompare(a.coverageFrom)), problems };
}

/** The plan of a coverage in force on a day, if one is on file. */
export const planOn = (plans: readonly HealthPlan[], coverage: Coverage, date: string) => plans.find((p) => p.coverage === coverage && p.coverageFrom <= date && date <= p.coverageTo) ?? null;
