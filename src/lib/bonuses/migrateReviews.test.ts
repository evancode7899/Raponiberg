import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readExceptions } from "../book/exceptionStore";
import { migrateBonusReviews, reviewExceptions } from "./migrateReviews";

const REVIEW = { id: "ex|2025-08|2025-08|paid", gapCents: 6_700, warning: "Aug 2025: paid more than the letter schedules", note: "Employer rounding, in my favor", reviewedAt: "2026-01-10T12:00:00.000Z" };
const REOPENED = { id: "ex|2024|bonus-adds-up", gapCents: -100, warning: "2024: the parts don't add up", note: "Typo", reviewedAt: "2025-03-01T00:00:00.000Z", reopenedAt: "2025-04-01T00:00:00.000Z", reason: "Letter corrected" };

let dir = "";
const setup = (exceptions: unknown = null) => {
  dir = mkdtempSync(path.join(tmpdir(), "bonus-reviews-"));
  const reviews = path.join(dir, "bonus-awards.reviews.json");
  const ex = path.join(dir, "integrity-exceptions.json");
  writeFileSync(reviews, JSON.stringify({ version: 1, reviews: [REVIEW], reopened: [REOPENED] }));
  if (exceptions) writeFileSync(ex, JSON.stringify(exceptions));
  return { reviews, ex };
};
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("moving bonus letter reviews into the integrity exceptions", () => {
  it("carries each review across with its gap, note and date, and a reopened one as retired with its reason", () => {
    const { reviews, ex } = setup();
    expect(migrateBonusReviews(reviews, ex)).toBe(2);
    const file = readExceptions(ex);
    expect(file.exceptions).toEqual([
      expect.objectContaining({ id: "bonus.letters:ex|2025-08|2025-08|paid|6700", check: "bonus.letters", note: REVIEW.note, acceptedAt: REVIEW.reviewedAt, finding: expect.objectContaining({ title: REVIEW.warning }) }),
    ]);
    expect(file.retired).toEqual([expect.objectContaining({ id: "bonus.letters:ex|2024|bonus-adds-up|-100", retiredAt: REOPENED.reopenedAt, reason: REOPENED.reason })]);
    // The old file is kept, renamed, so nothing is lost; a second run moves nothing.
    expect(existsSync(reviews)).toBe(false);
    expect(JSON.parse(readFileSync(reviews.replace(/\.json$/, ".migrated.json"), "utf8")).reviews).toHaveLength(1);
    expect(migrateBonusReviews(reviews, ex)).toBe(0);
    expect(readFileSync(ex.replace(/\.json$/, ".journal.jsonl"), "utf8")).toContain('"op":"import"');
  });

  it("keeps an exception the list already holds as it is", () => {
    const existing = { id: "bonus.letters:ex|2025-08|2025-08|paid|6700", check: "bonus.letters", note: "Accepted on Statements already", acceptedAt: "2026-02-01T00:00:00.000Z", finding: { status: "FAIL", title: "x", detail: "", scope: { from: "2025-08-01", to: "2025-08-31", affects: ["BONUS"] } } };
    const { reviews, ex } = setup({ version: 1, exceptions: [existing], retired: [] });
    expect(migrateBonusReviews(reviews, ex)).toBe(1);
    expect(readExceptions(ex).exceptions).toEqual([existing]);
  });

  it("reads reviews not yet moved as exceptions, so the Book counts them meanwhile", () => {
    const { reviews } = setup();
    expect(reviewExceptions(reviews).exceptions.map((e) => e.id)).toEqual(["bonus.letters:ex|2025-08|2025-08|paid|6700"]);
  });
});
