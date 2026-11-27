import type { AccessFigure, StressFigure } from "../../fire/longTerm.ts";
import { FIRE_TARGET_SERIES, type FireTargetSeries } from "../../fire/fire.ts";
import { loadForecastData } from "../../forecast/load.ts";
import { defaultHomeBudgetInputs, type HomeBudgetInputs } from "../../home-budget/homeBudgetModel.ts";
import type { FundsConfig } from "../../home-budget/homeLinked.ts";
import { RENT_VS_BUY_FIGURES, type RentVsBuyFigure } from "../../home-budget/rentVsBuy.ts";
import { MORTGAGE_FIGURES, type MortgageFigure } from "../../mortgage/figures.ts";
import { type MortgageInputs, normalizeMortgageInputs } from "../../mortgage/inputs.ts";
import type { OutlookAssumptions } from "../../profile/settings.ts";
import { perBook } from "./common.ts";
import { buildAnnualEstimate, buildMortgage, buildTaxes } from "./planning/estimates.ts";
import { buildFire, fireCtx } from "./planning/fire.ts";
import { buildGoal, goalsCtx } from "./planning/goals.ts";
import { buildHome, homeCtx } from "./planning/home.ts";
import { type Base, type Built, linkCells, withheldProof } from "./planning/shared.ts";
import type { Proof, ProofContext, ProofKind } from "./types.ts";

/**
 * The proof behind the figures the planning pages take from the shared forecast
 * (lib/forecast): FIRE, Goals, Home budget, and Taxes' rest-of-year pay. Each is a chain:
 * the page's own maths on top (a FIRE number = the draw that pays living cost after tax ÷
 * the withdrawal rate; a goal lands in the first month the forecast's new money covers
 * what it still needs; the most a home can cost = the loan your limit pays for + the
 * cash put in…), each starting point opening its proof:
 *
 *  - the forecast's seeds (starting net worth, pay, living cost, bonuses) open the
 *    "forecast" seed proofs, which open the net-worth, cash-flow and pay proofs;
 *  - real balances, spending and pay open the net-worth / cash-flow / pay proofs directly;
 *  - a projected value (a balance or a salary in a future month) is an "estimate" line
 *    with its value, built by `projected` with the forecast ledger cell it is (a month,
 *    or a forecast year Jan–Dec). It opens that cell's proof (forecast figure "month")
 *    only when the cell, re-read from the saved forecast, holds exactly the line's value;
 *    lines no cell matches carry none (each call site says why).
 *  - what the owner typed (FIRE settings, goal targets and shares, home inputs) is an
 *    "assumption"; brackets and rates set by law are "law".
 *
 * Every figure is re-derived through the page's own code, never a copy: buildForecast +
 * firePlans + analyzeFire (FIRE), buildGoals on the forecast (Goals, as api/goals),
 * linkHome + the home budget model (Home budget, as the page), buildTaxReport with the
 * forecast link (Taxes, as api/tax). Typed inputs that live only in the page (FIRE's
 * unsaved settings, the home calculator's inputs) travel in the descriptor; the forecast's
 * own drivers are the saved ones.
 */

export type FireFigure =
  | "fire-number"
  | "lean-number"
  | "fat-number"
  | "coast-number"
  | "fi-year"
  | "fi-year-base"
  | "lean-year"
  | "fat-year"
  | "coast-year"
  | "savings-rate"
  /** The plan year one: take-home from base pay plus employer money (what FIRE › Levers runs the savings-rate chart on). */
  | "income"
  | "years-saved"
  /** The share of today's net worth that is liquid (FIRE › Playbook). */
  | "liquid-share"
  | "runway"
  | "progress"
  | "milestone"
  /** FIRE › Plan's long-term table: one cell (`row`, `col`). */
  | "plan-cell"
  /** FIRE › Plan's "Bridging to 59½" tiles (`metric`). */
  | "access"
  /** FIRE › Stress test's tiles (`metric`), at the yearly swings typed (`volatility`). */
  | "stress"
  /** FIRE › Overview's chart: one year's (`year`) plan net worth or FIRE, Lean, Fat or Coast number (`series`), nominal (lib/fire/fire.ts fireTargets). */
  | "target";
/** FIRE's own settings as the page has them (edited there, maybe unsaved). */
export type FireSettings = Pick<OutlookAssumptions, "walkAwayYear" | "withdrawalRate" | "stateTaxRate" | "retirementAge">;
export type GoalFigure = "current" | "target" | "to-go" | "lands" | "needed" | "spending";
/** `max-monthly`: housing a month at the most you can afford; `take-home`: salary after income tax, a year; `spending`: today's typical month outside housing. */
export type HomeFigure = "cash" | "salary" | "income-tax" | "gains-tax" | "max-price" | "max-monthly" | "take-home" | "spending" | "gain" | "lender-max" | "lender-income" | RentVsBuyFigure;
export type TaxFigure = "bonus-expected" | "projected-gross";

