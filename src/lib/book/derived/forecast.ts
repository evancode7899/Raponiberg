import type { ScheduledBonus } from "../../forecast/bonusSchedule.ts";
import { balancesAt, forecastFeeds, type Forecast } from "../../forecast/forecast.ts";
import type { OutlookSeeds } from "../../profile/basePay.ts";
import { c, ln, r, type DerivedFigure } from "./types.ts";

/** A bonus payment's key in the forecast's schedule: its month, whose, and which of that person's that month. */
export function scheduleKeys(schedule: readonly Pick<ScheduledBonus, "key" | "personId">[]): string[] {
  const seen = new Map<string, number>();
  return schedule.map((b) => {
    const k = `${b.key}|${b.personId}`;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return `${k}|${n}`;
  });
}

/** Bonus payments lists the schedule through this many years after the current one. */
export const BONUS_LIST_YEARS = 2;

/** Whether Bonus payments lists a payment: through BONUS_LIST_YEARS after the current year. */
export const bonusListed = (b: Pick<ScheduledBonus, "key">, currentYear: number) => b.key <= `${currentYear + BONUS_LIST_YEARS}-12`;

/**
 * Forecast's derived figures on the saved drivers, beyond its ledger cells and seeds (proven
 * as forecast figures): each bonus payment in the schedule and the share of its award it is,
 * the bonus kept after tax, each person's bonus history as a share of salary, and what the
 * other pages read from it (Feeds). The page draws each from this list.
 */
export function forecastDerived(f: Forecast, s: Pick<OutlookSeeds, "currentYear" | "people">): DerivedFigure[] {
  const out: DerivedFigure[] = [];
  const keys = scheduleKeys(f.schedule);
  f.schedule.forEach((b, i) => {
    if (!bonusListed(b, s.currentYear)) return;
    const describes = `${b.personName}'s bonus, ${b.label}`;
    out.push({ figure: "bonus", key: keys[i], describes, value: c(b.gross), lines: [ln(describes, c(b.gross), undefined, { source: b.source === "ESTIMATE" ? "estimate" : "proven" })] });
    if (b.share != null) out.push({ figure: "bonus-share", key: keys[i], describes: `${describes}: its share of the award`, value: r(b.share), lines: [ln("The latest letter's split of an award", r(b.share))] });
  });
  if (!f.pay.bonus.keepTyped) out.push({ figure: "bonus-keep", describes: "Bonuses kept after tax", value: r(f.pay.bonus.keepRate), lines: [ln("Kept after the supplemental withholding and FICA", r(f.pay.bonus.keepRate))] });
  for (const p of s.people ?? [])
    for (const h of p.bonusHistory) if (h.pct != null) out.push({ figure: "bonus-history", key: `${p.personId}|${h.year}`, describes: `${p.name}'s ${h.year} bonus as a share of base salary`, value: r(h.pct), lines: [ln("Bonus", c(h.bonus), undefined, { source: "proven" }), ln("÷ base salary", c(h.salary), "÷", { source: "proven" }), ln("Share", r(h.pct), "=")] });
  const cy = s.currentYear;
  const { bonusToCome, liquidPerMonth } = forecastFeeds(f, cy);
  out.push(
    { figure: "feed-bonus", describes: `Bonuses still to come in ${cy} (Taxes reads it)`, value: c(bonusToCome), lines: [ln("Letter and estimated payments left this year", c(bonusToCome))] },
    { figure: "feed-liquid", describes: `Liquid money at December ${cy + 1} (Home budget reads it)`, value: c(balancesAt(f, `${cy + 1}-12`).liquid), lines: [ln("The forecast's liquid balance then", c(balancesAt(f, `${cy + 1}-12`).liquid))] },
    { figure: "feed-liquid-monthly", describes: "Into liquid money a month, the next twelve (Goals reads it)", value: c(liquidPerMonth), lines: [ln("The change in liquid money over twelve months ÷ 12", c(liquidPerMonth))] },
  );
  return out;
}
