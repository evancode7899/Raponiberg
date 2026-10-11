import { createHash } from "node:crypto";
import { employerKey } from "./payroll/types.ts";
import type { ParsedDocument } from "./types.ts";

/**
 * Hash of what a document *says*, independent of its bytes. Re-downloading a statement
 * produces a different file (new metadata, timestamps) with identical content — e.g.
 * the two copies of Fidelity's 2022 year-end report — and must still be caught as a
 * duplicate.
 */
export function contentFingerprint(doc: ParsedDocument, text: string): string {
  const h = createHash("sha256");
  h.update(`${doc.institution}|${doc.kind}|`);
  if (doc.kind === "SUPPORTING") {
    h.update(text.replace(/\s+/g, " ").trim());
  } else if (doc.kind === "PAYSTUB") {
    const stubs = (doc.payStubs ?? []).map((s) => `${employerKey(s.employer)}|${s.payDate}|${s.printed.netCurrent}`).sort();
    h.update(stubs.join(";"));
  } else {
    const sections = doc.sections
      .map((s) => {
        const rows = s.transactions.map((t) => `${t.date}:${t.amountCents}`).sort();
        return [
          s.accountNumber,
          s.periodStart,
          s.periodEnd,
          s.openingBalanceCents,
          s.closingBalanceCents,
          s.growthCents,
          s.feesCents,
          rows.join(","),
        ].join("|");
      })
      .sort();
    h.update(sections.join(";"));
  }
  return h.digest("hex");
}
