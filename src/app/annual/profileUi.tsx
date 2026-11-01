"use client";

import type { FigureProps } from "@/components/ui/proof/ProofValue";
import { StatementTable } from "@/components/ui/kit";
import type { ProofRef } from "@/components/ui/proof/context";
import type { BlockerRef } from "@/lib/book/reports/blockerRef";
import { formatPercentRatio, usd0 } from "@/lib/formatMoney";
import { noFigure, unswept } from "@/lib/book/proof/clearance";

export type { TableRow } from "@/components/ui/kit";
export { axisUsd } from "@/lib/formatMoney";

/** Whole dollars from cents; exact zero shows an em dash, negatives in parentheses. */
export const usd = usd0;
export const pct = (r: number | null | undefined, digits = 1) => (r == null ? "—" : formatPercentRatio(r, digits));

export type Cell = { text: React.ReactNode; title?: string; dim?: boolean; proof: ProofRef; blockers?: BlockerRef[]; drawn?: FigureProps["drawn"] } | null;

/** Year-per-column statement table (shared with Taxes). */
export const YearTable = StatementTable;

/** A table cell for a figure that can't be proven: withheld, its findings in the drawer. */
export const blockedCell = (blockers: BlockerRef[]): Cell => ({ text: "", proof: unswept("blocked"), blockers });

/** A cell with nothing to show (no value for that year). */
export const emptyCell = (why: string): Cell => ({ text: "—", proof: noFigure(why) });
