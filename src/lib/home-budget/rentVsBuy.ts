import { computeBudgetScenario, computeRentVsBuy, simulateRentVsBuy, type BudgetScenarioResult, type HomeBudgetInputs, type RentVsBuyResult, type RentVsBuySimulation } from "./homeBudgetModel.ts";

/**
 * Home budget › Rent vs buy's four tiles, as one pure function the page renders and the
 * proof sweep re-runs on the saved inputs (proof/planningProof.ts, "home" figures rvb-*):
 * the same budget scenario, ownership cost and 30-year simulation (SSOT F4).
 */

export const SIM_YEARS = 30;

export type RentVsBuyFigure = "rvb-ahead" | "rvb-break-even" | "rvb-owning" | "rvb-rent";
export const RENT_VS_BUY_FIGURES: RentVsBuyFigure[] = ["rvb-ahead", "rvb-break-even", "rvb-owning", "rvb-rent"];

export type RentVsBuyFigures = {
  b: BudgetScenarioResult;
  snap: RentVsBuyResult;
  sim: RentVsBuySimulation;
  /** The year you'd sell, within the simulation. */
  horizon: number;
  /** Money in dollars (as the model works), the break-even as words. */
  values: { "rvb-ahead": number; "rvb-break-even": string; "rvb-owning": number; "rvb-rent": number };
};

/** The tiles on the inputs the model runs on (Home budget's linked inputs). */
export function rentVsBuyFigures(ins: HomeBudgetInputs): RentVsBuyFigures {
  const b = computeBudgetScenario(ins);
  const snap = computeRentVsBuy(ins, b);
  const sim = simulateRentVsBuy(ins, b, SIM_YEARS);
  const horizon = Math.min(SIM_YEARS, Math.max(1, Math.round(ins.horizonYears)));
  return {
    b,
    snap,
    sim,
    horizon,
    values: {
      "rvb-ahead": sim.years[horizon - 1]!.buyAdvantage,
      "rvb-break-even": sim.breakEvenYear ? `Year ${sim.breakEvenYear}` : "Never",
      "rvb-owning": snap.monthlyCostOfHomeOwnership,
      "rvb-rent": ins.marketRentMonthly,
    },
  };
}
