import { addDays, daysBetween } from "../../dates/isoDate.ts";
import { analyzeFire, drawFor, extended, FAT_SHARE, fireNumber, firePlans, LEAN_SHARE, livingIn, type FireAnalysis } from "../../fire/fire.ts";
import { formatPercentRatio, formatUsdFromCents } from "../../formatMoney.ts";
import { balancesAt, buildForecast, homeForecast, milestones as netWorthMilestones, taxLink, type Forecast } from "../../forecast/forecast.ts";
import { forecastInputs, loadForecastData, type ForecastData } from "../../forecast/load.ts";
import { monthPeriods, yearPeriods } from "../../forecast/periods.ts";
import { GOALS_KEY, normalizeGoals } from "../../goals/settings.ts";
import { computeLenderMax, computeMaxApproval, defaultHomeBudgetInputs, monthlyPaymentOnLoan, type HomeBudgetInputs, type MaxApprovalResult } from "../../home-budget/homeBudgetModel.ts";
import { defaultFunds, linkHome, type FundsBook, type FundsConfig, type HomeLinked } from "../../home-budget/homeLinked.ts";
import { employerKey } from "../../ingest/payroll/types.ts";
import { taxOnPay, type OutlookSeeds, type PayForTax } from "../../profile/basePay.ts";
import { projectOutlook, retirementTax, walkAwayTable, type OutlookPlan, type WalkAwayRow } from "../../profile/outlook.ts";
import { type LivingBasis, type OutlookAssumptions } from "../../profile/settings.ts";
import { loadJsonSetting } from "../../settingsStore.ts";
import { buildTaxReport, type PersonReport } from "../../tax/buildTaxReport.ts";
import { TAX_YEARS } from "../../tax/params.ts";
import type { Book } from "../load.ts";
import { buildGoals, goalForecastOf, type GoalProgress, type GoalsReport } from "../reports/goals.ts";
import { buildHomeFunds, buildHomeSpending } from "../reports/homeFunds.ts";
import type { BonusesDescriptor } from "./bonusesProof.ts";
import { CASH_FLOW_CHECKS } from "./cashFlowProof.ts";
import { checksFor, perBook, sumCheck } from "./common.ts";
import { ledgerValue, type ForecastDescriptor, type LedgerLine } from "./forecastProof.ts";
import { NET_WORTH_CHECKS, type NetWorthDescriptor } from "./netWorthProof.ts";
import { PAY_CHECKS, type PayDescriptor } from "./payProof.ts";
import type { TaxEstimateDescriptor } from "./taxEstimateProof.ts";
import type { ChainLine, Proof, ProofBlock, ProofCheck, ProofContext, ProofEstimate, ProofKind, ProofLink, ProofValue } from "./types.ts";

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
  | "years-saved"
  | "runway"
  | "progress"
  | "milestone";
/** FIRE's own settings as the page has them (edited there, maybe unsaved). */
export type FireSettings = Pick<OutlookAssumptions, "walkAwayYear" | "withdrawalRate" | "stateTaxRate" | "retirementAge">;
export type GoalFigure = "current" | "target" | "to-go" | "lands" | "needed" | "spending";
export type HomeFigure = "cash" | "salary" | "income-tax" | "gains-tax" | "max-price" | "lender-max" | "lender-income";
export type TaxFigure = "bonus-expected" | "projected-gross";

export type PlanningDescriptor =
  /** `milestone`: a FIRE milestone's id ("nw-100000000", "fi-0.5"). */
  | { report: "planning"; page: "fire"; figure: FireFigure; fire?: FireSettings; milestone?: string }
  /** `goalId`: every figure but "spending" (the emergency fund's typical month). */
  | { report: "planning"; page: "goals"; figure: GoalFigure; goalId?: string }
  /** The page's typed inputs and funds choices. */
  | { report: "planning"; page: "home"; figure: HomeFigure; inputs?: Partial<HomeBudgetInputs>; funds?: Partial<FundsConfig> }
  | { report: "planning"; page: "taxes"; figure: TaxFigure; year: number; personId: string };

const FIRE_FIGURES: FireFigure[] = ["fire-number", "lean-number", "fat-number", "coast-number", "fi-year", "fi-year-base", "lean-year", "fat-year", "coast-year", "savings-rate", "years-saved", "runway", "progress", "milestone"];
const GOAL_FIGURES: GoalFigure[] = ["current", "target", "to-go", "lands", "needed", "spending"];
const HOME_FIGURES: HomeFigure[] = ["cash", "salary", "income-tax", "gains-tax", "max-price", "lender-max", "lender-income"];
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
        fire = { walkAwayYear: f.walkAwayYear as number | null, withdrawalRate: f.withdrawalRate, stateTaxRate: f.stateTaxRate as number | null, retirementAge: f.retirementAge };
      }
      if (d.figure === "milestone" && (typeof d.milestone !== "string" || !/^(nw-\d+|fi-0\.\d+)$/.test(d.milestone))) return { error: "milestone must be a milestone id (nw-<cents> or fi-<share>)." };
      return { report: "planning", page: "fire", figure: d.figure as FireFigure, ...(fire ? { fire } : {}), ...(d.figure === "milestone" ? { milestone: d.milestone as string } : {}) };
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
      return { report: "planning", page: "home", figure: d.figure as HomeFigure, inputs, funds };
    }
    case "taxes":
      if (!TAX_FIGURES.includes(d.figure as TaxFigure)) return { error: `figure must be one of: ${TAX_FIGURES.join(", ")}.` };
      if (!isNum(d.year) || !Number.isInteger(d.year)) return { error: "year must be a year." };
      if (typeof d.personId !== "string" || !d.personId) return { error: "personId must be an id." };
      return { report: "planning", page: "taxes", figure: d.figure as TaxFigure, year: d.year, personId: d.personId };
  }
  return { error: "page must be fire, goals, home or taxes." };
}

// --------------------------------------------------------------------------- shared

const money = (c: number) => (c === 0 ? "$0.00" : formatUsdFromCents(c));
const pct = (r: number, digits = 2) => formatPercentRatio(r, digits);
const cents = (dollars: number) => Math.round(dollars * 100);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Mar 2031" from YYYY-MM(-DD). */
const monthWord = (key: string) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
/** The month before YYYY-MM. */
const prevKey = (key: string) => {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};
const LIVING: LivingBasis[] = ["TRAILING_12", "LAST_YEAR", "THIS_YEAR"];

/** A signed adjustment as a chain line: "+" or "−" by its sign, the value shown positive. */
const signed = (c: number, line: Omit<ChainLine, "op" | "value">): ChainLine => ({ ...line, op: c < 0 ? "−" : "+", value: { cents: Math.abs(c) } });

/** A forecast ledger cell: a line over the months `month` through `through` (one month when omitted). */
type MonthCell = { month: string; through?: string; line: LedgerLine };
type CellDescriptor = Extract<ForecastDescriptor, { figure: "month" }>;
const cellDescriptor = (c: MonthCell): CellDescriptor => ({ report: "forecast", figure: "month", month: c.month, ...(c.through && c.through !== c.month ? { through: c.through } : {}), line: c.line });
/** A forecast year's column, Jan–Dec. */
const yearCell = (year: number, line: LedgerLine): MonthCell => ({ month: `${year}-01`, through: `${year}-12`, line });

/** A projected line waiting for its cell's link (see `linkCells`). */
type Projected = ChainLine & { cell?: MonthCell };

/**
 * A projected value: the forecast's figure for a future month (or year), an estimate.
 * `cell` is the forecast ledger cell it is, or null when no ledger line holds it (the
 * caller says why); `linkCells` links it once the cell is checked to hold this value.
 */
function projected(op: ChainLine["op"], label: string, value: number, cell: MonthCell | null, note: string): Projected {
  return { ...(op ? { op } : {}), label, value: { cents: value }, source: "estimate", note, ...(cell ? { cell } : {}) };
}

/**
 * Each projected line's link to its forecast ledger cell, read the way the forecast proof
 * reads it (the saved forecast's year and month columns, periods.ts, as forecastProof's
 * columnsOf): only a cell holding exactly the line's value is linked, so a link never opens
 * a different number (a year past the forecast's horizon, a plan the forecast doesn't run).
 */
function linkCells(b: Base | null, blocks: ProofBlock[]): ProofBlock[] {
  const cols = new Map<number, ReturnType<typeof yearPeriods>>();
  const valueOf = (c: MonthCell): number | null => {
    if (!b) return null;
    const year = Number(c.month.slice(0, 4));
    if (!cols.has(year)) cols.set(year, [...yearPeriods(b.saved, b.data.profile, { actualYears: b.data.profile.years.length, throughYear: year }), ...monthPeriods(b.saved, b.data.profile, year)]);
    const col = cols.get(year)!.find((p) => p.from === c.month && p.through.slice(0, 7) === (c.through ?? c.month));
    return col ? ledgerValue(col.flows, c.line) : null;
  };
  return blocks.map((bl) =>
    bl.kind !== "chain"
      ? bl
      : {
          ...bl,
          lines: bl.lines.map((l: Projected) => {
            const { cell, ...line } = l;
            if (!cell || !("cents" in line.value)) return line;
            const v = valueOf(cell);
            return v != null && v === line.value.cents ? { ...line, link: { label: `Forecast ledger, ${monthWord(cell.month)}${cell.through && cell.through !== cell.month ? ` – ${monthWord(cell.through)}` : ""}`, descriptor: cellDescriptor(cell) } } : line;
          }),
        },
  );
}

const seedLink = (label: string, descriptor: ForecastDescriptor): ProofLink => ({ label, descriptor });
const START = seedLink("The forecast's starting point", { report: "forecast", figure: "seed", which: "start" });

type Built = Omit<Proof, "report" | "descriptor" | "today" | "checks" | "withheld"> & { checks?: ProofCheck[]; withheld?: boolean };

/** What every forecast-fed figure stands on: the Book, the forecast's data and the forecast on the saved drivers (FIRE's settings put in). */
type Base = { book: Book; data: ForecastData; seeds: OutlookSeeds; a: OutlookAssumptions; f: Forecast; saved: Forecast };

