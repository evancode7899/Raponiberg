import { staleEvidence } from "../exceptions.ts";
import type { Book } from "../load.ts";
import type { CheckPass, IntegrityReport, StandingException } from "../types.ts";
import { checkBonusLetters } from "./bonuses.ts";
import { Collector } from "./collector.ts";
import { checkConsistency } from "./consistency.ts";
import { checkDecisions } from "./decisions.ts";
import { checkCustodianContributions } from "./custodian.ts";
import { checkFreshness } from "./freshness.ts";
import { checkHoldings } from "./holdings.ts";
import { checkHsaContributions } from "./hsa.ts";
import { checkNetWorth } from "./networth.ts";
import { checkPay } from "./pay.ts";
import { checkReadable } from "./readable.ts";
import { checkRetirement } from "./retirement.ts";
import { checkStatements } from "./statements.ts";
import { checkTaxCoverage, checkTaxParams } from "./tax.ts";
import { checkTaxDocuments } from "./taxDocuments.ts";
import { checkTransfers } from "./transfers.ts";

/** Every integrity check, over the whole Book. Order matters: later checks skip what earlier ones block. */
export function runChecks(book: Book, exceptions: StandingException[] = []): IntegrityReport {
  return runChecksWithPasses(book, exceptions).report;
}

/** runChecks, plus what every passing check covered (Book.passes): kept apart from the report. */
export function runChecksWithPasses(book: Book, exceptions: StandingException[] = []): { report: IntegrityReport; passes: CheckPass[] } {
  const c = new Collector(exceptions, book.horizon.netWorth);
  checkReadable(book, c);
  checkConsistency(book, c);
  checkFreshness(book, c);
  checkStatements(book, c);
  checkTransfers(book, c);
  checkDecisions(book, c);
  checkPay(book, c);
  checkRetirement(book, c);
  checkHsaContributions(book, c);
  checkCustodianContributions(book, c);
  checkHoldings(book, c);
  checkBonusLetters(book, c);
  checkTaxCoverage(book, c);
  checkTaxParams(book, c);
  checkTaxDocuments(book, c);
  checkNetWorth(book, c);
  const report = c.report();
  report.stale = report.stale.map((e) => ({ ...e, evidence: staleEvidence(book, report, e) }));
  return { report, passes: c.passes };
}
