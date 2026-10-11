import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../dataDir.ts";

/**
 * Bonus warnings the owner reviewed and accepted: a letter that doesn't quite add up, or a
 * payment a few dollars off the letter. A review covers one warning at one gap; if the
 * letters or the stubs change and the gap with them, the warning opens again.
 *
 * Like the integrity exceptions, the list lives in a file beside the letters (never in the
 * database, never committed) with an add-only journal. Reviews are only ever added; the
 * one way out is reopenReview, on the owner's say-so with a reason, which moves the entry
 * to `reopened` and keeps it.
 */

export type BonusReview = {
  /** The warning's id (book/reports/bonuses.ts). */
  id: string;
  /** The gap reviewed, in cents (signed, as the warning computes it). */
  gapCents: number;
  /** The warning as it read when reviewed. */
  warning: string;
  note: string;
  reviewedAt: string;
};

export type ReopenedReview = BonusReview & { reopenedAt: string; reason: string };

export type ReviewsFile = { version: 1; reviews: BonusReview[]; reopened: ReopenedReview[] };

export function reviewsFilePath(): string {
  return process.env.BONUS_REVIEWS_FILE || path.join(dataDir(), "bonus-awards.reviews.json");
}

const journalPath = (file: string) => file.replace(/\.json$/, "") + ".journal.jsonl";

/** Reads the reviews. A missing file is none; a damaged one is an error, never none. */
export function readReviews(file = reviewsFilePath()): ReviewsFile {
  if (!existsSync(file)) return { version: 1, reviews: [], reopened: [] };
  let parsed: Partial<ReviewsFile>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ReviewsFile>;
  } catch {
    throw new Error(`The bonus reviews file ${file} is damaged (not valid JSON). Restore it from ${journalPath(file)} before continuing.`);
  }
  if (typeof parsed.version === "number" && parsed.version > 1) {
    throw new Error(`The bonus reviews file ${file} was written by a newer version of the app (format ${parsed.version}). Update the app before continuing.`);
  }
  if (!Array.isArray(parsed.reviews) || !Array.isArray(parsed.reopened)) {
    throw new Error(`The bonus reviews file ${file} is damaged (missing its lists). Restore it from ${journalPath(file)} before continuing.`);
  }
  return { version: 1, reviews: parsed.reviews, reopened: parsed.reopened };
}

function write(file: string, data: ReviewsFile, journal: Record<string, unknown>) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(journalPath(file), JSON.stringify({ at: new Date().toISOString(), ...journal }) + "\n");
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}

/** Adds a review. A warning already reviewed is refused (reopen it first to replace its note). */
export function addReview(entry: BonusReview, file = reviewsFilePath()): ReviewsFile {
  if (!entry.note.trim()) throw new Error("A review needs a note saying why the warning is fine.");
  const data = readReviews(file);
  if (data.reviews.some((r) => r.id === entry.id)) throw new Error("That warning is already reviewed.");
  data.reviews.push(entry);
  write(file, data, { op: "review", entry });
  return data;
}

/** Reopens a review, with the owner's reason. The entry moves to `reopened`; nothing is deleted. */
export function reopenReview(id: string, reason: string, file = reviewsFilePath()): ReviewsFile {
  if (!reason.trim()) throw new Error("Reopening a review needs a reason.");
  const data = readReviews(file);
  const entry = data.reviews.find((r) => r.id === id);
  if (!entry) throw new Error("No review has that id.");
  const reopened: ReopenedReview = { ...entry, reopenedAt: new Date().toISOString(), reason: reason.trim().slice(0, 1000) };
  data.reviews = data.reviews.filter((r) => r.id !== id);
  data.reopened.push(reopened);
  write(file, data, { op: "reopen", id, reason: reopened.reason });
  return data;
}