export type PlanningDescriptor =
  /** `milestone`: a FIRE milestone's id ("nw-100000000", "fi-0.5"). */
  | { report: "planning"; page: "fire"; figure: FireFigure; fire?: FireSettings; milestone?: string; row?: string; col?: string; metric?: AccessFigure | StressFigure; volatility?: number; year?: number; series?: FireTargetSeries }
  /** `goalId`: every figure but "spending" (the emergency fund's typical month). */
  | { report: "planning"; page: "goals"; figure: GoalFigure; goalId?: string }
  /** The page's typed inputs and funds choices. */
  | { report: "planning"; page: "home"; figure: HomeFigure; inputs?: Partial<HomeBudgetInputs>; funds?: Partial<FundsConfig> }
  | { report: "planning"; page: "taxes"; figure: TaxFigure; year: number; personId: string }
  /** The Mortgage page's saved inputs, as the page carries them (normalizeMortgageInputs); the links are put in on the server. */
  | { report: "planning"; page: "mortgage"; figure: MortgageFigure; inputs: MortgageInputs }
  /** The annual statement's whole-year estimate for the year in progress: one line (estimateFigures' id). */
  | { report: "planning"; page: "annual-estimate"; line: string };

const FIRE_FIGURES: FireFigure[] = ["fire-number", "lean-number", "fat-number", "coast-number", "fi-year", "fi-year-base", "lean-year", "fat-year", "coast-year", "savings-rate", "income", "years-saved", "liquid-share", "runway", "progress", "milestone", "plan-cell", "access", "stress", "target"];
const ACCESS_FIGURES: AccessFigure[] = ["liquid", "illiquid", "liquid-out", "access-year"];
const STRESS_FIGURES: StressFigure[] = ["p50", "p10", "p90", "by-fi"];
const GOAL_FIGURES: GoalFigure[] = ["current", "target", "to-go", "lands", "needed", "spending"];
const HOME_FIGURES: HomeFigure[] = ["cash", "salary", "income-tax", "gains-tax", "max-price", "max-monthly", "take-home", "spending", "gain", "lender-max", "lender-income", ...RENT_VS_BUY_FIGURES];
const TAX_FIGURES: TaxFigure[] = ["bonus-expected", "projected-gross"];

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function parsePlanningDescriptor(d: Record<string, unknown>): PlanningDescriptor | { error: string } {
  switch (d.page) {
    case "fire": {
      if (!FIRE_FIGURES.includes(d.figure as FireFigure)) return { error: `figure must be one of: ${FIRE_FIGURES.join(", ")}.` };
      let fire: FireSettings | undefined;
      if (d.fire != null) {
        const f = d.fire;
        if (!isObj(f) || !(f.walkAwayYear === null || (isNum(f.walkAwayYear) && Number.isInteger(f.walkAwayYear))) || !isNum(f.withdrawalRate) || !(f.stateTaxRate === null || isNum(f.stateTaxRate)) || !isNum(f.retirementAge))
          return { error: "fire must be { walkAwayYear, withdrawalRate, stateTaxRate, retirementAge }." };
        // Rates are shares, not percents: outside these the retirement-tax search has no answer.
        const within = (v: number | null, lo: number, hi: number) => v === null || (v >= lo && v <= hi);
        if (!within(f.withdrawalRate, 0, 1) || !within(f.stateTaxRate as number | null, 0, 0.5) || !within(f.retirementAge, 0, 120) || !within(f.walkAwayYear as number | null, 1900, 2300))
          return { error: "fire is out of range: withdrawalRate 0–1, stateTaxRate 0–0.5, retirementAge 0–120." };
        fire = { walkAwayYear: f.walkAwayYear as number | null, withdrawalRate: f.withdrawalRate, stateTaxRate: f.stateTaxRate as number | null, retirementAge: f.retirementAge };
      }
      if (d.figure === "milestone" && (typeof d.milestone !== "string" || !/^(nw-\d+|fi-0\.\d+)$/.test(d.milestone))) return { error: "milestone must be a milestone id (nw-<cents> or fi-<share>)." };
      const id = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 80;
      if (d.figure === "plan-cell" && (!id(d.row) || !id(d.col))) return { error: "row and col must name a cell of the long-term table." };
      if (d.figure === "access" && !ACCESS_FIGURES.includes(d.metric as AccessFigure)) return { error: `metric must be one of: ${ACCESS_FIGURES.join(", ")}.` };
      if (d.figure === "target" && (!isNum(d.year) || !Number.isInteger(d.year) || !FIRE_TARGET_SERIES.includes(d.series as FireTargetSeries))) return { error: `year must be a year, and series one of: ${FIRE_TARGET_SERIES.join(", ")}.` };
      if (d.figure === "stress" && (!STRESS_FIGURES.includes(d.metric as StressFigure) || !isNum(d.volatility) || d.volatility < 0 || d.volatility > 1)) return { error: `metric must be one of: ${STRESS_FIGURES.join(", ")}, and volatility a rate.` };
      return {
        report: "planning",
        page: "fire",
        figure: d.figure as FireFigure,
        ...(fire ? { fire } : {}),
        ...(d.figure === "milestone" ? { milestone: d.milestone as string } : {}),
        ...(d.figure === "plan-cell" ? { row: d.row as string, col: d.col as string } : {}),
        ...(d.figure === "access" ? { metric: d.metric as AccessFigure } : {}),
        ...(d.figure === "stress" ? { metric: d.metric as StressFigure, volatility: d.volatility as number } : {}),
        ...(d.figure === "target" ? { year: d.year as number, series: d.series as FireTargetSeries } : {}),
      };
    }
    case "goals":
      if (!GOAL_FIGURES.includes(d.figure as GoalFigure)) return { error: `figure must be one of: ${GOAL_FIGURES.join(", ")}.` };
      if (d.figure !== "spending" && (typeof d.goalId !== "string" || !d.goalId)) return { error: "goalId must be a goal's id." };
      return { report: "planning", page: "goals", figure: d.figure as GoalFigure, ...(d.figure !== "spending" ? { goalId: d.goalId as string } : {}) };
    case "home": {
      if (!HOME_FIGURES.includes(d.figure as HomeFigure)) return { error: `figure must be one of: ${HOME_FIGURES.join(", ")}.` };
      if ((d.inputs != null && !isObj(d.inputs)) || (d.funds != null && !isObj(d.funds))) return { error: "inputs and funds must be objects." };
      const defaults = defaultHomeBudgetInputs();
      const inputs = Object.fromEntries(Object.entries(d.inputs ?? {}).filter(([k, v]) => k in defaults && isNum(v))) as Partial<HomeBudgetInputs>;
      const f = (d.funds ?? {}) as Record<string, unknown>;
      const funds: Partial<FundsConfig> = {};
      if (f.mode === "networth" || f.mode === "manual") funds.mode = f.mode;
      if (isNum(f.share)) funds.share = f.share;
      if (f.buyAt === null || (typeof f.buyAt === "string" && /^\d{4}-\d{2}$/.test(f.buyAt))) funds.buyAt = f.buyAt as string | null;
      if (f.salary === "forecast" || f.salary === "manual") funds.salary = f.salary;
      if (f.incomeTax === "engine" || f.incomeTax === "manual") funds.incomeTax = f.incomeTax;
      if (f.gainsTax === "engine" || f.gainsTax === "manual") funds.gainsTax = f.gainsTax;
      if (typeof f.lenderBonus === "boolean") funds.lenderBonus = f.lenderBonus;
      if (f.returns === "forecast" || f.returns === "manual") funds.returns = f.returns;
      return { report: "planning", page: "home", figure: d.figure as HomeFigure, inputs, funds };
    }
    case "taxes":
      if (!TAX_FIGURES.includes(d.figure as TaxFigure)) return { error: `figure must be one of: ${TAX_FIGURES.join(", ")}.` };
      if (!isNum(d.year) || !Number.isInteger(d.year)) return { error: "year must be a year." };
      if (typeof d.personId !== "string" || !d.personId) return { error: "personId must be an id." };
      return { report: "planning", page: "taxes", figure: d.figure as TaxFigure, year: d.year, personId: d.personId };
    case "annual-estimate":
      if (typeof d.line !== "string" || !/^[a-z-]+(:[A-Za-z0-9_-]{1,80})?$/.test(d.line)) return { error: "line must name a line of the estimate column." };
      return { report: "planning", page: "annual-estimate", line: d.line };
    case "mortgage":
      if (!MORTGAGE_FIGURES.includes(d.figure as MortgageFigure)) return { error: `figure must be one of: ${MORTGAGE_FIGURES.join(", ")}.` };
      if (!isObj(d.inputs)) return { error: "inputs must be the Mortgage page's inputs." };
      return { report: "planning", page: "mortgage", figure: d.figure as MortgageFigure, inputs: normalizeMortgageInputs(d.inputs) };
  }
  return { error: "page must be fire, goals, home, taxes, mortgage or annual-estimate." };
}