function baseFrom(book: Book, data: ForecastData, patch: Partial<OutlookAssumptions> = {}): Base | null {
  const inputs = forecastInputs(data);
  if (!inputs) return null;
  const a = { ...data.profile.settings.outlook, ...patch };
  const f = buildForecast(inputs, a);
  // The forecast on the saved drivers, as the forecast ledger's cells are read (FIRE's own settings don't move a working month, but a cell is checked against this).
  return { book, data, seeds: inputs.seeds, a, f, saved: Object.keys(patch).length ? buildForecast(inputs, data.profile.settings.outlook) : f };
}

function withheldProof(book: Book, data: ForecastData): Built {
  return {
    describes: "The forecast's starting point isn't proven",
    figure: { text: "Withheld" },
    selfCheck: null,
    withheld: true,
    blocks: [{ kind: "breakdown", title: "What withholds it", items: data.profile.seedBlockers.map((b) => ({ label: b.title, value: { text: b.status } })) }],
    estimates: [],
    through: book.horizon.netWorth,
  };
}

const startNetWorth = (b: Base) => b.f.plan.start.liquid + b.f.plan.start.illiquid;

function startLine(b: Base, op?: ChainLine["op"]): ChainLine {
  return { ...(op ? { op } : {}), label: `Net worth at the end of ${b.seeds.start.asOf}`, value: { cents: startNetWorth(b) }, source: "proven", note: "The latest proven balances: where the forecast starts.", link: START };
}

/** The forecast's living cost a year: typed on the Forecast page, or a seed read off Cash flow. */
function livingLine(b: Base, op?: ChainLine["op"], label = "Living cost a year"): ChainLine {
  const l = b.f.pay.living;
  const basis = LIVING.find((x) => b.seeds.living[x] === l.seed);
  if (l.typed || !basis) return { ...(op ? { op } : {}), label: `${label} (typed on the Forecast page)`, value: { cents: l.cents }, source: "assumption" };
  return { ...(op ? { op } : {}), label: `${label} (${l.seed!.label.toLowerCase()})`, value: { cents: l.cents }, source: "derived", note: "Cash flow's spending less taxes, one-offs and reimbursements.", link: seedLink("Living cost", { report: "forecast", figure: "seed", which: "living", basis }) };
}

/** The forecast's drivers a projection rests on. */
function driversBlock(b: Base, extra: ChainLine[] = []): ProofBlock {
  const a = b.a;
  return {
    kind: "chain",
    title: "The forecast it runs on",
    lines: [
      startLine(b),
      { label: "Household base salary", value: { cents: b.f.pay.salary }, source: "derived", link: seedLink("Kept after tax", { report: "forecast", figure: "seed", which: "take-home" }), note: `Kept after tax: ${pct(b.f.pay.takeHomeRate)}.` },
      livingLine(b),
      { label: "Bonuses", value: { text: "paid, from letters, estimated" }, source: "derived", link: seedLink("Bonuses", { report: "forecast", figure: "seed", which: "bonus" }) },
      { label: "Raise / yr", value: { ratio: a.salaryGrowth }, source: "assumption" },
      { label: "Living growth / yr", value: { ratio: a.livingGrowth }, source: "assumption" },
      { label: "Return / yr", value: { ratio: a.returnRate }, source: "assumption", link: seedLink("Realized return", { report: "forecast", figure: "seed", which: "return" }) },
      { label: "Inflation / yr", value: { ratio: a.inflation }, source: "assumption" },
      ...extra,
    ],
    note: "The forecast's drivers as saved on the Forecast page.",
  };
}

const forecastChecks = (b: Base) => checksFor(b.book, { affects: "NET_WORTH", from: b.seeds.start.asOf, to: b.seeds.start.asOf }, NET_WORTH_CHECKS);

const projectionEstimate = (b: Base): ProofEstimate => ({
  id: "planning.forecast",
  title: `Months after ${b.seeds.start.asOf} are the forecast's projection`,
  detail: "Pay, bonuses, living cost and returns on the saved drivers; nothing after the latest proven balances is read off a statement.",
});

// --------------------------------------------------------------------------- FIRE

type FireCtx = Base & { plans: ReturnType<typeof firePlans>; fa: FireAnalysis; fire: FireSettings };

function fireCtx(book: Book, data: ForecastData, fire?: FireSettings): FireCtx | null {
  const saved = data.profile.settings.outlook;
  const s: FireSettings = fire ?? { walkAwayYear: saved.walkAwayYear, withdrawalRate: saved.withdrawalRate, stateTaxRate: saved.stateTaxRate, retirementAge: saved.retirementAge };
  const b = baseFrom(book, data, s);
  if (!b) return null;
  // As FireClient: the forecast, FIRE's two plans, the analysis.
  const plans = firePlans(b.f);
  const fa = analyzeFire(plans.full, plans.base, { asOf: b.seeds.start.asOf, retirementAge: b.a.retirementAge });
  return { ...b, plans, fa, fire: s };
}

const fireLink = (c: FireCtx, label: string, figure: FireFigure): ProofLink => ({ label, descriptor: { report: "planning", page: "fire", figure, fire: c.fire } });

function fireSettingsBlock(c: FireCtx): ProofBlock {
  return {
    kind: "chain",
    title: "FIRE settings",
    lines: [
      { label: "Withdrawal rate", value: { ratio: c.fire.withdrawalRate }, source: "assumption", note: "Of Jan 1 net worth." },
      { label: "State tax on draws", value: c.fire.stateTaxRate == null ? { text: "Connecticut's brackets" } : { ratio: c.fire.stateTaxRate }, source: c.fire.stateTaxRate == null ? "law" : "assumption" },
      { label: "Walk-away year", value: { text: c.fire.walkAwayYear == null ? "keep working" : String(c.fire.walkAwayYear) }, source: "assumption" },
      { label: "Retirement age (Coast target)", value: { text: String(c.fire.retirementAge) }, source: "assumption" },
      { label: "Federal brackets and standard deduction", value: { text: String(c.plans.full.tax.year) }, source: "law", note: `Married filing jointly; indexed by inflation (${pct(c.plans.full.inflation)}) each year after ${c.plans.full.tax.year}.` },
    ],
    note: "As set on the FIRE page (saved or not).",
  };
}

/** The draw whose after-tax income pays `spending` in `year`, ÷ the withdrawal rate. */
function fireNumberBlocks(c: FireCtx, plan: OutlookPlan, year: number, spending: number, title: string): { blocks: ProofBlock[]; number: number; parts: number } {
  const draw = drawFor(plan, year, spending);
  const t = retirementTax(plan, year, draw);
  const number = fireNumber(plan, year, spending);
  return {
    number,
    parts: Math.ceil(draw / plan.withdrawalRate),
    blocks: [
      {
        kind: "chain",
        title: `The draw that pays ${money(spending)} after tax`,
        lines: [
          { label: `Pre-tax draw in ${year}`, value: { cents: draw }, source: "derived", note: "The smallest draw whose after-tax income covers the spending." },
          { op: "−", label: "Federal income tax", value: { cents: t.federal }, source: "law", note: `On ${money(t.taxable)} after the standard deduction.` },
          { op: "−", label: plan.stateTaxRate == null ? "Connecticut income tax (its brackets)" : `State tax (${pct(plan.stateTaxRate)} of the taxable draw)`, value: { cents: t.state }, source: plan.stateTaxRate == null ? "law" : "derived" },
          { op: "=", label: "After-tax income", value: { cents: t.afterTax }, source: "derived", note: `Covers ${money(spending)}.` },
        ],
      },
      {
        kind: "chain",
        title,
        lines: [
          { label: "Pre-tax draw", value: { cents: draw }, source: "derived" },
          { op: "÷", label: "Withdrawal rate", value: { ratio: plan.withdrawalRate }, source: "assumption" },
          { op: "=", label: title, value: { cents: number }, source: "derived", note: "Rounded up to the cent." },
        ],
      },
    ],
  };
}

function fireNumberProof(c: FireCtx, which: "fire" | "lean" | "fat"): Built {
  const plan = c.plans.full;
  const y0 = plan.start.year;
  const living0 = c.fa.now.livingCost;
  const share = which === "lean" ? LEAN_SHARE : which === "fat" ? FAT_SHARE : 1;
  const spending = which === "fire" ? living0 : Math.round(living0 * share);
  const word = { fire: "FIRE number", lean: "Lean FIRE number", fat: "Fat FIRE number" }[which];
  const page = which === "fire" ? c.fa.now.fireNumber : which === "lean" ? c.fa.now.leanNumber : c.fa.now.fatNumber;
  const costLines: ChainLine[] = [livingLine(c, undefined, `Living cost in ${y0}`)];
  if (which !== "fire") costLines.push({ op: "×", label: `${which === "lean" ? "Lean" : "Fat"} FIRE's share of it`, value: { ratio: share }, source: "derived", note: "The page's definition." }, { op: "=", label: "Spending to cover", value: { cents: spending }, source: "derived" });
  const n = fireNumberBlocks(c, plan, y0, spending, word);
  const { checks, withheld } = forecastChecks(c);
  return {
    describes: `${word}: the net worth whose draw covers ${which === "fire" ? "living cost" : `${share * 100}% of living cost`} after tax`,
    figure: { cents: page },
    selfCheck: sumCheck(page, n.parts, `${money(drawFor(plan, y0, spending))} ÷ ${pct(plan.withdrawalRate)} rounds up to ${money(n.parts)}`),
    blocks: [{ kind: "chain", title: "What a year costs", lines: costLines }, ...n.blocks, fireSettingsBlock(c)],
    checks,
    withheld,
    estimates: [],
    through: c.seeds.start.asOf,
  };
}

/** One year's walk-away row as a chain: Jan 1 net worth × the withdrawal rate, after tax, against that year's living cost. */
function walkRowBlock(c: FireCtx, plan: OutlookPlan, row: WalkAwayRow, need: number, title: string, forecastMonths: boolean): ProofBlock {
  const dec = `${row.year - 1}-12`;
  return {
    kind: "chain",
    title,
    lines: [
      // The no-bonus plan is FIRE's own run, not the forecast: no ledger cell holds its net worth.
      forecastMonths
        ? projected(undefined, `Net worth on Jan 1, ${row.year}`, row.netWorth, { month: dec, line: "netWorth" }, `The forecast's net worth at the end of ${monthWord(dec)}.`)
        : projected(undefined, `Net worth on Jan 1, ${row.year}`, row.netWorth, null, `The forecast with every bonus left out, at the end of ${monthWord(dec)}.`),
      { op: "×", label: "Withdrawal rate", value: { ratio: plan.withdrawalRate }, source: "assumption" },
      { op: "=", label: "Draw", value: { cents: row.draw }, source: "derived" },
      { op: "−", label: "Federal income tax", value: { cents: row.federalTax }, source: "law" },
      { op: "−", label: plan.stateTaxRate == null ? "Connecticut income tax (its brackets)" : `State tax (${pct(plan.stateTaxRate)})`, value: { cents: row.stateTax }, source: plan.stateTaxRate == null ? "law" : "derived" },
      { op: "=", label: "Walk-away income after tax", value: { cents: row.afterTaxIncome }, source: "derived" },
      projected("÷", `Living cost in ${row.year}`, row.livingCost, yearCell(row.year, "living"), `Grown by ${pct(plan.livingGrowth)} a year from the start.`),
      { op: "=", label: `Covered (${need >= 1 ? `${need * 100}%` : `${need * 100}%`} needed)`, value: { ratio: row.coverage ?? 0 }, source: "derived" },
    ],
  };
}

