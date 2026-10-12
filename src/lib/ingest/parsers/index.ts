import { NO_HOUSEHOLD, type HouseholdPatterns } from "../../household/patterns.ts";
import type { ParsedDocument } from "../types.ts";
import { detectAmex, parseAmex, VERSION as AMEX } from "./amex.ts";
import { detectAmexSavings, parseAmexSavings, VERSION as AMEX_SAVINGS } from "./amexSavings.ts";
import { detectBilt, parseBilt, VERSION as BILT } from "./bilt.ts";
import { detectCapitalOne, parseCapitalOne, VERSION as CAPITAL_ONE } from "./capitalOne.ts";
import { detectChase, parseChase, VERSION as CHASE } from "./chase.ts";
import { detectChaseCard, parseChaseCard, VERSION as CHASE_CARD } from "./chaseCard.ts";
import { detectLpCapitalStatement, parseLpCapitalStatement, VERSION as LP_CAPITAL } from "./lpCapitalStatement.ts";
import { detectEmpower, parseEmpower, VERSION as EMPOWER } from "./empower.ts";
import { detectFidelity, parseFidelity, VERSION as FIDELITY } from "./fidelity.ts";
import { detectHealthEquity, parseHealthEquity, VERSION as HEALTHEQUITY } from "./healthequity.ts";
import { detectAdp, detectTrinet, detectVensure, parseAdp, parseTrinet, parseVensure, VERSION as PAYSTUBS } from "./paystubs.ts";
import { detectRentBill, parseRentBill, VERSION as RENT_BILL } from "./rentBill.ts";
import { detectSlavic, parseSlavic, VERSION as SLAVIC } from "./slavic.ts";
import { detectSupporting, parseSupporting, VERSION as SUPPORTING } from "./supporting.ts";
import { detectVanguard401k, parseVanguard401k, VERSION as VANGUARD_401K } from "./vanguard401k.ts";
import { detectVanguardBrokerage, parseVanguardBrokerage, VERSION as VANGUARD_BROKERAGE } from "./vanguardBrokerage.ts";

type Parser = {
  id: string;
  /** The parser's current version: documents stored by an older one are re-read with --reparse-outdated. */
  version: number;
  detect: (text: string) => boolean;
  /** `household` (lib/household) for the parsers that file a document under the household's own funds. */
  parse: (text: string, household: HouseholdPatterns) => ParsedDocument;
};

/**
 * Deterministic, institution-specific parsers, tried in order. A new institution is a
 * new entry here plus its parser file; anything no parser recognizes is routed to the
 * manual (hand-parsed JSON) path instead of being guessed at. Supporting documents go
 * first so a year-end recap that mentions "Closing Date" is never taken for a statement.
 */
export const PARSERS: Parser[] = [
  { id: "supporting-document", version: SUPPORTING, detect: detectSupporting, parse: parseSupporting },
  { id: "yardi-rent-bill", version: RENT_BILL, detect: detectRentBill, parse: parseRentBill },
  { id: "chase-checking", version: CHASE, detect: detectChase, parse: parseChase },
  { id: "chase-card", version: CHASE_CARD, detect: detectChaseCard, parse: parseChaseCard },
  { id: "amex-high-yield-savings", version: AMEX_SAVINGS, detect: detectAmexSavings, parse: parseAmexSavings },
  { id: "bilt-card", version: BILT, detect: detectBilt, parse: parseBilt },
  { id: "capital-one-card", version: CAPITAL_ONE, detect: detectCapitalOne, parse: parseCapitalOne },
  { id: "amex-card", version: AMEX, detect: detectAmex, parse: parseAmex },
  { id: "fidelity-investment-report", version: FIDELITY, detect: detectFidelity, parse: parseFidelity },
  { id: "empower-401k", version: EMPOWER, detect: detectEmpower, parse: parseEmpower },
  { id: "slavic-401k", version: SLAVIC, detect: detectSlavic, parse: parseSlavic },
  { id: "vanguard-401k", version: VANGUARD_401K, detect: detectVanguard401k, parse: parseVanguard401k },
  { id: "vanguard-brokerage", version: VANGUARD_BROKERAGE, detect: detectVanguardBrokerage, parse: parseVanguardBrokerage },
  { id: "healthequity-hsa", version: HEALTHEQUITY, detect: detectHealthEquity, parse: parseHealthEquity },
  { id: "lp-capital-statement", version: LP_CAPITAL, detect: detectLpCapitalStatement, parse: parseLpCapitalStatement },
  { id: "trinet-paystub", version: PAYSTUBS, detect: detectTrinet, parse: parseTrinet },
  { id: "vensure-paystub", version: PAYSTUBS, detect: detectVensure, parse: parseVensure },
  { id: "adp-paystub", version: PAYSTUBS, detect: detectAdp, parse: parseAdp },
];

/** Each parser's current version, by parser id. */
export const PARSER_VERSIONS: Readonly<Record<string, number>> = Object.fromEntries(PARSERS.map((p) => [p.id, p.version]));

export type ParseOutcome =
  | { ok: true; parserId: string; doc: ParsedDocument }
  | { ok: false; reason: "UNRECOGNIZED" }
  | { ok: false; reason: "PARSE_ERROR"; parserId: string; error: string };

export function parseStatementText(text: string, household: HouseholdPatterns = NO_HOUSEHOLD): ParseOutcome {
  const parser = PARSERS.find((p) => p.detect(text));
  if (!parser) return { ok: false, reason: "UNRECOGNIZED" };
  try {
    return { ok: true, parserId: parser.id, doc: parser.parse(text, household) };
  } catch (e) {
    return {
      ok: false,
      reason: "PARSE_ERROR",
      parserId: parser.id,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
