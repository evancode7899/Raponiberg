"use client";

import { BlockedValue } from "@/components/ledger/Blocked";
import { StatementTable } from "@/components/ui/kit";
import type { BlockerRef } from "@/lib/book/reports/blockerRef";
import { formatPercentRatio, usd0 } from "@/lib/formatMoney";

export type { TableRow } from "@/components/ui/kit";
export { axisUsd } from "@/lib/formatMoney";

/** Whole dollars from cents; exact zero shows an em dash, negatives in parentheses. */
export const usd = usd0;
export const pct = (r: number | null | undefined, digits = 1) => (r == null ? "—" : formatPercentRatio(r, digits));

export type Cell = { text: React.ReactNode; title?: string; dim?: boolean } | null;

/** Year-per-column statement table (shared with Taxes). */
export const YearTable = StatementTable;

/** A table cell for a figure that can't be proven. */
export const blockedCell = (blockers: BlockerRef[]): Cell => ({ text: <BlockedValue blockers={blockers} /> });