function fiYearProof(c: FireCtx, flavor: "fi" | "base" | "lean" | "fat"): Built {
  const plan = flavor === "base" ? c.plans.base : c.plans.full;
  const need = flavor === "lean" ? LEAN_SHARE : flavor === "fat" ? FAT_SHARE : 1;
  // The same tables analyzeFire reads: the full plan's rows, or the no-bonus plan's walk-away table.
  const rows: WalkAwayRow[] = flavor === "base" ? walkAwayTable(extended(plan)) : c.fa.rows;
  const row = flavor === "fi" ? c.fa.fi : flavor === "base" ? c.fa.fiBase : flavor === "lean" ? c.fa.lean : c.fa.fat;
  const word = { fi: "Financially independent", base: "Financially independent with no bonuses", lean: "Lean FIRE", fat: "Fat FIRE" }[flavor];
  const nowNumber = flavor === "lean" ? c.fa.now.leanNumber : flavor === "fat" ? c.fa.now.fatNumber : c.fa.now.fireNumber;
  const reachedNow = (flavor === "lean" || flavor === "fat") && c.fa.now.netWorth >= nowNumber;
  const blocks: ProofBlock[] = [];
  let figure: ProofValue;
  if (reachedNow) {
    figure = { text: "Now" };
    blocks.push({
      kind: "chain",
      title: "Reached already",
      lines: [startLine(c), { label: `${flavor === "lean" ? "Lean" : "Fat"} FIRE number today`, value: { cents: nowNumber }, source: "derived", note: "Net worth is at or past it.", link: fireLink(c, "The number", flavor === "lean" ? "lean-number" : "fat-number") }],
    });
  } else {
    figure = { text: row ? String(row.year) : "Not in 60 yrs" };
    if (row) blocks.push(walkRowBlock(c, plan, rows.find((r) => r.year === row.year) ?? row, need, `Walking away on Jan 1, ${row.year}`, flavor !== "base"));
    const before = row ? rows.find((r) => r.year === row.year - 1) : rows.at(-1);
    if (before) blocks.push(walkRowBlock(c, plan, before, need, row ? `A year earlier, ${before.year}: not yet` : `Still short in ${before.year}, the last year looked at`, flavor !== "base"));
  }
  if (flavor === "base") blocks.push({ kind: "chain", title: "No bonuses", lines: [{ label: "Every bonus (paid, scheduled and estimated)", value: { cents: 0 }, source: "derived", note: "Left out to show what base pay alone does." }] });
  blocks.push(driversBlock(c), fireSettingsBlock(c));
  const { checks, withheld } = forecastChecks(c);
  return {
    describes: `${word}: the first year walk-away income covers ${need === 1 ? "living cost" : `${need * 100}% of living cost`}`,
    figure,
    selfCheck: null,
    blocks,
    checks,
    withheld,
    estimates: [projectionEstimate(c)],
    through: c.seeds.start.asOf,
  };
}

function coastNumberProof(c: FireCtx): Built {
  const plan = c.plans.full;
  const y0 = plan.start.year;
  const retire = c.fa.retireYear;
  const { checks, withheld } = forecastChecks(c);
  if (retire == null || c.fa.now.coastNumber == null)
    return { describes: "Coast FIRE number", figure: { text: "Needs age" }, selfCheck: null, blocks: [{ kind: "chain", title: "Coast FIRE", lines: [{ label: "Birth year", value: { text: "not set" }, source: "assumption", note: "Add birth years in Settings › Household." }] }], checks, withheld, estimates: [], through: c.seeds.start.asOf };
  const living = livingIn(plan, retire);
  const n = fireNumberBlocks(c, plan, retire, living, `FIRE number in ${retire}`);
  const years = retire - y0;
  const coast = c.fa.now.coastNumber;
  return {
    describes: `Coast FIRE number: invested today, returns alone reach the FIRE number by ${retire}`,
    figure: { cents: coast },
    selfCheck: sumCheck(coast, Math.round(n.number / (1 + plan.returnRate) ** years), `${money(n.number)} ÷ (1 + ${pct(plan.returnRate)})^${years} rounds to ${money(Math.round(n.number / (1 + plan.returnRate) ** years))}`),
    blocks: [
      {
        kind: "chain",
        title: `Living cost in ${retire}`,
        lines: [
          livingLine(c, undefined, `Living cost in ${y0}`),
          { op: "×", label: `(1 + living growth)^${years}`, value: { ratio: (1 + plan.livingGrowth) ** years }, source: "assumption", note: `${pct(plan.livingGrowth)} a year.` },
          { op: "=", label: `Living cost in ${retire}`, value: { cents: living }, source: "estimate" },
        ],
        note: `${retire} = birth year ${plan.birthYear} + retirement age ${c.fire.retirementAge}.`,
      },
      ...n.blocks,
      {
        kind: "chain",
        title: "Back to today",
        lines: [
          { label: `FIRE number in ${retire}`, value: { cents: n.number }, source: "derived" },
          { op: "÷", label: `(1 + return)^${years}`, value: { ratio: (1 + plan.returnRate) ** years }, source: "assumption", note: `${pct(plan.returnRate)} a year.` },
          { op: "=", label: "Coast FIRE number today", value: { cents: coast }, source: "derived" },
        ],
      },
      fireSettingsBlock(c),
    ],
    checks,
    withheld,
    estimates: [],
    through: c.seeds.start.asOf,
  };
}

function coastYearProof(c: FireCtx): Built {
  const { now, coast, rows } = c.fa;
  const { checks, withheld } = forecastChecks(c);
  const reached = now.coastNumber != null && now.netWorth >= now.coastNumber;
  const blocks: ProofBlock[] = [];
  const rowBlock = (r: (typeof rows)[number], title: string): ProofBlock => ({
    kind: "chain",
    title,
    lines: [
      projected(undefined, `Net worth on Jan 1, ${r.year}`, r.netWorth, { month: `${r.year - 1}-12`, line: "netWorth" }, `The forecast's net worth at the end of Dec ${r.year - 1}.`),
      { label: `Coast FIRE number in ${r.year}`, value: { cents: r.coastNumber ?? 0 }, source: "derived", note: `The FIRE number in ${c.fa.retireYear} discounted at the return.` },
    ],
  });
  if (reached) blocks.push({ kind: "chain", title: "Reached already", lines: [startLine(c), { label: "Coast FIRE number today", value: { cents: now.coastNumber! }, source: "derived", link: fireLink(c, "Coast FIRE number", "coast-number") }] });
  else if (coast) {
    blocks.push(rowBlock(coast, `${coast.year}: net worth reaches it`));
    const before = rows.find((r) => r.year === coast.year - 1);
    if (before) blocks.push(rowBlock(before, `${before.year}: not yet`));
  }
  blocks.push({ kind: "chain", title: "Coast FIRE today", lines: [{ label: "Coast FIRE number", value: now.coastNumber != null ? { cents: now.coastNumber } : { text: "needs a birth year" }, source: "derived", link: fireLink(c, "Coast FIRE number", "coast-number") }] }, driversBlock(c), fireSettingsBlock(c));
  return {
    describes: "Coast FIRE: the first year net worth reaches that year's Coast FIRE number",
    figure: { text: reached ? "Reached" : coast ? String(coast.year) : c.plans.full.birthYear == null ? "Needs age" : "—" },
    selfCheck: null,
    blocks,
    checks,
    withheld,
    estimates: [projectionEstimate(c)],
    through: c.seeds.start.asOf,
  };
}

function savingsRateProof(c: FireCtx): Built {
  const y = c.fa.projection.find((p) => p.months === 12 && p.working);
  const { checks, withheld } = forecastChecks(c);
  if (!y || c.fa.savingsRate == null) return { describes: "Savings rate", figure: { text: "—" }, selfCheck: null, blocks: [], checks, withheld, estimates: [], through: c.seeds.start.asOf };
  const yr = (line: LedgerLine) => yearCell(y.year, line);
  const sum = `The forecast's ${y.year}, Jan–Dec.`;
  const income = y.takeHome + y.employerMatch + y.bonusKept;
  const bonusSpent = y.bonusKept - y.bonusSaved;
  const parts = income - y.livingCost - y.planned - bonusSpent;
  return {
    describes: `Savings rate in ${y.year}, the first full working year of the plan`,
    figure: { ratio: c.fa.savingsRate },
    selfCheck: sumCheck(y.saved, parts, `Income less living cost, one-offs and bonus spent comes to ${money(parts)} saved`),
    blocks: [
      {
        kind: "chain",
        title: `What ${y.year} brings in and saves`,
        lines: [
          // The ledger has no take-home line (its taxes line nets bonus tax in), so no cell holds it.
          projected(undefined, "Take-home from base pay", y.takeHome, null, sum),
          projected("+", "Employer 401(k) and HSA money", y.employerMatch, yr("employer"), sum),
          // The ledger shows bonus gross and bonus spent, not bonus kept: no cell holds it.
          projected("+", "Bonus kept after tax", y.bonusKept, null, sum),
          { op: "=", label: "Income", value: { cents: income }, source: "derived" },
          projected("−", "Living cost", y.livingCost, yr("living"), sum),
          projected("−", "Planned one-offs", y.planned, yr("oneOffs"), `Typed on the Forecast page. ${sum}`),
          projected("−", "Bonus spent (kept, not saved)", bonusSpent, yr("bonusSpent"), sum),
          { op: "=", label: "Saved incl. retirement", value: { cents: y.saved }, source: "derived" },
          { op: "÷", label: "Income", value: { cents: income }, source: "derived" },
          { op: "=", label: "Savings rate", value: { ratio: c.fa.savingsRate }, source: "derived" },
        ],
      },
      driversBlock(c),
    ],
    checks,
    withheld,
    estimates: [projectionEstimate(c)],
    through: c.seeds.start.asOf,
  };
}

