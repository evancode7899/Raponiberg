import { compileMerchantRules, MERCHANT_RULES, MERCHANT_RULE_IDS, type MerchantRule } from "../classifier/merchants.ts";

/**
 * The household's own facts, which the code never carries: names as statements print
 * them, the partner's accounts, private funds, merchants only this household visits, the
 * merge date. They live in data/household.json (see householdFile.ts); this module only
 * turns that file into the patterns the classifier, parsers and Book use. Pure, so tests
 * build their own households.
 *
 * Patterns are regular-expression sources, matched against upper-cased statement text.
 */
export type HouseholdFile = {
  version: 1;
  /** How card statements print the household's names before a merchant ("PAT Q EXAMPLE AMAZON…"); stripped from merchant keys. Case-insensitive. */
  cardholderNames?: string;
  partner?: {
    /** The partner's name on card payments and card-member lines: a payment they made from their own money. */
    cardPattern?: string;
    /** Bank descriptions naming the partner's own untracked accounts (checked before own-account savings transfers). */
    accountPattern?: string;
    /** Bank descriptions of transfers with the partner (Zelle by name...). */
    transferPattern?: string;
  };
  /** Private funds with quarterly capital statements. */
  funds?: { institution: string; statementName: string; accountName?: string; wirePattern?: string }[];
  /** Extra keywords for built-in merchant rules, by rule id (see MERCHANT_RULE_IDS). */
  merchantKeywords?: Record<string, string>;
  /** YYYY-MM-DD the household merged finances, when Settings hasn't saved one. */
  mergeDate?: string;
  /** Tax-year caveats shown on the Taxes page, by year ("2025": "Part of the year was in another state..."). */
  taxYearWarnings?: Record<string, string>;
  /** Extra words npm run privacy:check refuses to find in the code (names, account endings, figures). */
  privacyTerms?: string[];
};

export type HouseholdFund = { institution: string; statementName: string; accountName: string | null; wire: RegExp | null };

export type HouseholdPatterns = {
  cardholderPrefix: RegExp | null;
  partnerCard: RegExp | null;
  partnerAccount: RegExp | null;
  partnerTransfer: RegExp | null;
  funds: HouseholdFund[];
  /** Any fund's wire pattern. */
  fundWire: RegExp | null;
  /** The built-in merchant rules with this household's keywords added. */
  merchantRules: MerchantRule[];
  mergeDate: string | null;
  taxYearWarnings: Record<string, string>;
  /** Changes whenever anything that files transactions changes ("" for no household file). */
  fingerprint: string;
};

export const NO_HOUSEHOLD: HouseholdPatterns = Object.freeze({
  cardholderPrefix: null,
  partnerCard: null,
  partnerAccount: null,
  partnerTransfer: null,
  funds: [],
  fundWire: null,
  merchantRules: MERCHANT_RULES,
  mergeDate: null,
  taxYearWarnings: {},
  fingerprint: "",
});

/** Compiles the file; throws a message naming the bad field (a damaged file is an error, never "no household"). */
export function compileHousehold(f: HouseholdFile, source = "data/household.json"): HouseholdPatterns {
  const fail = (field: string, why: string): never => {
    throw new Error(`${source}: ${field} ${why}`);
  };
  if (!f || typeof f !== "object") fail("the file", "is not a JSON object");
  if (f.version !== 1) fail("version", `must be 1 (found ${JSON.stringify(f.version)})`);
  const re = (field: string, src: unknown, flags = ""): RegExp | null => {
    if (src == null || src === "") return null;
    if (typeof src !== "string") return fail(field, "must be a pattern string");
    try {
      return new RegExp(src, flags);
    } catch (e) {
      return fail(field, `is not a valid pattern (${e instanceof Error ? e.message : String(e)})`);
    }
  };

  const keywords = f.merchantKeywords ?? {};
  for (const [id, src] of Object.entries(keywords)) {
    if (!MERCHANT_RULE_IDS.includes(id)) fail(`merchantKeywords.${id}`, `names no built-in merchant rule (known: ${MERCHANT_RULE_IDS.join(", ")})`);
    re(`merchantKeywords.${id}`, src);
  }
  const funds = (f.funds ?? []).map((x, i) => {
    if (!x?.institution || !x.statementName) fail(`funds[${i}]`, "needs institution and statementName");
    return { institution: x.institution, statementName: x.statementName, accountName: x.accountName ?? null, wire: re(`funds[${i}].wirePattern`, x.wirePattern) };
  });
  if (f.mergeDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(f.mergeDate)) fail("mergeDate", "must be YYYY-MM-DD");
  const cardholder = re("cardholderNames", f.cardholderNames, "i");
  const wires = funds.flatMap((x) => (x.wire ? [x.wire.source] : []));

  const filing = { cardholderNames: f.cardholderNames, partner: f.partner, funds: f.funds, merchantKeywords: f.merchantKeywords, mergeDate: f.mergeDate };
  return Object.freeze({
    cardholderPrefix: cardholder && new RegExp(`^(?:${cardholder.source})\\s+`, "i"),
    partnerCard: re("partner.cardPattern", f.partner?.cardPattern),
    partnerAccount: re("partner.accountPattern", f.partner?.accountPattern),
    partnerTransfer: re("partner.transferPattern", f.partner?.transferPattern),
    funds,
    fundWire: wires.length ? new RegExp(wires.join("|")) : null,
    merchantRules: compileMerchantRules(keywords),
    mergeDate: f.mergeDate ?? null,
    taxYearWarnings: { ...f.taxYearWarnings },
    fingerprint: hash(JSON.stringify(filing)),
  });
}

/** FNV-1a, 32-bit: a short stamp, not security. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
