import type { ForecastData } from "@/lib/forecast/load";
import { buildForecast } from "@/lib/forecast/forecast";
import { yearPeriods, type Flows } from "@/lib/forecast/periods";
import type { Bridge } from "@/lib/profile/annualMath";
import type { YearProfile } from "@/lib/profile/buildAnnualProfile";

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
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function yearEstimate(d: ForecastData): YearEstimate | null {
  const r = d.profile;
  if (!r.seeds || !r.ytd) return null;
  const f = buildForecast({ seeds: r.seeds, bonusFacts: d.bonusFacts }, r.settings.outlook);
  const ps = yearPeriods(f, r, { actualYears: 1,throughYear: r.currentYear });
  const total = ps.find((p) => p.kind === "TOTAL" && p.year === r.currentYear);
  const rest = ps.find((p) => p.id === `${r.currentYear}-rest`);
  if (!total || !rest || total.flows.saved == null) return null;
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
  };
}
