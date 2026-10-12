/**
 * Version of the classification rules (classify.ts, merchants.ts, taxonomy.ts). Every
 * ledger refresh re-runs the current rules over the rows the owner hasn't corrected by
 * hand and records this version; the Book reports the ledger as classified by older rules
 * until then, so a rule change can never leave figures computed from stale lanes or
 * categories without saying so.
 *
 * RULES_FINGERPRINT is a hash of those three files. A test fails when they change and the
 * fingerprint doesn't, so the version can't be forgotten: bump CLASSIFIER_VERSION and
 * paste the fingerprint the test prints.
 */
export const CLASSIFIER_VERSION = 3;
export const RULES_FINGERPRINT = "4bdbf5b5bc874b1e";

/** AppSetting key holding the version the ledger was last classified with. */
export const CLASSIFIER_VERSION_SETTING = "ledger.classifierVersion";

/**
 * AppSetting key holding the household file's fingerprint (lib/household) when the ledger
 * was last classified: the household's names, accounts and merchants file rows too, so
 * editing that file leaves the rows stale until the next refresh, like a rule change.
 */
export const CLASSIFIER_HOUSEHOLD_SETTING = "ledger.classifierHousehold";
