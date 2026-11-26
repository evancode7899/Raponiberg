import { buildForecast, type Forecast } from "../../../forecast/forecast.ts";
import { type ForecastData, forecastInputs } from "../../../forecast/load.ts";
import { monthPeriods, yearPeriods } from "../../../forecast/periods.ts";
import { formatPercentRatio, formatUsdFromCents } from "../../../formatMoney.ts";
import type { OutlookSeeds } from "../../../profile/basePay.ts";
import type { LivingBasis, OutlookAssumptions } from "../../../profile/settings.ts";
import type { Book } from "../../load.ts";
import { checksFor } from "../common.ts";
import { type ForecastDescriptor, type LedgerLine, ledgerValue } from "../forecastProof.ts";
import { NET_WORTH_CHECKS } from "../netWorthProof.ts";
import type { ChainLine, Proof, ProofBlock, ProofCheck, ProofEstimate, ProofLink } from "../types.ts";

/** Shared by the planning proofs (planningProof.ts): the forecast base each starts from, its chain lines, and links into forecast cells. */

export const money = (c: number) => (c === 0 ? "$0.00" : formatUsdFromCents(c));
export const pct = (r: number, digits = 2) => formatPercentRatio(r, digits);
export const cents = (dollars: number) => Math.round(dollars * 100);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Mar 2031" from YYYY-MM(-DD). */
export const monthWord = (key: string) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
/** The month before YYYY-MM. */
export const prevKey = (key: string) => {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};
const LIVING: LivingBasis[] = ["TRAILING_12", "LAST_YEAR", "THIS_YEAR"];

/** A signed adjustment as a chain line: "+" or "−" by its sign, the value shown positive. */
export const signed = (c: number, line: Omit<ChainLine, "op" | "value">): ChainLine => ({ ...line, op: c < 0 ? "−" : "+", value: { cents: Math.abs(c) } });

/** A forecast ledger cell: a line over the months `month` through `through` (one month when omitted). */
type MonthCell = { month: string; through?: string; line: LedgerLine };
type CellDescriptor = Extract<ForecastDescriptor, { figure: "month" }>;
const cellDescriptor = (c: MonthCell): CellDescriptor => ({ report: "forecast", figure: "month", month: c.month, ...(c.through && c.through !== c.month ? { through: c.through } : {}), line: c.line });
/** A forecast year's column, Jan–Dec. */
export const yearCell = (year: number, line: LedgerLine): MonthCell => ({ month: `${year}-01`, through: `${year}-12`, line });

/** A projected line waiting for its cell's link (see `linkCells`). */
export type Projected = ChainLine & { cell?: MonthCell };

/**
 * A projected value: the forecast's figure for a future month (or year), an estimate.
 * `cell` is the forecast ledger cell it is, or null when no ledger line holds it (the
 * caller says why); `linkCells` links it once the cell is checked to hold this value.
 */
export function projected(op: ChainLine["op"], label: string, value: number, cell: MonthCell | null, note: string): Projected {
  return { ...(op ? { op } : {}), label, value: { cents: value }, source: "estimate", note, ...(cell ? { cell } : {}) };
}

/**
 * Each projected line's link to its forecast ledger cell, read the way the forecast proof
 * reads it (the saved forecast's year and month columns, periods.ts, as forecastProof's
 * columnsOf): only a cell holding exactly the line's value is linked, so a link never opens
 * a different number (a year past the forecast's horizon, a plan the forecast doesn't run).
 */
export function linkCells(b: Base | null, blocks: ProofBlock[]): ProofBlock[] {
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

export const seedLink = (label: string, descriptor: ForecastDescriptor): ProofLink => ({ label, descriptor });
export const START = seedLink("The forecast's starting point", { report: "forecast", figure: "seed", which: "start" });

export type Built = Omit<Proof, "report" | "descriptor" | "today" | "checks" | "withheld"> & { checks?: ProofCheck[]; withheld?: boolean };

/** What every forecast-fed figure stands on: the Book, the forecast's data and the forecast on the saved drivers (FIRE's settings put in). */
export type Base = { book: Book; data: ForecastData; seeds: OutlookSeeds; a: OutlookAssumptions; f: Forecast; saved: Forecast };

export function baseFrom(book: Book, data: ForecastData, patch: Partial<OutlookAssumptions> = {}): Base | null {
  const inputs = forecastInputs(data);
  if (!inputs) return null;
  const a = { ...data.profile.settings.outlook, ...patch };
  const f = buildForecast(inputs, a);
  // The forecast on the saved drivers, as the forecast ledger's cells are read (FIRE's own settings don't move a working month, but a cell is checked against this).
  return { book, data, seeds: inputs.seeds, a, f, saved: Object.keys(patch).length ? buildForecast(inputs, data.profile.settings.outlook) : f };
}

export function withheldProof(book: Book, data: ForecastData): Built {
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

export const startNetWorth = (b: Base) => b.f.plan.start.liquid + b.f.plan.start.illiquid;

export function startLine(b: Base, op?: ChainLine["op"]): ChainLine {
  return { ...(op ? { op } : {}), label: `Net worth at the end of ${b.seeds.start.asOf}`, value: { cents: startNetWorth(b) }, source: "proven", note: "The latest proven balances: where the forecast starts.", link: START };
}

/** The forecast's living cost a year: typed on the Forecast page, or a seed read off Cash flow. */
export function livingLine(b: Base, op?: ChainLine["op"], label = "Living cost a year"): ChainLine {
  const l = b.f.pay.living;
  const basis = LIVING.find((x) => b.seeds.living[x] === l.seed);
  if (l.typed || !basis) return { ...(op ? { op } : {}), label: `${label} (typed on the Forecast page)`, value: { cents: l.cents }, source: "assumption" };
  return { ...(op ? { op } : {}), label: `${label} (${l.seed!.label.toLowerCase()})`, value: { cents: l.cents }, source: "derived", note: "Cash flow's spending less taxes, one-offs and reimbursements.", link: seedLink("Living cost", { report: "forecast", figure: "seed", which: "living", basis }) };
}

/** The forecast's drivers a projection rests on. */
export function driversBlock(b: Base, extra: ChainLine[] = []): ProofBlock {
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

export const forecastChecks = (b: Base) => checksFor(b.book, { affects: "NET_WORTH", from: b.seeds.start.asOf, to: b.seeds.start.asOf }, NET_WORTH_CHECKS);

export const projectionEstimate = (b: Base): ProofEstimate => ({
  id: "planning.forecast",
  title: `Months after ${b.seeds.start.asOf} are the forecast's projection`,
  detail: "Pay, bonuses, living cost and returns on the saved drivers; nothing after the latest proven balances is read off a statement.",
});


export function notFound(why: string): Built {
  return { describes: why, figure: { text: "—" }, selfCheck: null, blocks: [{ kind: "breakdown", title: "Nothing to prove", items: [{ label: why, value: { text: "—" } }] }], estimates: [], through: "", withheld: true };
}
