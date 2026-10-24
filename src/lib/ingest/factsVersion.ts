/**
 * Bump when an extractor that feeds stored facts changes (pay stub lines, brokerage tax
 * figures, holdings): documents with an older version are re-extracted from their stored
 * file by refreshOutdatedFacts (documentFacts.ts), without touching their statements or
 * rows. That happens at the next app launch (refreshOutdatedFactsOnLaunch, run from
 * instrumentation.ts) and after any import or edit; until then the Book reports them as
 * read by an older extractor.
 */
/**
 * v2: ADP payroll company codes split an employer into separate year-to-date chains. v3: Vanguard brokerage tax figures.
 * v4: holdings (positions at each investment statement's period end). v5: Fidelity UTMA/UGMA accounts are CUSTODIAL.
 * v6: TriNet starred company-paid lines ("LTD*") are imputed income.
 * v7: Vanguard holdings read a lone dash before a "$" amount as an empty column (a position
 * new this period), not a minus on its value.
 */
export const FACTS_VERSION = 7;

/** Parsers whose documents carry facts beyond statement rows. */
export const FACT_PARSERS = [
  "trinet-paystub",
  "vensure-paystub",
  "adp-paystub",
  "fidelity-investment-report",
  "vanguard-brokerage",
  "vanguard-401k",
  "slavic-401k",
  "healthequity-hsa",
];

/** Parsers that read pay stubs (their facts feed pay and taxes). */
export const PAYSTUB_PARSERS = ["trinet-paystub", "vensure-paystub", "adp-paystub"];

/** Parsers whose facts include year-to-date tax figures (they feed taxes, and dividends into cash flow). */
export const TAX_FACT_PARSERS = ["fidelity-investment-report", "vanguard-brokerage"];
