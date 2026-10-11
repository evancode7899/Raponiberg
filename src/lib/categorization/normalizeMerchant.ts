/**
 * Normalizes a raw statement description into a stable key for MerchantCategoryRule
 * lookups: uppercased, trailing reference/phone numbers and punctuation stripped, and
 * collapsed whitespace. Two descriptions for the same merchant (e.g. "AplPay HULU.COM
 * 123456" and "HULU.COM/BILL") won't always collapse to the same key on their own — this
 * only handles the common noise patterns (card network prefixes, trailing digit strings).
 */
export function normalizeMerchant(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/^(APLPAY|SQ \*|TST\*|POS |ACH |PPD |CCD )+/g, "")
    .replace(/[*#]/g, " ")
    .replace(/\b\d{4,}\b/g, "")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
