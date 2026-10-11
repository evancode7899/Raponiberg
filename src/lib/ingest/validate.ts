import { addDays, isIsoDate } from "../dates/isoDate.ts";
import type { ParsedAccountSection, ParsedDocument } from "./types.ts";

/**
 * How far outside its statement period a row may be dated. Card statements list purchases
 * a few days before the period (posted after the previous one closed); anything further is
 * a misread date.
 */
export const OUTSIDE_PERIOD_DAYS = 10;

export type SectionValidation = {
  accountNumber: string;
  /** closing − (opening + Σtransactions + growth + fees); 0 when the section ties out. */
  deltaCents: number;
  failedChecks: { label: string; expectedCents: number; actualCents: number }[];
  problems: string[];
  ok: boolean;
};

export type DocumentValidation = {
  ok: boolean;
  sections: SectionValidation[];
  problems: string[];
};

/**
 * A section ties out when its own printed balances are explained exactly by the parsed
 * rows plus (for valuation accounts) the printed market change and fees, and every
 * statement subtotal the parser cross-checked matches. This is what makes a parse
 * trustworthy without trusting the parser.
 */
export function validateSection(s: ParsedAccountSection): SectionValidation {
  const problems: string[] = [];
  if (!isIsoDate(s.periodStart) || !isIsoDate(s.periodEnd)) problems.push("Invalid period dates");
  else if (s.periodStart > s.periodEnd) problems.push("Period starts after it ends");
  for (const t of s.transactions) {
    if (!isIsoDate(t.date)) problems.push(`Invalid transaction date: ${t.date}`);
    else if (isIsoDate(s.periodStart) && isIsoDate(s.periodEnd) && (t.date < addDays(s.periodStart, -OUTSIDE_PERIOD_DAYS) || t.date > addDays(s.periodEnd, OUTSIDE_PERIOD_DAYS)))
      // Still ties to the cent, but lands in the wrong period: typically a year read wrong
      // on a statement that spans New Year.
      problems.push(`Transaction dated ${t.date} is outside the statement period ${s.periodStart} – ${s.periodEnd}`);
    if (!Number.isInteger(t.amountCents)) problems.push(`Non-integer amount on ${t.date}`);
  }
  if (!s.accountNumber || s.accountNumber === "unknown") problems.push("Account number not found");
  if (s.feesCents > 0) problems.push("Fees must be ≤ 0");

  const sum = s.transactions.reduce((a, t) => a + t.amountCents, 0);
  const deltaCents = s.closingBalanceCents - (s.openingBalanceCents + sum + s.growthCents + s.feesCents);
  const failedChecks = s.checks.filter(
    (c) => Math.abs(c.expectedCents - c.actualCents) > (c.toleranceCents ?? 0),
  );
  return {
    accountNumber: s.accountNumber,
    deltaCents,
    failedChecks,
    problems,
    ok: deltaCents === 0 && failedChecks.length === 0 && problems.length === 0,
  };
}

export function validateDocument(doc: ParsedDocument): DocumentValidation {
  const problems: string[] = [];
  if (doc.kind === "STATEMENT" && doc.sections.length === 0) problems.push("Statement has no account sections");
  const numbers = doc.sections.map((s) => `${s.accountNumber}|${s.isSummary ?? doc.kind === "PERIOD_SUMMARY"}`);
  if (new Set(numbers).size !== numbers.length) problems.push("Same account appears twice in one document");
  if (doc.kind === "PAYSTUB" && !doc.payStubs?.length) problems.push("Pay stub data missing");
  const sections = doc.sections.map(validateSection);
  return {
    ok: problems.length === 0 && sections.every((s) => s.ok),
    sections,
    problems,
  };
}
