import type { ForecastData } from "../forecast/load.ts";
import { buildForecast } from "../forecast/forecast.ts";
import { yearPeriods, type Flows } from "../forecast/periods.ts";
import type { Bridge } from "./annualMath.ts";
import type { YearProfile } from "./buildAnnualProfile.ts";

/**
 * The year in progress as a whole-year estimate: actual through the forecast's starting
 * point (the annual profile's year to date) plus the forecast's rest of the year, on the
 * saved assumptions — the same column the Forecast page shows as the year's total.
 */
export type YearEstimate = {
  year: number;
  /** The actual part: Jan 1 through `ytd.asOf`. */
  ytd: YearProfile;
  /** First forecast month ("Jul"). */
  restFrom: string;
  /** Whole-year flows (actual + forecast). */
  flows: Flows;
  /** A partner's pay kept in their own accounts (actual part only: the forecast has none). */
  partnerKept: number;
  /** Year to date's bridge plus the forecast's rest (saved → saved, returns → growth); null when the year to date's isn't proven. */
  bridge: Bridge | null;
  /** The two parts `flows` adds up: the actual year to date and the forecast rest (their own sum is the proof's second route). */
  parts: { ytd: Flows; rest: Flows };
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function yearEstimate(d: ForecastData): YearEstimate | null {
  const r = d.profile;
  if (!r.seeds || !r.ytd) return null;
  const f = buildForecast({ seeds: r.seeds, bonusFacts: d.bonusFacts }, r.settings.outlook);
  const ps = yearPeriods(f, r, { actualYears: 1, throughYear: r.currentYear });
  const total = ps.find((p) => p.kind === "TOTAL" && p.year === r.currentYear);
  const rest = ps.find((p) => p.id === `${r.currentYear}-rest`);
  const ytd = ps.find((p) => p.id === `${r.currentYear}-ytd`);
  if (!total || !rest || !ytd || total.flows.saved == null) return null;
  const b = r.ytd.bridge;
  const rf = rest.flows;
  const bridge: Bridge | null = b
    ? {
        ...b,
        cashSaved: b.cashSaved + (rf.saved ?? 0),
        investmentGrowth: b.investmentGrowth + (rf.growth ?? 0),
        total: b.total + (rf.change ?? 0),
      }
    : null;
  return {
    year: r.currentYear,
    ytd: r.ytd,
    restFrom: MONTHS[Number(rest.from.slice(5, 7)) - 1] ?? rest.from,
    flows: total.flows,
    partnerKept: r.ytd.cash?.waterfall.partnerKept ?? 0,
    bridge,
    parts: { ytd: ytd.flows, rest: rf },
  };
}

/** A line of the annual statement's estimate column (and its "Change, full year est." tile). */
export type EstimateValue = { cents: number } | { ratio: number } | { text: string };

const BRIDGE_KEYS = ["cashSaved", "investmentGrowth", "outsideMoney", "newlyTracked", "inTransit", "unexplainedSavings", "total"] as const;

/**
 * Every figure the annual statement shows for the year in progress as a whole-year
 * estimate, by line id, as one pure function the page renders and the proof sweep
 * enumerates (proof/planningProof.ts, page "annual-estimate"; SSOT F4). A line the estimate
 * doesn't model is absent (the page leaves it blank).
 */
export function estimateFigures(e: YearEstimate): Record<string, EstimateValue> {
  const f = e.flows;
  const out: Record<string, EstimateValue> = {};
  const money = (id: string, v: number | null | undefined) => {
    if (v != null) out[id] = { cents: v };
  };
  const gross = (f.salary ?? 0) + (f.bonus ?? 0) + (f.otherIncome ?? 0);
  for (const p of e.ytd.people ?? []) if (p.member && p.age != null) out[`age:${p.personId}`] = { text: String(p.age) };
  money("salary", f.salary);
  money("bonus", f.bonus);
  money("other-income", f.otherIncome ?? 0);
  money("gross", gross);
  money("taxes-deductions", f.taxes != null ? -f.taxes : null);
  money("employer", f.employer);
  money("partner-kept", -e.partnerKept);
  // Net cash, worked back from what it saved so the column adds up.
  money("net-cash", (f.saved ?? 0) + (f.living ?? 0) + (f.bonusSpent ?? 0) + (f.oneOffs ?? 0));
  money("living", f.living != null ? -(f.living + (f.bonusSpent ?? 0)) : null);
  money("one-offs", -(f.oneOffs ?? 0));
  money("saved", f.saved);
  money("to-retirement", f.toRetirement);
  if (gross > 0 && f.saved != null) out["savings-of-gross"] = { ratio: f.saved / gross };
  money("net-worth", f.close?.netWorth);
  money("liquid", f.close?.liquid);
  money("illiquid", f.close?.illiquid);
  if (e.bridge) for (const k of BRIDGE_KEYS) money(`bridge:${k}`, e.bridge[k]);
  if (e.bridge && f.open) out["change-pct"] = { ratio: e.bridge.total / f.open };
  money("change", e.bridge?.total ?? f.change);
  return out;
}
