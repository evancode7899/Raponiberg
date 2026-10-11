import { buildCoverageReport, type CoverageReport } from "../../ledger/coverageReport.ts";
import type { Book } from "../load.ts";

/**
 * Statement and pay-stub coverage from the Book. Pay stubs are grouped by employer
 * identity (one row per employer however its name is printed) and labelled with the
 * household member they belong to.
 */
export function buildCoverage(book: Book): CoverageReport {
  // Payments to the closed Amex Platinum: Chase paid it, but it has no statement folder.
  const payments = book.rows
    .filter((r) => r.classifiedBy?.startsWith("untracked-card:") && r.counterpartyInstitution === "American Express")
    .map((r) => ({ date: r.date, amountCents: r.amountCents }));
  const byEmployer = new Map<string, { label: string; payDates: string[] }>();
  for (const s of book.stubs) {
    const person = book.persons.find((p) => p.id === s.personId)?.name;
    const g = byEmployer.get(s.employerKey) ?? { label: s.employer, payDates: [] };
    g.label = person ? `${s.employer} (${person})` : s.employer;
    g.payDates.push(s.payDate);
    byEmployer.set(s.employerKey, g);
  }
  const paystubs = [...byEmployer.values()].map((g) => ({ employer: g.label, payDates: g.payDates }));
  return buildCoverageReport(book.ledger, book.today, [{ name: "Amex Platinum", payments }], paystubs);
}