function ratioOfNowProof(c: FireCtx, which: "years-saved" | "runway" | "progress"): Built {
  const { now } = c.fa;
  const { checks, withheld } = forecastChecks(c);
  const liquid: ChainLine = { label: `Liquid money at the end of ${c.seeds.start.asOf}`, value: { cents: now.liquid }, source: "proven", note: "Cash and taxable investments, less card balances.", link: START };
  const [top, bottom, value, word] =
    which === "years-saved"
      ? [startLine(c), livingLine(c, "÷"), now.yearsOfSpending, "Years of spending saved"]
      : which === "runway"
        ? [liquid, livingLine(c, "÷"), now.liquidYears, "Runway (liquid)"]
        : [startLine(c), { op: "÷" as const, label: "FIRE number", value: { cents: now.fireNumber }, source: "derived" as const, link: fireLink(c, "FIRE number", "fire-number") }, now.progress, "Progress to financial independence"];
  return {
    describes: word,
    figure: which === "progress" ? { ratio: value } : { text: value.toFixed(1) },
    selfCheck: null,
    blocks: [{ kind: "chain", title: word, lines: [top, bottom, { op: "=", label: word, value: which === "progress" ? { ratio: value } : { text: value.toFixed(2) }, source: "derived" }] }],
    checks,
    withheld,
    estimates: [],
    through: c.seeds.start.asOf,
  };
}

function milestoneProof(c: FireCtx, id: string): Built {
  const plan = c.plans.full;
  const { checks, withheld } = forecastChecks(c);
  const m = c.fa.milestones.find((x) => x.id === id);
  if (!m) return notFound(`No FIRE milestone ${id}.`);
  const blocks: ProofBlock[] = [];
  if (id.startsWith("nw-")) {
    const target = Number(id.slice(3));
    // The same month-by-month path the milestones come from (keep working, 60 years out).
    const long = projectOutlook({ ...extended(plan), walkAwayYear: null }).months;
    const nm = netWorthMilestones(plan).find((x) => x.cents === target);
    if (m.reached) blocks.push({ kind: "chain", title: "Reached already", lines: [startLine(c), { label: "Milestone", value: { cents: target }, source: "derived" }] });
    else if (nm?.key) {
      const i = long.findIndex((x) => x.key === nm.key);
      const at = long[i]!;
      const lines: ChainLine[] = [{ label: "Milestone", value: { cents: target }, source: "derived", note: "One of the page's fixed net worth marks." }];
      // The long run looks 60 years out; a month past the forecast's horizon has no cell (linkCells finds none).
      lines.push(projected(undefined, `Net worth at the end of ${monthWord(at.key)}: reaches it`, at.netWorth, { month: at.key, line: "netWorth" }, "The forecast, kept working."));
      if (i > 0) lines.push(projected(undefined, `End of ${monthWord(long[i - 1]!.key)}: not yet`, long[i - 1]!.netWorth, { month: long[i - 1]!.key, line: "netWorth" }, "The forecast, kept working."));
      else lines.push(startLine(c));
      blocks.push({ kind: "chain", title: `The first month at or past ${money(target)}`, lines });
    } else
      blocks.push({ kind: "chain", title: "Not within 60 years", lines: [{ label: "Milestone", value: { cents: target }, source: "derived" }, projected(undefined, `Net worth at the end of ${monthWord(long.at(-1)!.key)}`, long.at(-1)!.netWorth, { month: long.at(-1)!.key, line: "netWorth" }, "The forecast, kept working, 60 years out.")] });
  } else {
    const share = Number(id.slice(3));
    const row = m.reached ? null : (c.fa.rows.find((r) => r.progress >= share) ?? null);
    if (m.reached) blocks.push({ kind: "chain", title: "Reached already", lines: [{ label: "Progress today", value: { ratio: c.fa.now.progress }, source: "derived", link: fireLink(c, "Progress", "progress") }] });
    else if (row) {
      const before = c.fa.rows.find((r) => r.year === row.year - 1);
      for (const r of [row, ...(before ? [before] : [])])
        blocks.push({
          kind: "chain",
          title: r === row ? `${r.year}: ${share * 100}% of the FIRE number` : `${r.year}: not yet`,
          lines: [
            projected(undefined, `Net worth on Jan 1, ${r.year}`, r.netWorth, { month: `${r.year - 1}-12`, line: "netWorth" }, `The forecast's net worth at the end of Dec ${r.year - 1}.`),
            { op: "÷", label: `FIRE number in ${r.year}`, value: { cents: r.fireNumber }, source: "derived", note: `The draw covering ${r.year}'s living cost after tax ÷ the withdrawal rate.` },
            { op: "=", label: "Progress", value: { ratio: r.progress }, source: "derived" },
          ],
        });
    }
  }
  blocks.push(driversBlock(c));
  return {
    describes: `Milestone: ${m.label}`,
    figure: { text: m.reached ? "Reached" : m.key ? monthWord(m.key) : m.year ? `Jan 1, ${m.year}` : "Not within 60 years" },
    selfCheck: null,
    blocks,
    checks,
    withheld,
    estimates: m.reached ? [] : [projectionEstimate(c)],
    through: c.seeds.start.asOf,
  };
}

function buildFire(c: FireCtx, d: Extract<PlanningDescriptor, { page: "fire" }>): Built {
  switch (d.figure) {
    case "fire-number":
      return fireNumberProof(c, "fire");
    case "lean-number":
      return fireNumberProof(c, "lean");
    case "fat-number":
      return fireNumberProof(c, "fat");
    case "coast-number":
      return coastNumberProof(c);
    case "fi-year":
      return fiYearProof(c, "fi");
    case "fi-year-base":
      return fiYearProof(c, "base");
    case "lean-year":
      return fiYearProof(c, "lean");
    case "fat-year":
      return fiYearProof(c, "fat");
    case "coast-year":
      return coastYearProof(c);
    case "savings-rate":
      return savingsRateProof(c);
    case "years-saved":
    case "runway":
    case "progress":
      return ratioOfNowProof(c, d.figure);
    case "milestone":
      return milestoneProof(c, d.milestone!);
  }
}

// --------------------------------------------------------------------------- Goals

type GoalsCtx = { book: Book; r: GoalsReport; b: Base | null };

async function goalsCtx(ctx: ProofContext): Promise<GoalsCtx> {
  // As api/goals: the saved goals, buildGoals on the shared forecast.
  const [settings, data] = await Promise.all([loadJsonSetting(ctx.db, GOALS_KEY, normalizeGoals), perBook(ctx, "forecast-data", () => loadForecastData(ctx.db, ctx.book))]);
  const b = baseFrom(ctx.book, data);
  return { book: ctx.book, r: buildGoals(ctx.book, settings, b ? goalForecastOf(b.f) : null, data.profile.settings), b };
}

const goalLink = (g: GoalProgress, label: string, figure: GoalFigure): ProofLink => ({ label, descriptor: { report: "planning", page: "goals", figure, goalId: g.goal.id } });

function targetLine(c: GoalsCtx, g: GoalProgress, op?: ChainLine["op"]): ChainLine {
  if (g.goal.kind === "EMERGENCY_FUND")
    return { ...(op ? { op } : {}), label: `Target: ${g.goal.months} months of spending`, value: g.targetCents == null ? { text: "—" } : { cents: g.targetCents }, source: "derived", link: goalLink(g, "Target", "target") };
  return { ...(op ? { op } : {}), label: "Target", value: g.targetCents == null ? { text: "—" } : { cents: g.targetCents }, source: "assumption", note: "Typed in the goal's editor." };
}

function goalChecks(c: GoalsCtx, g: GoalProgress) {
  return checksFor(c.book, { affects: "NET_WORTH", from: c.r.asOf, to: c.r.asOf, accountIds: g.blockerAccountIds }, NET_WORTH_CHECKS);
}

function goalCurrentProof(c: GoalsCtx, g: GoalProgress): Built {
  const track = g.goal.funding === "TRACK";
  const balance = (a: GoalProgress["accounts"][number]): ChainLine => ({
    label: `${a.name} on ${c.r.asOf}`,
    value: { cents: a.cents },
    source: "proven",
    link: { label: a.name, descriptor: { report: "net-worth", metric: "balance", date: c.r.asOf, accountIds: [a.id] } satisfies NetWorthDescriptor },
  });
  const blocks: ProofBlock[] = [
    {
      kind: "chain",
      title: track ? "Balances counted" : "Money set aside, account by account",
      lines: [
        ...g.accounts.map((a, i): ChainLine => (a.earmarkedCents === a.cents ? { ...balance(a), op: i ? "+" : undefined } : { op: i ? "+" : undefined, label: `Counted from ${a.name}`, value: { cents: a.earmarkedCents }, source: "derived" })),
        { op: "=", label: track ? "Counted toward the milestone" : "Set aside for the goal", value: { cents: g.currentCents }, source: "derived" },
      ],
      note: track ? "A milestone counts whole balances and claims nothing." : "Goals higher in the list claim an account's money first; a share caps what this goal may claim.",
    },
  ];
  for (const a of g.accounts.filter((x) => x.earmarkedCents !== x.cents)) {
    const left = a.cents - a.claimedBeforeCents;
    const lines: ChainLine[] = [balance(a)];
    if (a.claimedBeforeCents) lines.push({ op: "−", label: "Claimed by earlier goals", value: { cents: a.claimedBeforeCents }, source: "derived" }, { op: "=", label: "Left for this goal", value: { cents: left }, source: "derived" });
    if (a.share != null) lines.push({ label: `This goal's share cap (${pct(a.share, 0)} of the balance)`, value: { cents: Math.round(Math.max(0, a.cents) * a.share) }, source: "assumption" });
    lines.push({ label: "Counted toward this goal: the least of what's left, the cap and what the goal still needed", value: { cents: a.earmarkedCents }, source: "derived" });
    blocks.push({ kind: "chain", title: a.name, lines });
  }
  const { checks, withheld } = goalChecks(c, g);
  const parts = g.accounts.reduce((t, a) => t + a.earmarkedCents, 0);
  return {
    describes: `${g.goal.name}: ${track ? "counted" : "set aside"} on ${c.r.asOf}`,
    figure: { cents: g.currentCents },
    selfCheck: sumCheck(g.currentCents, parts, `The ${g.accounts.length} account${g.accounts.length === 1 ? "" : "s"} add up to ${money(parts)}`),
    blocks,
    checks,
    withheld,
    estimates: [],
    through: c.r.asOf,
  };
}

