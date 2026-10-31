import type { CarReport, GarageReport } from "../../car/report.ts";
import { c, ln, r, t, type DerivedFigure } from "./types.ts";

/** Miles driven in each calendar year of a car's months (Costs › Miles), oldest first. */
export const milesByYear = (car: Pick<CarReport, "months">): [string, number][] => {
  const by = new Map<string, number>();
  for (const m of car.months) by.set(m.month.slice(0, 4), (by.get(m.month.slice(0, 4)) ?? 0) + m.miles);
  return [...by];
};

/** A car's year (Costs › Miles). */
export const yearKey = (carId: string, year: string) => `${carId}:${year}`;

const num = (v: number | null | undefined) => (v == null ? null : r(v));
const money = (v: number | null | undefined) => (v == null ? null : c(v));

/**
 * The Car page's derived figures, for each car (key: the car's id): miles and fuel economy,
 * owning and driving costs as rates, what the car is worth, the warranty, and the
 * garage-wide reconciliation of statements against the log (no key).
 */
export function carDerived(g: GarageReport): DerivedFigure[] {
  const out: DerivedFigure[] = [];
  for (const car of g.cars) {
    if (!car.configured) continue;
    const key = car.carId;
    const o = car.odometer;
    const tt = car.totals;
    const f = car.fuel;
    const d = car.depreciation;
    const w = car.warranty;
    const add = (figure: string, describes: string, value: DerivedFigure["value"], lines: DerivedFigure["lines"] = [], note?: string) => out.push({ figure, key, describes: `${car.name}: ${describes}`, value, lines, ...(note ? { note } : {}) });
    const readings = [ln(`Odometer at purchase`, num(o.purchase) ?? t("—"), undefined, { source: "proven" }), ln(`Odometer, ${o.asOf ?? "latest"}`, num(o.current) ?? t("—"), undefined, { source: "proven" })];
    add("miles-driven", "miles driven since purchase", r(o.driven), [...readings, ln("Miles driven", r(o.driven), "=")], "From the odometer readings in the log.");
    for (const [year, miles] of milesByYear(car))
      out.push({ figure: "miles-year", key: yearKey(key, year), describes: `${car.name}: miles driven in ${year}`, value: r(miles), lines: [ln(`Miles in ${year}'s months, from the odometer readings`, r(miles))] });
    add("mpg", "lifetime fuel economy (mpg)", num(f.mpg), [ln("Full fills measured", t(String(f.fills.length))), ln("Miles ÷ gallons over them", num(f.mpg) ?? t("—"))]);
    add("recent-mpg", "fuel economy over the last 5 fills", num(f.recentMpg), [ln("The last fills' miles ÷ gallons", num(f.recentMpg) ?? t("—"))]);
    add("price-per-gallon", "average price paid per gallon", money(f.pricePerGallon), [ln("Gallons bought", r(f.gallons)), ln("Price per gallon", money(f.pricePerGallon) ?? t("—"))]);
    add("fuel-per-mile", "fuel cost per mile", num(f.fuelPerMile), [ln("Fuel, accrued to date", c(car.accrued.FUEL), undefined, { source: "proven" }), ln("÷ miles driven", r(o.driven), "÷"), ln("Fuel per mile", num(f.fuelPerMile) ?? t("—"), "=")]);
    add("range", "average range on a tank", num(f.avgRange), [ln("Miles per gallon × the tank's gallons", num(f.avgRange) ?? t("—"))]);
    add("recent-per-day", "miles a day lately", num(o.recentPerDay), [ln("Recent readings' miles ÷ days", num(o.recentPerDay) ?? t("—"))]);
    add(
      "marginal-per-mile",
      "what one more mile costs",
      num(tt.marginalPerMile),
      [ln("Fuel & upkeep per mile", num(tt.operatingPerMile) ?? t("—")), ln("Planned wear per mile", num(d.plannedPerMile) ?? t("—"), "+"), ln("One more mile", num(tt.marginalPerMile) ?? t("—"), "=")],
    );
    add("fixed-per-month", "owning it, per month (insurance, parking, taxes, interest)", money(tt.fixedPerMonth), [ln("Fixed costs accrued to date", c(tt.fixed), undefined, { source: "proven" }), ln("÷ months owned", r(o.daysOwned / (365.25 / 12)), "÷"), ln("Per month", money(tt.fixedPerMonth) ?? t("—"), "=")]);
    add("operating-per-mile", "driving it, per mile (fuel, maintenance, repairs, care)", num(tt.operatingPerMile), [ln("Driving costs accrued to date", c(tt.operating), undefined, { source: "proven" }), ln("÷ miles driven", r(o.driven), "÷"), ln("Per mile", num(tt.operatingPerMile) ?? t("—"), "=")]);
    add("cash-out-the-door", "cash out the door: purchase, interest and every cost paid", c(tt.cashOutTheDoor), [
      ln("All-in purchase", c(car.acquisition.cents), undefined, { source: "proven" }),
      ln("Interest paid", c(car.acquisition.interestCents)),
      ...Object.entries(car.cash)
        .filter(([k, v]) => k !== "PAYMENT" && k !== "INTEREST" && v)
        .map(([k, v]) => ln(`${k.toLowerCase()} paid`, c(v), undefined, { source: "proven" })),
      ln("Cash out the door", c(tt.cashOutTheDoor), "="),
    ]);
    add("prepaid", "prepaid, not yet used (the rest of premiums and annual bills)", c(car.prepaidCents), [ln("Prepaid premiums and bills not yet used", c(car.prepaidCents), undefined, { source: "proven" })]);
    add("acquisition", "all-in purchase", c(car.acquisition.cents), [ln("Price, fees and taxes at purchase", c(car.acquisition.cents), undefined, { source: "proven" })]);
    add("market-value-now", car.sold ? "what it sold for" : "worth now (market)", money(d.marketValueNow), [ln(car.sold ? "Sale price" : "Latest value check, on the trend", money(d.marketValueNow) ?? t("—"), undefined, { source: car.sold ? "proven" : "assumption" })]);
    add("market-to-date", "value lost to date (market)", money(d.marketToDate), [ln("All-in purchase", c(car.acquisition.cents)), ln("Worth now", money(d.marketValueNow) ?? t("—")), ln("Lost to date", money(d.marketToDate) ?? t("—"), "=")]);
    add("planned-to-date", "value lost to date (planned)", c(d.plannedToDate), [ln("Planned wear per mile", num(d.plannedPerMile) ?? t("—"), undefined, { source: "assumption" }), ln("× miles driven", r(o.driven), "×"), ln("Lost to date (planned)", c(d.plannedToDate), "=")]);
    add("planned-value-now", "planned value now", money(d.plannedValueNow), [ln("All-in purchase less planned wear to date", money(d.plannedValueNow) ?? t("—"))]);
    if (!car.sold) {
      add("warranty-miles-left", "warranty miles left", num(w.milesLeft), [ln("Warranty miles", r(w.milesLimit), undefined, { source: "assumption" }), ln("Odometer", num(o.current) ?? t("—"), "−"), ln("Miles left", num(w.milesLeft) ?? t("—"), "=")]);
      add("warranty-days-left", "warranty days left", num(w.daysLeft), [ln("Expires", t(w.expiresOn ?? "—"), undefined, { source: "assumption" }), ln("Days left", num(w.daysLeft) ?? t("—"))]);
      add("warranty-break-even", "miles a day that use the warranty up just in time", num(w.breakEvenPerDay), [ln("Miles left ÷ days left", num(w.breakEvenPerDay) ?? t("—"))]);
      add("warranty-ends-by", "what runs out first", w.endsBy ? t(w.endsBy === "TIME" ? "by time" : "by miles") : null, [ln("At your recent pace, ends", t(w.endsOn ?? "—"))]);
    }
  }
  const a = g.statements.audit;
  const gx = (figure: string, describes: string, value: DerivedFigure["value"], lines: DerivedFigure["lines"]) => out.push({ figure, describes, value, lines });
  gx("statement-costs", "car costs from statements", c(a.rowsCents - a.paymentCents), [ln("Car rows on statements", c(a.rowsCents), undefined, { source: "proven" }), ln("Car payments (the purchase)", c(a.paymentCents), "−"), ln("Car costs from statements", c(a.rowsCents - a.paymentCents), "=")]);
  gx("log-matched", "log entries matched to a statement charge", t(`${a.matched + a.installments} of ${a.entries - a.noCost}`), [ln("Matched", t(String(a.matched))), ln("Paid in installments", t(String(a.installments))), ln("Log entries with a cost", t(String(a.entries - a.noCost)))]);
  gx("not-found", "log entries on no statement", t(String(a.notFound)), [ln("Entries before the statements end with no charge", t(String(a.notFound)))]);
  gx("awaiting", "log entries awaiting statements", t(String(a.awaiting)), [ln(`Entries after ${g.statementsThrough}`, t(String(a.awaiting)))]);
  return out;
}
