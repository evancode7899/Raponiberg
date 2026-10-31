import { COST_LINES, LINE_INFO, type CarReport, type CostLine, type GarageReport } from "../../car/report.ts";
import type { DerivedFigure } from "../derived/types.ts";
import { centsRoute, ratioRoute, rederiveList } from "../proof/independence.ts";
import type { ProofValue, Rederivation, RederivedRoute } from "../proof/types.ts";

/**
 * The Car page's derived figures worked out a second way (F5): fuel economy from the fill
 * list (each fill's odometer and gallons), the owning and driving rates and the planned wear
 * from the month-by-month series re-added (each month accrues its own share of every cost),
 * cash out the door from the months' cash less the loan payments, and the warranty
 * arithmetic from its own terms. What stands on the owner's word (the purchase, the value
 * checks, the plan) or is a projection (next 12 months) says so.
 */
export function rederiveCar(g: GarageReport, figures: readonly DerivedFigure[]): Record<string, Rederivation> {
  const cars = new Map(g.cars.map((c) => [c.carId, c]));
  const SERIES = "the month-by-month series, re-added";
  const FILLS = "each fill-up's miles and gallons, re-added";
  const lineSum = (car: CarReport, lines: CostLine[]) => car.months.reduce((s, m) => s + lines.reduce((t, l) => t + m.lines[l], 0), 0);
  const group = (gr: "FIXED" | "OPERATING") => COST_LINES.filter((l) => LINE_INFO[l].group === gr);
  // Each month's lines are rounded: a cent a month either way.
  const perMile = (car: CarReport) => car.months.length / Math.max(1, car.odometer.driven) + 1e-9;
  const weighted = (fills: CarReport["fuel"]["fills"]) => {
    const gal = fills.reduce((s, f) => s + f.gallons, 0);
    return gal > 0 ? fills.reduce((s, f) => s + f.mpg * f.gallons, 0) / gal : null;
  };
  const projection = { none: "A projection of the next twelve months from the last twelve and the owner's plan: an estimate on no statement." };
  const typed = (what: string) => ({ none: `${what}, as the owner entered it: nothing to re-derive.` });

  return rederiveList(figures, (f) => {
    const v = f.value;
    if (!f.key) return garageRoutes(f.figure, v, g);
    const car = cars.get(f.key.split(/[|:]/)[0]!);
    if (!car) return null;
    const o = car.odometer;
    switch (f.figure) {
      case "miles-driven":
        return [ratioRoute("the months' miles, re-added", v, car.months.reduce((s, m) => s + m.miles, 0), "miles between the odometer readings, month by month", car.months.length)];
      case "miles-year": {
        const year = f.key.split(":")[1]!;
        const ms = car.months.filter((m) => m.month.startsWith(year));
        const before = car.months.filter((m) => m.month < `${year}-01`).at(-1)?.cumulativeMiles ?? 0;
        return [ratioRoute("the running total of miles at the year's ends", v, (ms.at(-1)?.cumulativeMiles ?? before) - before, "miles through the year's last month less miles through the year before", ms.length + 1)];
      }
      case "mpg":
        return [ratioRoute(FILLS, v, weighted(car.fuel.fills), "each fill's MPG weighted by its gallons", 1e-6)];
      case "recent-mpg":
        return [ratioRoute(FILLS, v, weighted(car.fuel.fills.slice(-5)), "the last five fills' MPG weighted by their gallons", 1e-6)];
      case "range": {
        const f0 = car.fuel.fills.find((x) => x.range != null);
        const mpg = weighted(car.fuel.fills);
        return [ratioRoute(FILLS, v, f0 && mpg ? (f0.range! / f0.mpg) * mpg : null, "lifetime MPG × the tank (a fill's range over its MPG)", 1e-6)];
      }
      case "price-per-gallon":
        return { none: "Every priced fill-up's cost over its gallons, as the statements and the log print them: the fills folded or skipped for MPG still count here, so no other list holds it." };
      case "fuel-per-mile":
        return [ratioRoute(SERIES, v, o.driven > 0 ? lineSum(car, ["FUEL"]) / o.driven : null, "fuel accrued month by month over miles driven", perMile(car))];
      case "operating-per-mile":
        return [ratioRoute(SERIES, v, o.driven > 0 ? lineSum(car, group("OPERATING")) / o.driven : null, "driving costs accrued month by month over miles driven", perMile(car))];
      case "marginal-per-mile":
        return [ratioRoute(SERIES, v, o.driven > 0 ? lineSum(car, group("OPERATING")) / o.driven + (car.depreciation.plannedPerMile ?? 0) : null, "driving costs per mile plus the planned wear per mile", perMile(car))];
      case "fixed-per-month": {
        const months = o.daysOwned / (365.25 / 12);
        return [centsRoute(SERIES, v, months >= 1 ? lineSum(car, group("FIXED")) / months : 0, "fixed costs accrued month by month over months owned", Math.ceil(car.months.length / Math.max(1, months)) + 1)];
      }
      case "planned-to-date":
        return [centsRoute(SERIES, v, car.months.reduce((s, m) => s + m.plannedDepreciation, 0), "each month's planned wear on its miles", car.months.length)];
      case "cash-out-the-door": {
        const payments = car.items.filter((i) => i.kind === "PAYMENT" && i.date <= car.through).reduce((s, i) => s + i.cents, 0);
        const sale = car.sold ? (car.depreciation.marketValueNow ?? 0) : 0;
        const cash = car.months.reduce((s, m) => s + m.cash, 0);
        return [centsRoute("the months' cash, less loan payments, plus the purchase and interest", v, car.acquisition.cents + car.acquisition.interestCents - sale + cash - payments, "every month's cash out re-added", car.months.length + 1)];
      }
      case "market-to-date":
        return car.depreciation.marketValueNow == null ? null : [centsRoute("the all-in purchase less the worth-now figure", v, car.acquisition.cents - car.depreciation.marketValueNow, "the page's two figures, subtracted again")];
      case "warranty-miles-left":
      case "warranty-days-left":
      case "warranty-break-even":
      case "warranty-ends-by":
        return warrantyRoutes(f.figure, v, car);
      case "prepaid":
        return { none: "Premiums and annual bills paid ahead, from the statement charges and the days each covers: the one place they're spread." };
      case "acquisition":
        return typed("The purchase price, fees and taxes");
      case "market-value-now":
        return car.sold ? typed("The sale price") : typed("The latest value check on its trend");
      case "planned-value-now":
        return typed("The planned wear schedule");
      case "recent-per-day":
        return { none: "The pace of the latest odometer readings in the log: the readings are the only source." };
      case "outlook":
      case "outlook-per-mile":
      case "outlook-per-month":
        return projection;
      default:
        return null;
    }
  });
}

