import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addReview, readReviews, reopenReview, type BonusReview } from "./reviewStore";

const entry = (id: string): BonusReview => ({ id, gapCents: 600, warning: "doesn't add up", note: "Employer rounding", reviewedAt: "2026-10-06T00:00:00.000Z" });

const tempFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), "bonus-reviews-")), "bonus-awards.reviews.json");

describe("bonus reviews file", () => {
  it("starts empty, adds, and refuses a note-less or repeated review", () => {
    const file = tempFile();
    expect(readReviews(file)).toEqual({ version: 1, reviews: [], reopened: [] });
    expect(() => addReview({ ...entry("a"), note: " " }, file)).toThrow(/note/);
    addReview(entry("a"), file);
    expect(readReviews(file).reviews.map((r) => r.id)).toEqual(["a"]);
    expect(() => addReview(entry("a"), file)).toThrow(/already/);
  });

  it("reopens only with a reason, keeps the entry, and journals every change", () => {
    const file = tempFile();
    addReview(entry("a"), file);
    expect(() => reopenReview("a", "", file)).toThrow(/reason/);
    reopenReview("a", "Letter corrected", file);
    const data = readReviews(file);
    expect(data.reviews).toEqual([]);
    expect(data.reopened).toMatchObject([{ id: "a", reason: "Letter corrected" }]);
    const journal = readFileSync(file.replace(/\.json$/, ".journal.jsonl"), "utf8").trim().split("\n");
    expect(journal.map((l) => JSON.parse(l).op)).toEqual(["review", "reopen"]);
  });

  it("refuses a damaged file or one from a newer app", () => {
    const file = tempFile();
    writeFileSync(file, "{");
    expect(() => readReviews(file)).toThrow(/damaged/);
    writeFileSync(file, JSON.stringify({ version: 2, reviews: [], reopened: [] }));
    expect(() => readReviews(file)).toThrow(/newer version/);
  });
});
