import { blockersFor } from "../book/blockers.ts";
import type { Book } from "../book/load.ts";
import { refs } from "../book/reports/blockerRef.ts";
import { buildGarage, type GarageReport } from "./report.ts";
import type { GarageSettings } from "./settings.ts";
import { premiumLines } from "../insurance/docs.ts";
import { readInsuranceDocs } from "../insurance/store.ts";
import type { InsuranceDocsFile } from "../insurance/types.ts";

/**
 * The Car page's report, as GET /api/car serves it and the proof sweep reads it: the garage
 * from the Book's rows, and what withholds its money figures. Car charges can be on any
 * bank or card statement, so any cash-flow finding since the first purchase withholds them.
 * A log entry dated after the last day every statement is in for is awaiting its statement.
 */
export function garagePage(book: Book, settings: GarageSettings, docs: InsuranceDocsFile | null = readInsuranceDocs()): GarageReport {
  // What the home and auto declarations on file say each premium pays for (renters insurance is never the car's).
  const premiums = premiumLines(docs, book.rows.filter((r) => r.amountCents < 0 && !r.pending).map((r) => ({ id: r.id, date: r.date, amountCents: r.amountCents, payee: r.payee, accountId: r.accountId })), book.today);
  const report = buildGarage(settings, book.rows, book.today, { statementsThrough: book.horizon.cashFlow, premiums });
  const from = settings.cars.map((c) => c.vehicle.purchaseDate).filter((d): d is string => !!d).sort()[0];
  const blockers = from && from <= book.horizon.cashFlow ? refs(blockersFor(book, { affects: "CASH_FLOW", from, to: book.horizon.cashFlow })) : [];
  return { ...report, blockers };
}