function goalSpendingProof(c: GoalsCtx): Built {
  const s = c.r.monthlySpending;
  if (!s) return notFound("No proven month of spending yet.");
  const total = s.periods.reduce((t, p) => t + p.cents, 0);
  const { checks, withheld } = checksFor(c.book, { affects: "CASH_FLOW", from: s.from!, to: s.to! }, CASH_FLOW_CHECKS);
  return {
    describes: `Typical monthly living cost: the last ${s.months} proven months`,
    figure: { cents: s.cents },
    selfCheck: sumCheck(Math.round(total / s.months), s.cents, `The ${s.months} months add up to ${money(total)}; ÷ ${s.months} is ${money(Math.round(total / s.months))}`),
    blocks: [
      {
        kind: "breakdown",
        title: "Living cost by month",
        items: s.periods.map((p) => ({
          label: monthWord(p.start),
          value: { cents: p.cents },
          sub: `Cash flow's spending ${money(p.spendingCents)}, less tax payments, one-offs and reimbursements`,
        })),
        note: "Living cost, as everywhere in the app: spending less tax payments (taxes, not living), what you count as one-off, and reimbursements received.",
      },
      {
        kind: "chain",
        title: "Average",
        lines: [
          { label: `${s.months} months`, value: { cents: total }, source: "proven" },
          { op: "÷", label: "Months", value: { text: String(s.months) }, source: "derived" },
          { op: "=", label: "A month", value: { cents: s.cents }, source: "derived", note: "Rounded to the cent." },
        ],
      },
    ],
    checks,
    withheld,
    estimates: [],
    through: s.to!,
  };
}

function goalTargetProof(c: GoalsCtx, g: GoalProgress): Built {
  const blocks: ProofBlock[] = [];
  let selfCheck: Proof["selfCheck"] = null;
  if (g.goal.kind === "EMERGENCY_FUND" && c.r.monthlySpending && g.targetCents != null) {
    const s = c.r.monthlySpending;
    blocks.push({
      kind: "chain",
      title: "Emergency fund target",
      lines: [
        { label: "Typical monthly living cost", value: { cents: s.cents }, source: "proven", link: { label: "Monthly living cost", descriptor: { report: "planning", page: "goals", figure: "spending" } } },
        { op: "×", label: "Months of spending", value: { text: String(g.goal.months) }, source: "assumption" },
        { op: "=", label: "Target", value: { cents: g.targetCents }, source: "derived" },
      ],
    });
    selfCheck = sumCheck(g.targetCents, Math.round(s.cents * (g.goal.months ?? 6)), `${money(s.cents)} × ${g.goal.months} is ${money(Math.round(s.cents * (g.goal.months ?? 6)))}`);
  } else blocks.push({ kind: "chain", title: "Target", lines: [targetLine(c, g)] });
  return { describes: `${g.goal.name}: target`, figure: g.targetCents == null ? { text: "—" } : { cents: g.targetCents }, selfCheck, blocks, estimates: [], through: c.r.asOf };
}

function goalToGoProof(c: GoalsCtx, g: GoalProgress): Built {
  const left = g.targetCents == null ? null : Math.max(0, g.targetCents - g.currentCents);
  const { checks, withheld } = goalChecks(c, g);
  if (left == null) return { describes: `${g.goal.name}: to go`, figure: { text: "—" }, selfCheck: null, blocks: [], checks, withheld, estimates: [], through: c.r.asOf };
  return {
    describes: `${g.goal.name}: still to go`,
    figure: { cents: left },
    selfCheck: sumCheck(left, Math.max(0, g.targetCents! - g.currentCents), `The target less what's ${g.goal.funding === "TRACK" ? "counted" : "set aside"} is ${money(left)}`),
    blocks: [{ kind: "chain", title: "To go", lines: [targetLine(c, g), { op: "−", label: "Already there", value: { cents: g.currentCents }, source: "derived", link: goalLink(g, "Saved so far", "current") }, { op: "=", label: "To go", value: { cents: left }, source: "derived", note: left === 0 ? "Fully funded." : undefined }] }],
    checks,
    withheld,
    estimates: [],
    through: c.r.asOf,
  };
}

function goalLandsProof(c: GoalsCtx, g: GoalProgress): Built {
  const { checks, withheld } = goalChecks(c, g);
  const fmt = (iso: string | null) => (iso ? monthWord(iso) : "—");
  const left = g.targetCents == null ? null : Math.max(0, g.targetCents - g.currentCents);
  const blocks: ProofBlock[] = [];
  const toGo: ChainLine[] = [targetLine(c, g), { op: "−", label: "Already there", value: { cents: g.currentCents }, source: "derived", link: goalLink(g, "Saved so far", "current") }, { op: "=", label: "Still needed", value: left == null ? { text: "—" } : { cents: left }, source: "derived" }];
  let estimates: ProofEstimate[] = [];
  if (g.status === "REACHED") blocks.push({ kind: "chain", title: "Reached", lines: toGo });
  else if (g.projectedFrom === "FORECAST" && c.b && g.filled) {
    const t = g.filled;
    const f = c.b.f;
    const lines: ChainLine[] = [...toGo];
    if (t.need !== t.own) lines.push({ op: "+", label: `Earlier goals' still needed on the same ${t.sides.join(" and ")} money`, value: { cents: t.need - t.own }, source: "derived", note: "New money fills unfinished goals in list order." }, { op: "=", label: "New money the forecast has to add", value: { cents: t.need }, source: "derived" });
    blocks.push({ kind: "chain", title: "What the forecast has to add", lines });
    const addedBlock = (key: string, title: string): ProofBlock => {
      const at = balancesAt(f, key);
      const ls: ChainLine[] = [];
      // Each side: its balance that month (a ledger cell) less where it started.
      for (const s of t.sides) {
        const word = s === "liquid" ? "Liquid" : "Illiquid";
        ls.push(
          projected(ls.length ? "+" : undefined, `${word} money at the end of ${monthWord(key)}`, at[s], { month: key, line: s }, `The forecast's ${s} balance.`),
          { op: "−", label: `${word} money at the start, ${c.b!.seeds.start.asOf}`, value: { cents: f.plan.start[s] }, source: "proven", link: START },
        );
      }
      const sum = t.sides.reduce((x, s) => x + at[s] - f.plan.start[s], 0);
      ls.push({ op: "=", label: `Money added by the end of ${monthWord(key)}`, value: { cents: sum }, source: "derived" });
      ls.push({ label: sum >= t.need ? `Covers the ${money(t.need)} needed` : `Short of the ${money(t.need)} needed`, value: { cents: t.need }, source: "derived" });
      return { kind: "chain", title, lines: ls };
    };
    if (g.projectedDate) {
      const key = g.projectedDate.slice(0, 7);
      blocks.push(addedBlock(key, `${monthWord(key)}: the first month it's covered`));
      if (key > f.startKey && prevKey(key) > f.startKey) blocks.push(addedBlock(prevKey(key), `${monthWord(prevKey(key))}: not yet`));
    } else if (f.months.length) blocks.push(addedBlock(f.months.at(-1)!.key, `Still short at the forecast's end, ${monthWord(f.months.at(-1)!.key)}`));
    blocks.push({ kind: "chain", title: "Where the forecast starts", lines: [{ label: `Liquid at the end of ${c.b.seeds.start.asOf}`, value: { cents: f.plan.start.liquid }, source: "proven", link: START }, { op: "+", label: "Illiquid", value: { cents: f.plan.start.illiquid }, source: "proven", link: START }, { op: "=", label: "Net worth", value: { cents: startNetWorth(c.b) }, source: "proven" }] }, driversBlock(c.b));
    estimates = [projectionEstimate(c.b)];
  } else if (g.pace && left != null) {
    const days = g.pace.monthlyCents > 0 ? Math.ceil((left / g.pace.monthlyCents) * 30.4375) : null;
    const ids = g.accounts.map((a) => a.id);
    blocks.push(
      { kind: "chain", title: "To go", lines: toGo },
      {
        kind: "chain",
        title: "At last year's pace",
        lines: [
          { label: `Change in the funding accounts, ${g.pace.from} → ${g.pace.to}, a month`, value: { cents: g.pace.monthlyCents }, source: "derived", link: { label: "Funding accounts' change", descriptor: { report: "net-worth", metric: "change", granularity: "month", start: addDays(g.pace.from, 1), end: g.pace.to, ...(ids.length ? { accountIds: ids } : {}) } }, note: "Deposits plus growth, per 30.4 days." },
          { label: "Days to cover what's still needed", value: { text: days == null ? "never (not growing)" : String(days) }, source: "derived" },
          { label: "Lands", value: { text: fmt(g.projectedDate) }, source: "estimate", note: `${c.r.asOf} + those days.` },
        ],
        note: "No forecast: last year's pace stands in.",
      },
    );
  } else blocks.push({ kind: "chain", title: "To go", lines: toGo });
  if (g.goal.targetDate) blocks.push({ kind: "chain", title: "Target date", lines: [{ label: "By", value: { text: fmt(g.goal.targetDate) }, source: "assumption" }] });
  return {
    describes: `${g.goal.name}: when it lands`,
    figure: { text: g.status === "REACHED" ? "Reached" : g.projectedDate ? fmt(g.projectedDate) : "Not reached" },
    selfCheck: null,
    blocks,
    checks,
    withheld,
    estimates,
    through: c.r.asOf,
  };
}

function goalNeededProof(c: GoalsCtx, g: GoalProgress): Built {
  const left = g.targetCents == null ? null : Math.max(0, g.targetCents - g.currentCents);
  if (g.neededMonthlyCents == null || left == null || !g.goal.targetDate) return notFound("This goal has no target date or target.");
  const months = Math.max(0, daysBetween(c.r.asOf, g.goal.targetDate) / 30.4375);
  return {
    describes: `${g.goal.name}: needed a month to land by ${monthWord(g.goal.targetDate)}`,
    figure: { cents: g.neededMonthlyCents },
    selfCheck: null,
    blocks: [
      {
        kind: "chain",
        title: "A month from now",
        lines: [
          { label: "Still needed", value: { cents: left }, source: "derived", link: goalLink(g, "To go", "to-go") },
          { op: "÷", label: `Months from ${c.r.asOf} to ${g.goal.targetDate}`, value: { text: months.toFixed(2) }, source: "assumption", note: "The target date you set; months of 30.4 days." },
          { op: "=", label: "A month", value: { cents: g.neededMonthlyCents }, source: "derived", note: months < 1 ? "Under a month left: all of it." : "Rounded up to the cent." },
        ],
      },
    ],
    estimates: [],
    through: c.r.asOf,
  };
}