// ---------------------------------------------------------------------------


export async function buildPlanningProof(ctx: ProofContext, d: PlanningDescriptor): Promise<Proof> {
  const { book } = ctx;
  const base = { report: "planning" as const, descriptor: d, today: book.today };
  let built: Built;
  let b: Base | null = null;
  if (d.page === "fire") {
    const data = await perBook(ctx, "forecast-data", () => loadForecastData(ctx.db, book));
    const c = fireCtx(book, data, d.fire);
    b = c;
    built = c ? buildFire(c, d) : withheldProof(book, data);
  } else if (d.page === "goals") {
    const c = await goalsCtx(ctx);
    b = c.b;
    built = buildGoal(c, d);
  } else if (d.page === "home") {
    const c = await homeCtx(ctx, d);
    b = c.b;
    built = buildHome(c);
  } else if (d.page === "mortgage") built = await buildMortgage(ctx, d);
  else if (d.page === "annual-estimate") ({ built, b } = await buildAnnualEstimate(ctx, d));
  else built = await buildTaxes(ctx, d);
  built = { ...built, blocks: linkCells(b, built.blocks) };
  return { ...base, checks: [], withheld: false, ...built, through: built.through || book.horizon.netWorth };
}

export const planningKind: ProofKind<PlanningDescriptor> = {
  report: "planning",
  parse: parsePlanningDescriptor,
  build: buildPlanningProof,
};

