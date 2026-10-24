import { existsSync, renameSync } from "node:fs";
import { importExceptions } from "../book/exceptionStore.ts";
import type { RetiredException, StandingException } from "../book/types.ts";
import { readReviews, reviewsFilePath, type BonusReview } from "./reviewStore.ts";

/**
 * Bonus letter warnings used to be reviewed in a file of their own (bonus-awards.reviews.json).
 * They're integrity findings now (check bonus.letters), so a review is an exception in the
 * one permanent list every other finding uses. This carries each review across as it was:
 * same gap (the finding id holds it, so a changed gap is a new finding, as before), same
 * note and date; a reopened review becomes a retired exception with its reason. Nothing
 * is dropped, and the old file is kept beside it, renamed, with its journal.
 */

const findingId = (r: Pick<BonusReview, "id" | "gapCents">) => `bonus.letters:${r.id}|${r.gapCents}`;

const asException = (r: BonusReview): StandingException => ({
  id: findingId(r),
  check: "bonus.letters",
  note: r.note,
  acceptedAt: r.reviewedAt,
  finding: {
    status: "FAIL",
    title: r.warning,
    detail: "Reviewed on the Bonuses page before bonus letters were an integrity check.",
    scope: { from: r.reviewedAt.slice(0, 10), to: r.reviewedAt.slice(0, 10), affects: ["BONUS"] },
  },
});

/** The reviews still in the old file, as exceptions (empty once migrated). */
export function reviewExceptions(file = reviewsFilePath()): { exceptions: StandingException[]; retired: RetiredException[] } {
  if (!existsSync(file)) return { exceptions: [], retired: [] };
  const data = readReviews(file);
  return {
    exceptions: data.reviews.map(asException),
    retired: data.reopened.map((r) => ({ ...asException(r), retiredAt: r.reopenedAt, reason: r.reason })),
  };
}

/** Moves the old file's reviews into the exceptions list and renames the old file; returns how many moved. */
export function migrateBonusReviews(file = reviewsFilePath(), exceptionsFile?: string): number {
  if (!existsSync(file)) return 0;
  const { exceptions, retired } = reviewExceptions(file);
  const n = importExceptions(exceptions, retired, "bonus-awards.reviews.json", exceptionsFile);
  renameSync(file, file.replace(/\.json$/, "") + ".migrated.json");
  return n;
}