function warrantyRoutes(figure: string, v: ProofValue, car: CarReport): RederivedRoute[] | { none: string } {
  const w = car.warranty;
  const ROUTE = "the warranty's terms and the odometer";
  if (figure === "warranty-miles-left") return w.milesLimit == null || car.odometer.current == null ? { none: "No mileage limit or reading." } : [ratioRoute(ROUTE, v, Math.max(0, w.milesLimit - car.odometer.current), "the mileage limit less the latest reading")];
  if (figure === "warranty-break-even") return w.milesLeft == null || !w.daysLeft ? { none: "No miles or days left to divide." } : [ratioRoute(ROUTE, v, w.milesLeft / w.daysLeft, "miles left over days left", 1e-9)];
  return { none: "Counted from the expiry the owner typed (days left) or the pace of the readings (what runs out first)." };
}

function garageRoutes(figure: string, v: ProofValue, g: GarageReport): RederivedRoute[] | { none: string } | null {
  if (figure === "statement-costs") {
    const items = g.cars.flatMap((c) => c.items).filter((i) => i.source === "STATEMENT" && i.kind !== "PAYMENT");
    const seen = new Set<string>();
    const cents = items.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true))).reduce((s, i) => s + i.cents, 0);
    return [centsRoute("every car's statement items, re-added", v, cents, "each car's cost items read off statements, less the purchase payments")];
  }
  if (figure === "log-matched" || figure === "not-found" || figure === "awaiting") return { none: "A count of the matcher's verdicts on the log's entries: a classification, not a sum." };
  return null;
}

