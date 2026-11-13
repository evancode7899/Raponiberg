/**
 * The environment variables that can point the app at data outside its data folder. Kept
 * free of imports so scripts/demo.ts can read it: the demo sets every one of them empty, so
 * none of the owner's real files or folders is ever read or written by the demo.
 */

/**
 * Every data file a figure reads that its env variable can point outside the data folder
 * (each is in the Book's stamp wherever it lives, see book/cache.ts). UNSTAMPED_ENV_FILES
 * are the ones no figure reads (read per request beside the Book); a test holds every
 * `*_FILE` variable the code reads to one list or the other.
 */
export const ENV_FILES = [
  "INTEGRITY_EXCEPTIONS_FILE",
  "TRANSFER_DECISIONS_FILE",
  "BONUS_AWARDS_FILE",
  "BONUS_REVIEWS_FILE",
  "MERCHANT_RULES_FILE",
  "ROW_DECISIONS_FILE",
  "HOUSEHOLD_FILE",
  "REIMBURSEMENT_LINKS_FILE",
  "TAX_DOCUMENTS_FILE",
  "CLOSED_ACCOUNTS_FILE",
  "FUND_DOCUMENTS_FILE",
];
export const UNSTAMPED_ENV_FILES = ["PAGE_INPUTS_FILE", "APP_PASSWORD_FILE", "HSA_EXPENSES_FILE", "HSA_RECEIPTS_FILE", "INSURANCE_DOCUMENTS_FILE", "CARD_REWARDS_FILE"];

/** The folders the app reads the owner's documents from, or backs up into. */
export const ENV_DIRS = ["STATEMENTS_DIR", "TAX_DOCS_DIR", "HSA_RECEIPTS_DIR", "BACKUP_DIR"];

/** Everything the demo must not inherit. */
export const REAL_DATA_ENV = [...ENV_FILES, ...UNSTAMPED_ENV_FILES, ...ENV_DIRS];
