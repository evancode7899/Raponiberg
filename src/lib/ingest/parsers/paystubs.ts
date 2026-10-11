import { detectAdp, detectTrinet, detectVensure, stubChecks, type PayStubFacts } from "../payroll/index.ts";
import { extractAdpStubs } from "../payroll/adp.ts";
import { extractTrinetStub } from "../payroll/trinet.ts";
import { extractVensureStubs } from "../payroll/vensure.ts";
import type { ParsedDocument } from "../types.ts";

/**
 * Pay stubs are enrichment, never cash flow: the net pay already lands in checking as
 * an income deposit and retirement deferrals already appear on the 401(k) statements.
 * A stub explains a deposit (gross → taxes → deferrals → net) and is the record of pay
 * for the profile and taxes. Each provider has exactly one extractor
 * (src/lib/ingest/payroll); these parsers only wrap its output as a document.
 */

export { detectAdp, detectTrinet, detectVensure };
export const TRINET_PARSER_ID = "trinet-paystub";
export const VENSURE_PARSER_ID = "vensure-paystub";
export const ADP_PARSER_ID = "adp-paystub";
/** v3: one extractor per provider with every line item and printed total. */
/** Bump when a change would read already-imported documents differently (re-import them with --reparse-outdated). */
export const VERSION = 3;

export function parseTrinet(text: string): ParsedDocument {
  const s = extractTrinetStub(text);
  if (!s) throw new Error("TriNet: check date not found");
  return stubDocument(TRINET_PARSER_ID, "TriNet", [s]);
}

export function parseVensure(text: string): ParsedDocument {
  const stubs = extractVensureStubs(text);
  if (stubs.length === 0) throw new Error("Vensure: no pay stubs found");
  return stubDocument(VENSURE_PARSER_ID, "Vensure", stubs);
}

/**
 * ADP's plain text scrambles the earnings/deductions columns, so the line items come
 * from the positioned layout extractPdfText appends. Without it there is nothing
 * trustworthy to read, so the stub is refused rather than half-read.
 */
export function parseAdp(text: string): ParsedDocument {
  const stubs = extractAdpStubs(text);
  if (stubs.length === 0) throw new Error("ADP: no stub found in the positioned layout");
  return stubDocument(ADP_PARSER_ID, "ADP", stubs);
}

function stubDocument(parserId: string, provider: string, stubs: PayStubFacts[]): ParsedDocument {
  const dates = stubs.map((s) => s.payDate).sort();
  const warnings = stubs.flatMap((s) => [
    ...s.warnings.map((w) => `${s.payDate}: ${w}`),
    ...stubChecks(s)
      .filter((c) => !c.ok)
      .map((c) => `${s.payDate}: ${c.label} — expected ${(c.expected / 100).toFixed(2)}, lines give ${(c.actual / 100).toFixed(2)}`),
  ]);
  return {
    parserId,
    parserVersion: VERSION,
    institution: provider,
    kind: "PAYSTUB",
    title: `${provider} pay stub${stubs.length > 1 ? `s (${stubs.length})` : ""}`,
    periodStart: dates[0]!,
    periodEnd: dates.at(-1)!,
    sections: [],
    payStubs: stubs,
    warnings,
  };
}
