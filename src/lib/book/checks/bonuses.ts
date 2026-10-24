import type { Book } from "../load.ts";
import { awardsOf, bonusFindingId, buildBonuses } from "../reports/bonuses.ts";
import type { Collector } from "./collector.ts";

/**
 * Bonus award letters are typed in by the owner (data/bonus-awards.json); the pay stubs
 * are what was paid. Every place a letter contradicts itself (its parts don't add up to
 * its bonus or its total pay) or the stubs (its base salary, a payment it scheduled that
 * the stubs pay differently or not at all) is a finding, built by the Bonuses report
 * itself so the page and the check can't differ. The stubs stay what counts as pay; the
 * finding stands until the letter is corrected or the owner accepts the gap with a note.
 */
export function checkBonusLetters(book: Book, c: Collector) {
  let report;
  try {
    report = buildBonuses(book, awardsOf(book), book.today);
  } catch (e) {
    c.add({
      id: "bonus.letters:file",
      check: "bonus.letters",
      status: "FAIL",
      title: "The bonus letters file can't be read",
      detail: e instanceof Error ? e.message : String(e),
      fix: "Restore data/bonus-awards.json from the backup or fix the JSON by hand.",
      scope: { from: book.ledger.firstDay ?? book.today, to: book.today, affects: ["BONUS"] },
    });
    return;
  }
  const open = new Set(report.warnings.map((w) => w.id));
  for (const w of report.warnings)
    c.add({
      id: bonusFindingId(w),
      check: "bonus.letters",
      // A letter from an employer with no stubs on file can't be checked: missing, not wrong.
      status: w.id.endsWith("|no-stubs") ? "MISSING" : "FAIL",
      title: w.text,
      detail: w.gapCents ? `Off by ${(Math.abs(w.gapCents) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}. The pay stubs are what counts as pay; the letter feeds the Bonuses page and the forecast's scheduled bonuses.` : "The pay stubs are what counts as pay; the letter feeds the Bonuses page and the forecast's scheduled bonuses.",
      fix: "Correct the letter in data/bonus-awards.json if it was typed wrong; otherwise accept the gap with a note saying why (Bonuses, or Statements → Issues).",
      scope: { from: w.from, to: w.to, affects: ["BONUS"] },
    });
  // Every vesting window the stubs paid as scheduled.
  for (const w of report.windows)
    if (w.status === "PAID" && !open.has(`${w.key}|paid`)) c.pass("bonus.letters", { subject: `${w.label}: paid as the letter schedules`, from: w.from, to: w.to, affects: ["BONUS"] });
}
