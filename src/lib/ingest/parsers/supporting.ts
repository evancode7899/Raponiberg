import { NO_HOUSEHOLD, type HouseholdPatterns } from "../../household/patterns.ts";
import type { ParsedDocument } from "../types.ts";
import { parseMonthNameDate } from "../text.ts";

export const SUPPORTING_PARSER_ID = "supporting-document";
/** Bump when a change would read already-imported documents differently: they are read again on the next folder scan or launch. */
export const VERSION = 1;

/** A private fund's paperwork is filed with the fund it names, or the household's only fund. */
const FUND = (text: string, h: HouseholdPatterns) =>
  (h.funds.find((f) => text.includes(f.statementName)) ?? (h.funds.length === 1 ? h.funds[0] : undefined))?.institution ?? "Private fund";

type Kind = { title: string; institution: string | ((text: string, h: HouseholdPatterns) => string); test: RegExp };

/**
 * Documents worth keeping alongside the ledger that must never add money to it: spend
 * recaps that duplicate monthly statements, tax forms, confirmation letters, plan
 * marketing. Recognizing them explicitly is what stops them from being mistaken for
 * statements (and double-counted) or bounced as "unrecognized".
 */
const KINDS: Kind[] = [
  { title: "Amex year-end spending summary", institution: "American Express", test: /Year-End Summary[\s\S]*Includes charges from/ },
  { title: "401(k) distribution confirmation", institution: "Empower", test: /RE: Distribution Confirmation/ },
  { title: "401(k) transfer/rebalance confirmation", institution: "Empower", test: /RE: Transfer Confirmation/ },
  { title: "Form 1099-R", institution: "Tax form", test: /Form 1099-R/ },
  // Private fund paperwork: calls are settled by the bank's wire, the capital statement carries the balance.
  { title: "Fund capital call notice", institution: FUND, test: /CAPITAL CALL NOTICE|2\.10 LP Commitment/ },
  { title: "Fund quarterly letter", institution: FUND, test: /QUARTERLY LETTER - Q\d \d{4}/ },
  { title: "Fund notice", institution: FUND, test: /NOTICE OF ASSIGNMENT|WRITTEN RESOLUTION OF THE GENERAL PARTNER/ },
  { title: "Fund audited financial statements", institution: FUND, test: /AUDITED COMBINED FINANCIAL STATEMENTS/ },
  { title: "Schedule K-1 (Form 1065)", institution: "Tax form", test: /Schedule K-1\s+\(Form 1065\)/ },
  { title: "Retirement plan notice", institution: "Empower", test: /Changing jobs or retiring\?/ },
];

export function detectSupporting(text: string): boolean {
  return KINDS.some((k) => k.test.test(text));
}

export function parseSupporting(text: string, household: HouseholdPatterns = NO_HOUSEHOLD): ParsedDocument {
  const kind = KINDS.find((k) => k.test.test(text))!;
  const dated = parseMonthNameDate(text);
  return {
    parserId: SUPPORTING_PARSER_ID,
    parserVersion: VERSION,
    institution: typeof kind.institution === "function" ? kind.institution(text, household) : kind.institution,
    kind: "SUPPORTING",
    title: kind.title,
    periodStart: dated,
    periodEnd: dated,
    sections: [],
    warnings: [],
  };
}
