import { noFigure, type Unswept } from "../proof/clearance.ts";
import type { BlockerQuery } from "../blockers.ts";
import type { CheckId } from "../types.ts";
import type { ChainLine, ProofLink, ProofValue } from "../proof/types.ts";

/**
 * Derived figures: what a page works out from its own report beyond the figures a proof
 * kind of their own re-derives from the Book (a fund cost, a fuel economy, a count of
 * merchants, how many checks pass). Each page lists them in one pure function over the
 * report its route serves (derived/<page>.ts): the page renders the value and recipe from
 * that list, the proof sweep enumerates the same list (proof/figures.ts), and the "derived"
 * proof kind (proof/derivedProof.ts) rebuilds the report on the server and shows how the
 * figure is worked out. So a page can't show a derived figure the sweep never held to its
 * proof: swept = rendered, by construction.
 *
 * The proof re-reads the page's own report, so it catches a page that drifts from the
 * server (and any figure changed on the way); what it doesn't do is re-derive the report
 * independently (F5's independent proofs).
 */

export type DerivedPage = "investments" | "car" | "cash-flow" | "card-perks" | "net-worth" | "integrity" | "hsa" | "account-limits" | "calendar" | "lp-funds" | "insurance" | "taxes" | "forecast";

export type DerivedDescriptor = {
  report: "derived";
  page: DerivedPage;
  figure: string;
  /** Which one, where the page shows the figure for several (a car, a fund, a policy, a window of months). */
  key?: string;
};

export type DerivedFigure = {
  figure: string;
  key?: string;
  /** Plain words: what the figure is. */
  describes: string;
  /** Null where the page has nothing to show yet (no fill-ups, no warranty set): a dash, not a figure. */
  value: ProofValue | null;
  /** How it is worked out from the report, line by line ("=" lines are held to re-add). */
  lines: ChainLine[];
  /** The parts it is made of, when there are many (positions, merchants, policies). */
  parts?: { label: string; value: ProofValue; sub?: string; link?: ProofLink }[];
  note?: string;
  /** The checks over the data it reads, when not the page's (derived/load.ts): an open finding withholds it. */
  scope?: DerivedScope;
};

/** The findings that can withhold a derived figure: the data it reads, and which checks look at it. */
export type DerivedScope = { query: BlockerQuery | BlockerQuery[]; checks: CheckId[] };

/** A derived figure's key within its page: the figure, and which one. */
export const derivedKey = (f: Pick<DerivedFigure, "figure" | "key">) => (f.key != null ? `${f.figure}|${f.key}` : f.figure);

export const derivedDescriptor = (page: DerivedPage, f: Pick<DerivedFigure, "figure" | "key">): DerivedDescriptor => ({ report: "derived", page, figure: f.figure, ...(f.key != null ? { key: f.key } : {}) });

/** What a page hands a figure component: the recipe and the value it shows, held to the cleared one. */
export type DerivedTarget = { descriptor: DerivedDescriptor; shownCents: number | null; shown?: ProofValue };

/** A derived figure's target, looked up in the page's list: the value shown is the list's own. */
export function derivedTarget(page: DerivedPage, list: readonly DerivedFigure[], figure: string, key?: string): DerivedTarget | Unswept {
  const f = list.find((x) => x.figure === figure && (x.key ?? null) === (key ?? null));
  if (!f) return { unswept: `${page} lists no "${figure}"${key ? ` for ${key}` : ""}` };
  if (!f.value) return noFigure(f.describes);
  return { descriptor: derivedDescriptor(page, f), shownCents: "cents" in f.value ? f.value.cents : null, ...("cents" in f.value ? {} : { shown: f.value }) };
}

/** A derived figure's value as a number (cents or ratio), for display; null for words. */
export const derivedNumber = (list: readonly DerivedFigure[], figure: string, key?: string): number | null => {
  const v = list.find((x) => x.figure === figure && (x.key ?? null) === (key ?? null))?.value;
  return v == null ? null : "cents" in v ? v.cents : "ratio" in v ? v.ratio : null;
};

/** A derived figure's words (a pattern, a count) as the list states them, or a dash. */
export const derivedText = (list: readonly DerivedFigure[], figure: string, key?: string): string => {
  const v = list.find((x) => x.figure === figure && (x.key ?? null) === (key ?? null))?.value;
  return v && "text" in v ? v.text : "—";
};

// Chain helpers.
export const c = (cents: number): ProofValue => ({ cents });
export const r = (ratio: number): ProofValue => ({ ratio });
export const t = (text: string): ProofValue => ({ text });
export const ln = (label: string, value: ProofValue, op?: ChainLine["op"], extra: Partial<ChainLine> = {}): ChainLine => ({ label, value, source: "derived", ...(op ? { op } : {}), ...extra });

/** A cell of a report's table as a derived figure's key: the table's scope (a year), its row and its column. */
export const cellKey = (scope: string | number, row: string, col: string | number) => `${scope}|${row}|${col}`;

/** A cell of a report's table, as the table states it. */
export type TableCell = { row: string; col: string | number; describes: string; value: ProofValue | null; note?: string };

/**
 * A table of a report's numbers as derived figures, one per cell (figure: the table; key:
 * cellKey). Each is the number as the page's report works it out: the page draws the cell
 * from this list and the sweep holds the same list, so no cell can show without its proof.
 */
export const tableFigures = (figure: string, scope: string | number, cells: TableCell[]): DerivedFigure[] =>
  cells.map((x) => ({ figure, key: cellKey(scope, x.row, x.col), describes: x.describes, value: x.value, lines: x.value ? [ln(x.describes, x.value)] : [], ...(x.note ? { note: x.note } : {}) }));