function buildGoal(c: GoalsCtx, d: Extract<PlanningDescriptor, { page: "goals" }>): Built {
  if (d.figure === "spending") return goalSpendingProof(c);
  const g = c.r.goals.find((x) => x.goal.id === d.goalId);
  if (!g) return notFound(`No goal has the id ${d.goalId}.`);
  switch (d.figure) {
    case "current":
      return goalCurrentProof(c, g);
    case "target":
      return goalTargetProof(c, g);
    case "to-go":
      return goalToGoProof(c, g);
    case "lands":
      return goalLandsProof(c, g);
    case "needed":
      return goalNeededProof(c, g);
  }
}

// --------------------------------------------------------------------------- Home budget

type HomeCtx = { book: Book; fb: FundsBook; L: HomeLinked; inputs: HomeBudgetInputs; funds: FundsConfig; d: Extract<PlanningDescriptor, { page: "home" }>; b: Base | null };

async function homeCtx(ctx: ProofContext, d: Extract<PlanningDescriptor, { page: "home" }>): Promise<HomeCtx> {
  // As api/home-budget/funds, then the page's own links (linkHome) on the typed inputs.
  const data = await perBook(ctx, "forecast-data", () => loadForecastData(ctx.db, ctx.book));
  const b = baseFrom(ctx.book, data);
  const fb: FundsBook = { ...buildHomeFunds(ctx.book), forecast: b ? homeForecast(b.f, b.seeds) : null, spending: buildHomeSpending(ctx.book, data.profile.settings) };
  const inputs = { ...defaultHomeBudgetInputs(), ...d.inputs };
  const funds = { ...defaultFunds(), ...d.funds };
  return { book: ctx.book, fb, L: linkHome(fb, inputs, funds, Number(ctx.book.today.slice(0, 4))), inputs, funds, d, b };
}

const homeLink = (c: HomeCtx, label: string, figure: HomeFigure): ProofLink => ({ label, descriptor: { report: "planning", page: "home", figure, inputs: c.d.inputs ?? {}, funds: c.d.funds ?? {} } });
const typed = (label: string, value: ProofValue, note = "Typed on the Home budget page."): ChainLine => ({ label, value, source: "assumption", note });

function homeChecks(c: HomeCtx) {
  return checksFor(c.book, { affects: "NET_WORTH", from: c.fb.asOf, to: c.fb.asOf }, NET_WORTH_CHECKS);
}

function homeCashProof(c: HomeCtx): Built {
  const { L, fb } = c;
  const { checks, withheld } = homeChecks(c);
  if (!L.linked || !L.derived) {
    const why = c.funds.mode === "manual" ? "You chose a fixed amount." : "Net worth isn't proven, so the fixed amount stands in.";
    return { describes: "Cash for the home (a fixed amount)", figure: { cents: cents(L.ins.cashForHome) }, selfCheck: null, blocks: [{ kind: "chain", title: "Cash for the home", lines: [typed("Fixed amount", { cents: cents(L.ins.cashForHome) }, why)] }], checks, withheld, estimates: [], through: fb.asOf };
  }
  const D = L.derived;
  const nw = (label: string, ids: string[]): ProofLink | undefined => (ids.length ? { label, descriptor: { report: "net-worth", metric: "balance", date: fb.asOf, accountIds: ids } } : undefined);
  const cashIds = fb.accounts.filter((a) => a.group === "Cash").map((a) => a.accountId);
  const invIds = fb.accounts.filter((a) => a.group === "Taxable investments").map((a) => a.accountId);
  const cardIds = c.book.ledger.accounts.filter((a) => a.group === "Credit cards" && !a.closed).map((a) => a.id);
  const liquidC = cents(D.liquid);
  const afterTaxC = cents(D.afterTax);
  const availableC = cents(D.available);
  const lines: ChainLine[] = [
    { label: `Bank cash on ${fb.asOf}`, value: { cents: fb.cashCents }, source: "proven", ...(nw("Bank cash", cashIds) ? { link: nw("Bank cash", cashIds)! } : {}) },
    { op: "+", label: "Taxable investments", value: { cents: fb.investmentsCents }, source: "proven", ...(nw("Taxable investments", invIds) ? { link: nw("Taxable investments", invIds)! } : {}) },
  ];
  if (fb.cardsCents) lines.push(signed(fb.cardsCents, { label: "Card balances", source: "proven", ...(nw("Cards", cardIds) ? { link: nw("Cards", cardIds)! } : {}) }));
  // The forecast's addition is a difference of two balances: its cell is the liquid balance, in the block below.
  if (D.buyKey) lines.push({ op: D.added < 0 ? "−" : "+", label: `What the forecast adds by ${monthWord(D.buyKey)}`, value: { cents: Math.abs(cents(D.added)) }, source: "estimate", note: "Liquid savings and growth after the proven balances (worked out below)." });
  lines.push({ op: "=", label: D.buyKey ? `Liquid money at the end of ${monthWord(D.buyKey)}` : "Liquid money now", value: { cents: liquidC }, source: "derived" });
  lines.push({ op: "−", label: `Tax on ${money(cents(D.gain))} of gains`, value: { cents: liquidC - afterTaxC }, source: "derived", link: homeLink(c, "Gains tax rate", "gains-tax"), note: `Gains × ${pct(L.ins.capitalGainsTaxRate, 1)}.` });
  lines.push({ op: "=", label: "Liquid, after tax", value: { cents: afterTaxC }, source: "derived" });
  lines.push({ op: "×", label: "Share to put into the home", value: { ratio: c.funds.share }, source: "assumption" }, { op: "=", label: "Cash for the home", value: { cents: availableC }, source: "derived" });
  const gainLines: ChainLine[] = [{ label: "Growth in taxable investments since their first statements", value: { cents: fb.gainCents }, source: "proven", note: "Growth net of fees over every statement on file; withdrawals reduce basis dollar for dollar, so the tax errs high." }];
  // The ledger's growth line is liquid and illiquid together, and a span from the start isn't one of its columns: no cell holds it.
  if (D.buyKey) gainLines.push(projected("+", `Growth the forecast earns on liquid money by ${monthWord(D.buyKey)}`, cents(D.gainAdded), null, "Each month's growth on liquid money, from the start through the buy month."));
  gainLines.push({ op: "=", label: "Gains", value: { cents: cents(D.gain) }, source: "derived" });
  const parts = fb.cashCents + fb.investmentsCents + fb.cardsCents + (D.buyKey ? cents(D.added) : 0);
  return {
    describes: `Cash for the home${D.buyKey ? `, buying in ${monthWord(D.buyKey)}` : ""}`,
    figure: { cents: availableC },
    selfCheck: sumCheck(liquidC, parts, `Cash, investments and cards${D.buyKey ? " and what the forecast adds" : ""} come to ${money(parts)} of liquid money`),
    blocks: [
      { kind: "chain", title: "Cash for the home", lines, note: `Not counted: ${fb.excluded.map((e) => e.group.toLowerCase()).join(", ") || "nothing"}.` },
      ...(D.buyKey && c.b && fb.forecast
        ? [
            {
              kind: "chain" as const,
              title: `What the forecast adds by ${monthWord(D.buyKey)}`,
              lines: [
                projected(undefined, `Liquid money at the end of ${monthWord(D.buyKey)}`, fb.forecast.months.find((m) => m.key === D.buyKey)!.liquid, { month: D.buyKey, line: "liquid" }, "The forecast's liquid balance."),
                { op: "−" as const, label: `Liquid money at the start, ${c.b.seeds.start.asOf}`, value: { cents: fb.forecast.startLiquid }, source: "proven" as const, link: START },
                { op: "=" as const, label: "Added", value: { cents: cents(D.added) }, source: "derived" as const },
              ],
            },
          ]
        : []),
      { kind: "chain", title: "Gains taxed on the way out", lines: gainLines },
    ],
    checks,
    withheld: withheld || fb.blockers.length > 0,
    estimates: D.buyKey && c.b ? [projectionEstimate(c.b)] : [],
    through: fb.asOf,
  };
}

function homeSalaryProof(c: HomeCtx): Built {
  const { L } = c;
  const y = L.buy.year;
  if (!L.buy.salaryLinked || !c.b) return { describes: "Household salary (typed)", figure: { cents: cents(L.ins.annualHouseholdSalary) }, selfCheck: null, blocks: [{ kind: "chain", title: "Household salary", lines: [typed("Salary you typed", { cents: cents(L.ins.annualHouseholdSalary) })] }], estimates: [], through: c.fb.asOf };
  const { f } = c.b;
  const n = y - f.plan.start.year;
  const lines: ChainLine[] = f.pay.people.map((p, i) => ({
    op: i ? ("+" as const) : undefined,
    label: `${p.name}'s base salary`,
    value: { cents: p.salary },
    source: p.salaryTyped ? ("assumption" as const) : ("derived" as const),
    link: seedLink(`${p.name}'s pay`, { report: "forecast", figure: "seed", which: "pay", personId: p.personId, paycheck: p.basis }),
  }));
  lines.push({ op: "=", label: `Household base salary in ${f.plan.start.year}`, value: { cents: f.plan.salary }, source: "derived" });
  const salaryC = cents(L.buy.salary!);
  if (n > 0)
    lines.push(
      { op: "×", label: `(1 + raise)^${n}`, value: { ratio: (1 + f.plan.salaryGrowth) ** n }, source: "assumption", note: `${pct(f.plan.salaryGrowth)} a year, each January.` },
      projected("=", `Household base salary in ${y}`, salaryC, yearCell(y, "salary"), `The forecast's ${y}, Jan–Dec.`),
    );
  return {
    describes: `Household base salary in ${y}, from the forecast`,
    figure: { cents: salaryC },
    selfCheck: n > 0 ? null : sumCheck(salaryC, f.pay.people.reduce((t, p) => t + p.salary, 0), `Each person's base salary adds up to ${money(f.pay.people.reduce((t, p) => t + p.salary, 0))}`),
    blocks: [{ kind: "chain", title: "Base salary", lines, note: "Base pay only: bonuses aren't counted in the comfort view." }],
    estimates: n > 0 ? [projectionEstimate(c.b)] : [],
    through: c.b.seeds.start.asOf,
  };
}

