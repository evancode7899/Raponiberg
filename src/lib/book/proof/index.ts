import { cashFlowKind, type CashFlowDescriptor } from "./cashFlowProof.ts";
import { netWorthKind, type NetWorthDescriptor } from "./netWorthProof.ts";
import { payKind, type PayDescriptor } from "./payProof.ts";
import { investmentsKind, type InvestmentsDescriptor } from "./investmentsProof.ts";
import { filedReturnKind, type FiledReturnDescriptor } from "./filedReturnProof.ts";
import { hsaKind, type HsaDescriptor } from "./hsaProof.ts";
import { carKind, type CarDescriptor } from "./carProof.ts";
import { forecastKind, type ForecastDescriptor } from "./forecastProof.ts";
import { taxEstimateKind, type TaxEstimateDescriptor } from "./taxEstimateProof.ts";
import { bonusesKind, type BonusesDescriptor } from "./bonusesProof.ts";
import { planningKind, type PlanningDescriptor } from "./planningProof.ts";
import { annualKind, type AnnualDescriptor } from "./annualProof.ts";
import { dashboardKind, type DashboardDescriptor } from "./dashboardProof.ts";
import { accountLimitsKind, type AccountLimitsDescriptor } from "./accountLimitsProof.ts";
import { statementKind, type StatementDescriptor } from "./statementProof.ts";
import { findRow, rowKind, type RowDescriptor } from "./rowProof.ts";
import { stubKind, type StubDescriptor } from "./stubProof.ts";
import { derivedKind, type DerivedDescriptor } from "./derivedProof.ts";
import type { Book } from "../load.ts";
import type { Proof, ProofContext, ProofKind } from "./types.ts";

/**
 * Every kind of proof the app can show, by the `report` its descriptors name.
 *
 * Adding one (net worth, pay, the forecast…):
 *  1. A module beside cashFlowProof.ts exporting its descriptor type and a ProofKind:
 *     `parse` validates a request body, `build` re-derives the figure from the Book and
 *     returns a Proof (types.ts) made of rows / breakdown / chain blocks. The drawer
 *     draws those as they are: a kind needs no UI of its own.
 *  2. Its descriptor in the ProofDescriptor union and its kind in KINDS, below.
 *  3. Tests with invented fixtures: the parts re-add to the figure (selfCheck.ok), and
 *     every link it emits parses and builds (see index.test.ts).
 * Below every kind sit three that prove a source itself: one statement as it prints
 * (statement), one ledger row (row), one pay stub (stub). Rows and statements listed in
 * any proof open them (linkSources), so every figure can be followed to the printed line.
 * Checks over the figure come from checksFor (common.ts), with the list of checks that
 * can withhold that kind of figure.
 */
export type ProofDescriptor = CashFlowDescriptor | NetWorthDescriptor | PayDescriptor | InvestmentsDescriptor | FiledReturnDescriptor | HsaDescriptor | CarDescriptor | ForecastDescriptor | TaxEstimateDescriptor | BonusesDescriptor | PlanningDescriptor | AnnualDescriptor | DashboardDescriptor | AccountLimitsDescriptor | StatementDescriptor | RowDescriptor | StubDescriptor | DerivedDescriptor;

const KINDS: { [R in ProofDescriptor["report"]]: ProofKind<Extract<ProofDescriptor, { report: R }>> } = {
  "cash-flow": cashFlowKind,
  "net-worth": netWorthKind,
  pay: payKind,
  investments: investmentsKind,
  "filed-return": filedReturnKind,
  hsa: hsaKind,
  car: carKind,
  forecast: forecastKind,
  "tax-estimate": taxEstimateKind,
  bonuses: bonusesKind,
  planning: planningKind,
  annual: annualKind,
  dashboard: dashboardKind,
  "account-limits": accountLimitsKind,
  statement: statementKind,
  row: rowKind,
  stub: stubKind,
  derived: derivedKind,
};

const kindOf = (report: string) => (Object.hasOwn(KINDS, report) ? (KINDS[report as ProofDescriptor["report"]] as ProofKind<ProofDescriptor>) : null);

/** A descriptor from a request body, or why it's not one. */
export function parseDescriptor(body: unknown): ProofDescriptor | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Expected a JSON object." };
  const d = body as Record<string, unknown>;
  const kind = typeof d.report === "string" ? kindOf(d.report) : null;
  if (!kind) return { error: `report must be one of: ${Object.keys(KINDS).join(", ")}.` };
  return kind.parse(d);
}

/** The proof behind the figure a descriptor names, every row and statement in it that is the Book's own marked so the drawer can open it. */
export async function buildProof(ctx: ProofContext, d: ProofDescriptor): Promise<Proof> {
  return linkSources(ctx.book, await kindOf(d.report)!.build(ctx, d));
}

/**
 * Marks the rows and statements a proof lists that are the Book's own (rowId, importId),
 * so each opens its row or statement proof: done here, once, so no kind can forget and
 * any figure can be followed down to the printed line. A row id a kind made up (a
 * balance line, a statement's market change) matches nothing and stays plain; a kind that
 * lists a Book row under an id of its own sets rowId itself.
 */
export function linkSources(book: Book, p: Proof): Proof {
  const statements = new Set(book.statements.map((s) => s.id));
  const blocks = p.blocks.map((b) =>
    b.kind !== "rows"
      ? b
      : {
          ...b,
          groups: b.groups.map((g) => ({
            ...g,
            statement: g.statement.importId || !statements.has(g.statement.id) ? g.statement : { ...g.statement, importId: g.statement.id },
            rows: g.rows.map((r) => (r.rowId || !findRow(book, r.id) ? r : { ...r, rowId: r.id })),
          })),
        },
  );
  return { ...p, blocks };
}

export type { Proof, ProofBlock, ProofLink } from "./types.ts";
