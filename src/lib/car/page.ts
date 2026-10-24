import { blockersFor } from "../book/blockers.ts";
import type { Book } from "../book/load.ts";
import { refs } from "../book/reports/blockerRef.ts";
import { buildGarage, type GarageReport } from "./report.ts";
import type { GarageSettings } from "./settings.ts";

/**
 * The Car page's report, as GET /api/car serves it and the proof sweep reads it: the garage
 * from the Book's rows, and what withholds its money figures. Car charges can be on any
 * bank or card statement, so any cash-flow finding since the first purchase withholds them.
 * A log entry dated after the last day every statement is in for is awaiting its statement.
 */
export function garagePage(book: Book, settings: GarageSettings): GarageReport {
  const report = buildGarage(settings, book.rows, book.today, { statementsThrough: book.horizon.cashFlow });
  const from = settings.cars.map((c) => c.vehicle.purchaseDate).filter((d): d is string => !!d).sort()[0];
  const blockers = from && from <= book.horizon.cashFlow ? refs(blockersFor(book, { affects: "CASH_FLOW", from, to: book.horizon.cashFlow })) : [];
  return { ...report, blockers };
}