/** The tax engine's lines on the salary (and a gain), as homeTax works them out. */
function homeTaxProof(c: HomeCtx, which: "income-tax" | "gains-tax"): Built {
  const { L } = c;
  const rate = which === "income-tax" ? L.tax.income : L.tax.gains;
  const used = which === "income-tax" ? L.ins.incomeTaxRate : L.ins.capitalGainsTaxRate;
  const word = which === "income-tax" ? "Income tax rate" : "Capital-gains tax rate";
  const basis = c.fb.forecast?.tax;
  if (!rate.linked || !basis) return { describes: `${word} (typed)`, figure: { ratio: used }, selfCheck: null, blocks: [{ kind: "chain", title: word, lines: [typed(`${word} you typed`, { ratio: used })] }], estimates: [], through: c.fb.asOf };
  const params = TAX_YEARS[basis.year]!;
  const salary = L.ins.annualHouseholdSalary;
  const people: PayForTax[] = basis.earners.map((e) => ({ id: e.id, name: e.name, salary: Math.round(salary * e.share * 100), bonus: 0, k401Pretax: 0, hsa: 0, section125: 0 }));
  const base = taxOnPay(params, people, basis.dependents);
  const salaryLine: ChainLine = { label: "Household salary", value: { cents: cents(salary) }, source: L.buy.salaryLinked ? "derived" : "assumption", link: homeLink(c, "Household salary", "salary"), note: `Split ${basis.earners.map((e) => `${e.name} ${pct(e.share, 1)}`).join(", ")} as their base pay; ${basis.year} law, filing jointly, ${basis.dependents.length} dependent${basis.dependents.length === 1 ? "" : "s"}.` };
  let lines: ChainLine[];
  if (which === "income-tax") {
    lines = [
      { label: "Federal income tax", value: { cents: base.federal }, source: "law" },
      { op: "+", label: "Connecticut income tax", value: { cents: base.ct }, source: "law" },
      { op: "+", label: "Social Security", value: { cents: base.socialSecurity }, source: "law" },
      { op: "+", label: "Medicare", value: { cents: base.medicare }, source: "law" },
      { op: "+", label: "CT paid leave", value: { cents: base.pfml }, source: "law" },
      { op: "=", label: "Tax on the salary", value: { cents: base.total }, source: "derived" },
      { ...salaryLine, op: "÷" },
      { op: "=", label: word, value: { ratio: used }, source: "derived", note: "Wages only: no 401(k), HSA or benefit deductions, so it errs a little high." },
    ];
  } else {
    const g = Math.max(50_000, L.tax.gains.gain);
    const withGain = taxOnPay(params, people, basis.dependents, Math.round(g * 100));
    const extra = withGain.federal + withGain.ct - base.federal - base.ct;
    lines = [
      salaryLine,
      { label: L.tax.gains.gain < 50_000 ? "Gain priced (at least $50,000)" : "Gain", value: { cents: Math.round(g * 100) }, source: "derived", note: "Growth in taxable investments since their first statements, plus what the forecast earns by the buy month (the Cash for the home proof)." },
      { label: "Federal + CT income tax with the gain", value: { cents: withGain.federal + withGain.ct }, source: "law" },
      { op: "−", label: "Federal + CT income tax without it", value: { cents: base.federal + base.ct }, source: "law" },
      { op: "=", label: "Tax the gain adds", value: { cents: extra }, source: "derived", note: "Federal 15/20%, the 3.8% NIIT and Connecticut, where the gain lands." },
      { op: "÷", label: "Gain", value: { cents: Math.round(g * 100) }, source: "derived" },
      { op: "=", label: word, value: { ratio: used }, source: "derived" },
    ];
  }
  return { describes: `${word}, from the tax engine`, figure: { ratio: used }, selfCheck: null, blocks: [{ kind: "chain", title: word, lines }], estimates: [], through: c.fb.asOf };
}

/** The most a home can cost: the loan the limit's monthly room pays for, plus the cash put in, less closing and renovation. */
function maxBlocks(c: HomeCtx, ins: HomeBudgetInputs, max: MaxApprovalResult, income: ChainLine, cap: ChainLine, lender: boolean): { blocks: ProofBlock[]; figureC: number } {
  const priceC = cents(max.impliedMaxHomeValue);
  const loanC = cents(max.impliedMaxLoan);
  const downC = priceC - loanC;
  const cashC = cents(ins.cashForHome);
  const closingC = cents(ins.closingCostsPctOfHomePrice * max.impliedMaxHomeValue);
  const renoC = cashC - closingC - downC;
  const other = max.monthlyInsurance + max.monthlyPropertyTax + max.monthlyMaintenance + max.monthlyMortgageInsurance + ins.hoaMonthly + ins.utilitiesMonthly;
  const room: ChainLine[] = [
    income,
    { op: "÷", label: "Months", value: { text: "12" }, source: "derived" },
    cap,
    { op: "=", label: "Housing a month at the limit", value: { cents: cents(max.maxHousingBudgetMonthly) }, source: "derived" },
    { op: "−", label: `Property tax (${pct(ins.annualPropertyTaxRate)} of the price a year)`, value: { cents: cents(max.monthlyPropertyTax) }, source: "assumption" },
    { op: "−", label: `Insurance (${pct(ins.annualInsuranceRateOnValue)})`, value: { cents: cents(max.monthlyInsurance) }, source: "assumption" },
  ];
  if (!lender) room.push({ op: "−", label: `Maintenance (${pct(ins.annualMaintenanceRate)})`, value: { cents: cents(max.monthlyMaintenance) }, source: "assumption" }, { op: "−", label: "Utilities", value: { cents: cents(ins.utilitiesMonthly) }, source: "assumption" });
  if (ins.hoaMonthly) room.push({ op: "−", label: "HOA", value: { cents: cents(ins.hoaMonthly) }, source: "assumption" });
  if (max.monthlyMortgageInsurance) room.push({ op: "−", label: "Mortgage insurance", value: { cents: cents(max.monthlyMortgageInsurance) }, source: "assumption" });
  // Each cost rounded to the cent; the payment is what they leave (the solver's, to within a cent).
  const paymentC = room.slice(4).reduce((t, l) => t - ("cents" in l.value ? l.value.cents : 0), cents(max.maxHousingBudgetMonthly));
  room.push({ op: "=", label: "Left for the mortgage payment", value: { cents: paymentC }, source: "derived", note: `Housing ${money(cents(max.maxHousingBudgetMonthly))} less ${money(cents(other))} of other costs at the max price.` });
  const pay1 = monthlyPaymentOnLoan(1, ins.annualMortgageRate, ins.mortgageTermYears);
  return {
    figureC: priceC,
    blocks: [
      { kind: "chain", title: "The monthly room", lines: room },
      {
        kind: "chain",
        title: "The loan it pays for",
        lines: [
          { label: "Mortgage payment", value: { cents: paymentC }, source: "derived", note: `The solver lands on ${money(cents(max.monthlyMortgagePayment))}; the costs above are each rounded to the cent.` },
          { op: "÷", label: `Payment per $1 borrowed (${pct(ins.annualMortgageRate, 3)}, ${ins.mortgageTermYears} years)`, value: { text: pay1.toFixed(6) }, source: "assumption" },
          { op: "=", label: "Loan", value: { cents: loanC }, source: "derived" },
        ],
      },
      {
        kind: "chain",
        title: "The price",
        lines: [
          { label: "Cash for the home", value: { cents: cashC }, source: c.L.linked ? "derived" : "assumption", link: homeLink(c, "Cash for the home", "cash") },
          { op: "−", label: `Closing costs (${pct(ins.closingCostsPctOfHomePrice)} of the price)`, value: { cents: closingC }, source: "assumption" },
          { op: "−", label: `Renovation (${pct(ins.renovationPctOfHomePrice)} of the price)`, value: { cents: renoC }, source: "assumption" },
          { op: "=", label: "Down payment", value: { cents: downC }, source: "derived" },
          { op: "+", label: "Loan", value: { cents: loanC }, source: "derived" },
          { op: "=", label: lender ? "Lender max" : "Most you can afford", value: { cents: priceC }, source: "derived", note: "The page shows it rounded down to $1,000." },
        ],
        note: "Every dollar of the cash goes in; the price is solved so the loan and down payment fit together.",
      },
    ],
  };
}

function homeMaxProof(c: HomeCtx, lender: boolean): Built {
  const { L } = c;
  const ins = L.ins;
  const max = lender ? computeLenderMax(ins, L.lender.income) : computeMaxApproval(ins);
  const income: ChainLine = lender
    ? { label: "Income a lender counts a year", value: { cents: cents(L.lender.income) }, source: "derived", link: homeLink(c, "Lender income", "lender-income") }
    : { label: "Household salary a year", value: { cents: cents(ins.annualHouseholdSalary) }, source: L.buy.salaryLinked ? "derived" : "assumption", link: homeLink(c, "Household salary", "salary") };
  const cap: ChainLine = { op: "×", label: lender ? "Lender's limit (% of gross)" : "Your housing limit (% of gross)", value: { ratio: lender ? ins.lenderMaxDti : ins.housingCostMaxOfGross }, source: "assumption" };
  const m = maxBlocks(c, ins, max, income, cap, lender);
  const { checks, withheld } = homeChecks(c);
  const loanC = cents(max.impliedMaxLoan);
  return {
    describes: lender ? "Lender view: the most a lender would likely approve" : "You can afford up to",
    figure: { cents: m.figureC },
    selfCheck: sumCheck(m.figureC, loanC + (m.figureC - loanC), `The loan and down payment add up to ${money(m.figureC)}`),
    blocks: m.blocks,
    checks,
    withheld: withheld || (L.linked && c.fb.blockers.length > 0),
    estimates: L.buy.key && c.b ? [projectionEstimate(c.b)] : [],
    through: c.fb.asOf,
  };
}

