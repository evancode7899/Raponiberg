import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../dataDir.ts";

/**
 * Bonus award letters: what an employer said a year's bonus was, how much of it was paid
 * up front and when each deferred part vests. They aren't statements the importer can
 * read (spreadsheet summaries, emails), so they're typed into a file next to the
 * database, transcribed exactly as the letter prints them. Like the other owner files in
 * data/, it survives database rebuilds and is never committed.
 *
 * The letter is the plan; the pay stubs are the proof. The Bonuses page checks every
 * scheduled payment against the bonus lines on the stubs (see book/reports/bonuses.ts).
 */

/**
 * A payment the letter schedules: the up-front cash or one deferred tranche of the year's
 * bonus, or a one-off outside it (a sign-on bonus, or a make-whole for pay given up at
 * the last employer).
 */
export type PaymentKind = "UPFRONT" | "DEFERRED" | "SIGNING" | "MAKEWHOLE";
export const PAYMENT_KINDS: readonly PaymentKind[] = ["UPFRONT", "DEFERRED", "SIGNING", "MAKEWHOLE"];

export type ScheduledPayment = {
  kind: PaymentKind;
  /**
   * First and last month it's due, YYYY-MM ("Feb/March 2025" → 2025-02 … 2025-03). When
   * the letter gives no date, the months it could have been paid in.
   */
  from: string;
  to: string;
  /** Whole dollars or cents, as printed. */
  amount: number;
};

/** One year's bonus on a letter. */
export type AwardEntry = {
  /** The year the bonus is for (paid early the next year). */
  year: number;
  baseSalary?: number | null;
  totalBonus?: number | null;
  totalComp?: number | null;
  /** The letter shows only some of this year's payments (an older award's last tranches). */
  partial?: boolean;
  /**
   * Deferred into a deferred compensation plan rather than paid on the stubs: it's paid
   * out under the plan's own terms, so it has no vest window here.
   */
  planDeferral?: number | null;
  payments: ScheduledPayment[];
};

export type AwardLetter = {
  id: string;
  title: string;
  /** As the pay stubs print it, so its payments can be found on them. */
  employer: string;
  /** Forfeiture and vesting conditions, paraphrased from the letter. */
  terms?: string;
  /** What doesn't add up on the letter itself, or anything worth remembering. */
  notes?: string[];
  awards: AwardEntry[];
};

/** An employer that pays bonuses with no letter: the gross bonus lines on the stubs are the whole story. */
export type StubOnlyEmployer = { employer: string; note?: string };

export type AwardsFile = { version: 1; letters: AwardLetter[]; stubOnly?: StubOnlyEmployer[] };

export function awardsFilePath(): string {
  return process.env.BONUS_AWARDS_FILE || path.join(dataDir(), "bonus-awards.json");
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Reads the letters. A missing file is none; a damaged one is an error, never none. */
export function readAwards(file = awardsFilePath()): AwardsFile {
  if (!existsSync(file)) return { version: 1, letters: [] };
  let parsed: Partial<AwardsFile>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<AwardsFile>;
  } catch {
    throw new Error(`The bonus letters file ${file} is damaged (not valid JSON).`);
  }
  if (typeof parsed.version === "number" && parsed.version > 1) {
    throw new Error(`The bonus letters file ${file} was written by a newer version of the app (format ${parsed.version}). Update the app before continuing.`);
  }
  if (!Array.isArray(parsed.letters)) throw new Error(`The bonus letters file ${file} has no "letters" list.`);
  for (const l of parsed.letters) {
    const where = `letter "${l?.id ?? "?"}" in ${file}`;
    if (!l?.id || !l.employer || !Array.isArray(l.awards)) throw new Error(`The ${where} needs an id, an employer and a list of awards.`);
    for (const a of l.awards) {
      if (!Number.isInteger(a?.year) || !Array.isArray(a.payments)) throw new Error(`An award in the ${where} needs a year and a list of payments.`);
      for (const p of a.payments) {
        if (!PAYMENT_KINDS.includes(p.kind) || !MONTH.test(p.from) || !MONTH.test(p.to) || p.to < p.from || !(p.amount > 0)) {
          throw new Error(`The ${a.year} award in the ${where} has a payment that isn't ${PAYMENT_KINDS.join("/")} with from ≤ to (YYYY-MM) and a positive amount.`);
        }
      }
    }
  }
  const stubOnly = parsed.stubOnly ?? [];
  if (!Array.isArray(stubOnly) || stubOnly.some((s) => !s?.employer)) throw new Error(`The "stubOnly" list in ${file} needs an employer on every entry.`);
  return { version: 1, letters: parsed.letters, stubOnly };
}
