"use client";

import { ProofValue } from "@/components/ui/proof/ProofValue";

import { medicalDerived } from "@/lib/book/derived/medical";
import { derivedTarget, type DerivedFigure } from "@/lib/book/derived/types";
import { formatUsdFromCents } from "@/lib/formatMoney";

import type { MedicalPage } from "@/lib/medical/page";

import type { Coverage, EobBalance } from "@/lib/medical/types";
import { useMemo } from "react";

import { dateLabel, monthName } from "@/lib/dates/display";

/** The Medical page's shared pieces: labels, money, and each figure's proof from the page's list. */
export const URL = "/api/medical";
export const TABS = ["overview", "claims", "providers", "plan", "documents"] as const;
export const COVERAGE_LABEL: Record<Coverage, string> = { MEDICAL: "Medical", DENTAL: "Dental", VISION: "Vision" };

export const money = (cents: number) => (cents === 0 ? "$0.00" : formatUsdFromCents(cents));
export const shortDate = (d: string) => dateLabel(d);
export const monthLabel = (m: string) => monthName(m);
export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
export const PER_LABEL: Record<string, string> = { CALENDAR_YEAR: "a calendar year", PLAN_YEAR: "a plan year", "12_MONTHS": "every 12 months", "24_MONTHS": "every 24 months", "36_MONTHS": "every 36 months", "60_MONTHS": "every 60 months", "3_YEARS": "every 3 years", "10_YEARS": "every 10 years", LIFETIME: "a lifetime" };
export const SHORT_KIND: Record<EobBalance["kind"], string> = { DEDUCTIBLE: "deductible", OUT_OF_POCKET: "out-of-pocket", ANNUAL_MAXIMUM: "annual maximum" };

/** The page's figures and a lookup into them: every amount drawn here is one of these. */
export function useFigures(data: MedicalPage | null) {
  const list = useMemo<DerivedFigure[]>(() => (data ? medicalDerived(data) : []), [data]);
  return (figure: string, key?: string) => derivedTarget("medical", list, figure, key);
}
export type Fig = ReturnType<typeof useFigures>;

/** An amount from the page's figures, drawn as the figure says. */
export function Amt({ fig, figure, k, cents }: { fig: Fig; figure: string; k: string; cents: number }) {
  return <ProofValue proof={fig(figure, k)}>{money(cents)}</ProofValue>;
}