function lenderIncomeProof(c: HomeCtx): Built {
  const { L } = c;
  const salary: ChainLine = { label: "Household salary", value: { cents: cents(L.ins.annualHouseholdSalary) }, source: L.buy.salaryLinked ? "derived" : "assumption", link: homeLink(c, "Household salary", "salary") };
  const lines: ChainLine[] = [salary];
  const blocks: ProofBlock[] = [];
  if (L.lender.countBonus && L.lender.bonus && c.b) {
    const annual = cents(L.lender.bonus.annual);
    const people = c.b.seeds.people.map((p) => ({ p, last: p.bonusHistory.filter((h) => !h.partial).slice(-2) })).filter((x) => x.last.length);
    blocks.push({
      kind: "breakdown",
      title: "Bonuses in the last complete years",
      items: people.flatMap(({ p, last }) =>
        last.map((h) => ({ label: `${p.name}, ${h.year}`, value: { cents: h.bonus }, link: { label: `${p.name}'s ${h.year} bonus`, descriptor: { report: "pay", basis: "ytd", personId: p.personId, year: h.year, lines: ["bonus"] } satisfies PayDescriptor } })),
      ),
    });
    let given = 0;
    people.forEach(({ p, last }, i) => {
      const v = i === people.length - 1 ? annual - given : Math.round(last.reduce((t, h) => t + h.bonus, 0) / last.length);
      given += v;
      lines.push({ op: "+", label: `${p.name}: average of ${last.map((h) => h.year).join(" and ")}`, value: { cents: v }, source: "derived" });
    });
  } else lines.push({ op: "+", label: L.lender.bonus ? "Bonus (left out: base only)" : "Bonus (no bonus history)", value: { cents: 0 }, source: L.lender.bonus ? "assumption" : "derived" });
  lines.push({ op: "=", label: "Income the lender counts", value: { cents: cents(L.lender.income) }, source: "derived" });
  return {
    describes: "Income the lender view counts",
    figure: { cents: cents(L.lender.income) },
    selfCheck: null,
    blocks: [{ kind: "chain", title: "Lender income", lines, note: "Lenders average each earner's cash bonuses over the last two complete years." }, ...blocks],
    estimates: [],
    through: c.fb.asOf,
  };
}

function buildHome(c: HomeCtx): Built {
  switch (c.d.figure) {
    case "cash":
      return homeCashProof(c);
    case "salary":
      return homeSalaryProof(c);
    case "income-tax":
    case "gains-tax":
      return homeTaxProof(c, c.d.figure);
    case "max-price":
      return homeMaxProof(c, false);
    case "lender-max":
      return homeMaxProof(c, true);
    case "lender-income":
      return lenderIncomeProof(c);
  }
}

// --------------------------------------------------------------------------- Taxes

async function buildTaxes(ctx: ProofContext, d: Extract<PlanningDescriptor, { page: "taxes" }>): Promise<Built> {
  // As api/tax: the year in progress follows the shared forecast.
  const data = await perBook(ctx, "forecast-data", () => loadForecastData(ctx.db, ctx.book));
  const b = baseFrom(ctx.book, data);
  if (!TAX_YEARS[d.year]) return notFound(`No ${d.year} tax law in the app.`);
  const r = buildTaxReport(ctx.book, d.year, { forecast: b ? taxLink(b.f) : null });
  if (r.blocked) return notFound(`${d.year} taxes are withheld.`);
  const p = r.people.find((x) => x.id === d.personId);
  if (!p) return notFound(`No one in the household has the id ${d.personId}.`);
  const e = p.payroll.find((x) => x.active);
  const lastStub = e?.latestPayDate ?? null;
  const { checks, withheld } = checksFor(ctx.book, { affects: "PAY", from: `${d.year}-01-01`, to: lastStub ?? `${d.year}-12-31`, personId: p.id }, PAY_CHECKS);
  const fc = p.fromForecast;
  const estLine: ProofLink = { label: `Where it lands on the ${d.year} estimate`, descriptor: { report: "tax-estimate", year: d.year, basis: "projected", key: d.figure === "bonus-expected" ? "pay.bonus" : "pay.salary" } satisfies TaxEstimateDescriptor };
  if (d.figure === "bonus-expected") {
    if (!fc) return notFound(`${d.year} isn't the year in progress: no bonus is expected from the forecast.`);
    const lines: ChainLine[] = fc.items.map((i, k) => ({
      op: k ? ("+" as const) : undefined,
      label: `${i.label}${i.key ? `, ${monthWord(i.key)}` : ""}`,
      value: { cents: i.gross },
      source: i.source === "ESTIMATE" ? ("estimate" as const) : ("proven" as const),
      note: i.source === "LETTER" ? "Amount and date read off the award letter." : i.source === "PAID" ? `Paid on the ${i.date} stub.` : "The forecast's estimate: a share of base salary on the usual pattern.",
      link:
        i.source === "LETTER" && i.window
          ? { label: i.label, descriptor: { report: "bonuses", figure: "window", window: i.window, measure: "scheduled" } satisfies BonusesDescriptor }
          : i.source === "PAID" && i.date
            ? { label: `${i.date} bonus`, descriptor: { report: "pay", basis: "paid", personId: p.id, lines: ["bonus"], start: i.date, end: i.date } satisfies PayDescriptor }
            : seedLink("The forecast's bonuses", { report: "forecast", figure: "seed", which: "bonus" }),
    }));
    if (!lines.length) lines.push({ label: "None after the latest stub", value: { cents: 0 }, source: "derived" });
    lines.push({ op: "=", label: "Bonus still expected", value: { cents: fc.bonus }, source: "derived" });
    const parts = fc.items.reduce((t, i) => t + i.gross, 0);
    return {
      describes: `${p.name}: bonus still expected in ${d.year}, from the forecast`,
      figure: { cents: fc.bonus },
      selfCheck: sumCheck(fc.bonus, parts, `The forecast's ${fc.items.length} bonus${fc.items.length === 1 ? "" : "es"} after the latest stub add up to ${money(parts)}`),
      blocks: [
        { kind: "chain", title: `Paid after ${lastStub ?? "the latest stub"}`, lines, note: "The forecast's bonuses dated after the latest pay stub this estimate counts.", },
        { kind: "breakdown", title: "On the estimate", items: [{ label: "Gross bonus for the year", value: { text: "projected" }, link: estLine }] },
      ],
      checks,
      withheld,
      estimates: fc.items.some((i) => i.source === "ESTIMATE") ? [{ id: "planning.bonus-estimates", title: "Bonuses no stub or letter shows yet", detail: "A share of base salary, paid on the latest letter's pattern (or the usual bonus month)." }] : [],
      through: lastStub ?? r.today,
    };
  }
  if (!e) return notFound(`${p.name} has no ${d.year} pay stubs.`);
  return projectedGross(ctx.book, d.year, p, e, estLine, checks, withheld);
}

function projectedGross(book: Book, year: number, p: PersonReport, e: PersonReport["payroll"][number], estLine: ProofLink, checks: ProofCheck[], withheld: boolean): Built {
  const n = e.remainingPayDates.length;
  const check = e.regularPaycheck?.gross ?? 0;
  const fromForecast = p.fromForecast?.bonus ?? 0;
  const typedExtra = e.extraBonus - fromForecast;
  const lines: ChainLine[] = [
    {
      label: `Gross pay year to date, ${e.latestPayDate} stub`,
      value: { cents: e.ytd.gross },
      source: "proven",
      link: { label: `${e.employer}, ${year} to date`, descriptor: { report: "pay", basis: "ytd", personId: p.id, employerKeys: [employerKey(e.employer)], year, through: e.latestPayDate, lines: ["gross"] } satisfies PayDescriptor },
    },
  ];
  if (n)
    lines.push({
      op: "+",
      label: `${n} more paychecks × ${money(check)} gross (the ${e.basis === "TYPICAL" ? "typical recent" : "latest"} regular check)`,
      value: { cents: check * n },
      source: "estimate",
      note: `Pay dates ${e.remainingPayDates[0]} – ${e.remainingPayDates.at(-1)}${e.payThrough ? `, ending ${e.payThrough}` : ""}.`,
      ...(p.fromForecast ? { link: seedLink(`${p.name}'s paycheck`, { report: "forecast", figure: "seed", which: "pay", personId: p.id, paycheck: e.basis }) } : {}),
    });
  if (fromForecast && e.extraBonus) lines.push({ op: "+", label: "Bonus still expected (the forecast)", value: { cents: fromForecast }, source: "derived", link: { label: "Bonus still expected", descriptor: { report: "planning", page: "taxes", figure: "bonus-expected", year, personId: p.id } } });
  if (typedExtra) lines.push(signed(typedExtra, { label: "Extra bonus typed under Inputs", source: "assumption" }));
  lines.push({ op: "=", label: `Projected gross pay for ${year}`, value: { cents: e.projected.gross }, source: "derived" });
  const parts = e.ytd.gross + check * n + e.extraBonus;
  return {
    describes: `${p.name} · ${e.employer}: gross pay projected to Dec 31, ${year}`,
    figure: { cents: e.projected.gross },
    selfCheck: sumCheck(e.projected.gross, parts, `Year to date, the paychecks left and the bonus add up to ${money(parts)}`),
    blocks: [{ kind: "chain", title: "Gross pay to Dec 31", lines, note: p.fromForecast ? "The paycheck basis and bonuses come from the shared forecast (Forecast page)." : undefined }, { kind: "breakdown", title: "On the estimate", items: [{ label: "Gross salary for the year", value: { text: "projected" }, link: estLine }] }],
    checks,
    withheld,
    estimates: n ? [{ id: `planning.paychecks:${p.id}`, title: `${n} paychecks after ${e.latestPayDate}`, detail: "The chosen regular check repeated for each pay date left in the year." }] : [],
    through: e.latestPayDate,
  };
}

// ---------------------------------------------------------------------------

function notFound(why: string): Built {
  return { describes: why, figure: { text: "—" }, selfCheck: null, blocks: [{ kind: "breakdown", title: "Nothing to prove", items: [{ label: why, value: { text: "—" } }] }], estimates: [], through: "", withheld: true };
}

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
  } else built = await buildTaxes(ctx, d);
  built = { ...built, blocks: linkCells(b, built.blocks) };
  return { ...base, checks: [], withheld: false, ...built, through: built.through || book.horizon.netWorth };
}

export const planningKind: ProofKind<PlanningDescriptor> = {
  report: "planning",
  parse: parsePlanningDescriptor,
  build: buildPlanningProof,
};
