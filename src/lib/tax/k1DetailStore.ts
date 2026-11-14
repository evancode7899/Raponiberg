import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../dataDir.ts";

/**
 * What a K-1's attached statements say (data/k1-details.json). The face of a K-1 prints
 * its lettered boxes (11, 13, 14, 15, 17, 18, 19, 20) as codes whose meanings change from
 * year to year, with the amounts often left to free-form statements that differ by fund.
 * No reader can take those in, so each K-1's statement detail is transcribed into this
 * file, line by line, with what the tax return does with it. Like the bonus letters, it is
 * the owner's file: it survives database rebuilds and is never committed.
 *
 * The same file holds what a partnership is expected to report for a year still in
 * progress, so the year's forecast doesn't have to assume last year again.
 */

/** What the return does with one line of a K-1's statements. */
export const K1_TREATMENTS = [
  /** Other portfolio income (box 11): ordinary income, investment income for the 3.8% tax. */
  "ORDINARY_PORTFOLIO",
  /** Ordinary income or deduction of the partnership's own activity: joins boxes 1–3 (passive or not, as the activity is). */
  "ORDINARY_ACTIVITY",
  "SHORT_TERM_GAIN",
  "LONG_TERM_GAIN",
  /** Section 1256 contracts: 60% long-term, 40% short-term. */
  "SECTION_1256",
  /** Section 1061: long-term gain held three years or less by a carried interest, taxed as short-term. Positive cents move from long to short. */
  "SECTION_1061_RECHARACTERIZED",
  "COLLECTIBLES_GAIN",
  "UNRECAPTURED_1250_GAIN",
  /** Form 4952: deductible only against net investment income, and only when itemizing. */
  "INVESTMENT_INTEREST_EXPENSE",
  /** Other investment expenses that reduce net investment income (Form 8960) but not taxable income. */
  "INVESTMENT_EXPENSE_NII_ONLY",
  /** Portfolio deductions that are no longer deductible (2% miscellaneous): shown, never used. */
  "PORTFOLIO_DEDUCTION_NOT_DEDUCTIBLE",
  "SE_EARNINGS",
  "QBI_INCOME",
  "QBI_W2_WAGES",
  "QBI_UBIA",
  /** The activity is a specified service trade or business (any non-zero amount flags it). */
  "QBI_SSTB",
  /** Section 199A REIT dividends passed through. */
  "QBI_REIT_DIVIDENDS",
  /** Foreign-source taxable income for the credit limit (Schedule K-3 Part II), passive or general category. */
  "FOREIGN_SOURCE_PASSIVE",
  "FOREIGN_SOURCE_GENERAL",
  /** Foreign tax beyond what box 21 prints. */
  "FOREIGN_TAX",
  "AMT_ADJUSTMENT",
  "TAX_EXEMPT_INTEREST",
  /** Interest on US government obligations inside the K-1's interest: states don't tax it. */
  "US_OBLIGATION_INTEREST",
  /** A state's own change to federal income, its source income, and tax the partnership paid for the partner (need `state`). */
  "STATE_ADDITION",
  "STATE_SUBTRACTION",
  "STATE_SOURCE_INCOME",
  "PTE_TAX_CREDIT",
  "STATE_TAX_WITHHELD",
  /** Read and understood; the individual return does nothing with it. */
  "INFORMATION_ONLY",
] as const;
export type K1Treatment = (typeof K1_TREATMENTS)[number];

export type K1DetailLine = {
  /** The box the line belongs to ("11", "20"; "1"–"10" for a breakdown of a face box; "K3" or "STATE" for those schedules). */
  box: string;
  /** The box's letter code, as printed ("A", "ZZ"); omitted where the box has none. */
  code?: string;
  /** What the statement calls it. */
  label: string;
  /** Cents, signed as the statement prints it (income positive, deductions and losses negative unless the treatment is itself a deduction). */
  cents: number;
  treatment: K1Treatment;
  /** Two-letter state, for the state treatments. */
  state?: string;
};

/** The figures a K-1's face prints, for a year whose K-1 hasn't come yet. Cents. */
export type K1Expected = Partial<
  Record<"ordinaryBusiness" | "rentalRealEstate" | "otherRental" | "guaranteedPayments" | "interest" | "ordinaryDividends" | "qualifiedDividends" | "royalties" | "shortTermGain" | "longTermGain" | "section1231" | "foreignTax", number>
>;

export type K1Activity = "INVESTOR_FUND" | "TRADER_FUND" | "OPERATING" | "RENTAL";
export const K1_ACTIVITIES: readonly K1Activity[] = ["INVESTOR_FUND", "TRADER_FUND", "OPERATING", "RENTAL"];

export type K1Detail = {
  /** The partnership's EIN as the K-1 prints it: with the year, what ties this entry to its K-1. */
  ein: string;
  year: number;
  /** For the reader of this file only. */
  partnership?: string;
  /** The person (id from the tax profile) whose return it goes on, when the partner's name doesn't say. */
  owner?: string;
  /** What the partnership does, which decides how its box 1–3 income is taxed. */
  activity?: K1Activity;
  /** Whether boxes 1–3 are passive for this partner. Default: yes for a limited partner, except in a trader fund. */
  passive?: boolean;
  /** A passive loss carried into this year from before the app's records (positive cents). */
  openingSuspendedLoss?: number;
  lines: K1DetailLine[];
  /** With no K-1 on file yet: what the partnership is expected to report for the year. */
  expected?: K1Expected;
  note?: string;
  /** The file in the tax documents folder these were read from. */
  readFrom?: string;
};

export type K1DetailsFile = { version: 1; k1s: K1Detail[] };

export function k1DetailsFilePath(): string {
  return process.env.K1_DETAILS_FILE || path.join(dataDir(), "k1-details.json");
}

const STATE_TREATMENTS: K1Treatment[] = ["STATE_ADDITION", "STATE_SUBTRACTION", "STATE_SOURCE_INCOME", "PTE_TAX_CREDIT", "STATE_TAX_WITHHELD"];

/** Reads the details. A missing file is none; a damaged one is an error, never none. */
export function readK1Details(file = k1DetailsFilePath()): K1DetailsFile {
  if (!existsSync(file)) return { version: 1, k1s: [] };
  let parsed: Partial<K1DetailsFile>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<K1DetailsFile>;
  } catch {
    throw new Error(`The K-1 details file ${file} is damaged (not valid JSON).`);
  }
  if (typeof parsed.version === "number" && parsed.version > 1) {
    throw new Error(`The K-1 details file ${file} was written by a newer version of the app (format ${parsed.version}). Update the app before continuing.`);
  }
  if (!Array.isArray(parsed.k1s)) throw new Error(`The K-1 details file ${file} has no "k1s" list.`);
  const seen = new Set<string>();
  for (const k of parsed.k1s) {
    const where = `the ${k?.year ?? "?"} entry for ${k?.ein ?? "?"} in ${file}`;
    if (!k?.ein || !/^\d{2}-\d{7}$/.test(k.ein) || !Number.isInteger(k.year) || !Array.isArray(k.lines)) throw new Error(`In ${where}: an entry needs an EIN (12-3456789), a year and a list of lines.`);
    if (seen.has(`${k.ein}|${k.year}`)) throw new Error(`The K-1 details file ${file} has two entries for ${k.ein} in ${k.year}.`);
    seen.add(`${k.ein}|${k.year}`);
    if (k.activity && !K1_ACTIVITIES.includes(k.activity)) throw new Error(`In ${where}: the activity must be one of ${K1_ACTIVITIES.join(", ")}.`);
    if (k.openingSuspendedLoss != null && !(Number.isInteger(k.openingSuspendedLoss) && k.openingSuspendedLoss >= 0)) throw new Error(`In ${where}: the opening suspended loss is whole cents, zero or more.`);
    for (const l of k.lines) {
      if (!l?.box || !l.label || !Number.isInteger(l.cents) || !K1_TREATMENTS.includes(l.treatment)) throw new Error(`In ${where}: every line needs a box, a label, whole cents and a known treatment.`);
      if (STATE_TREATMENTS.includes(l.treatment) && !/^[A-Z]{2}$/.test(l.state ?? "")) throw new Error(`In ${where}: the line "${l.label}" needs its two-letter state.`);
    }
    for (const [key, v] of Object.entries(k.expected ?? {})) if (!Number.isInteger(v)) throw new Error(`In ${where}: the expected ${key} must be whole cents.`);
  }
  return { version: 1, k1s: parsed.k1s };
}

/** The entry for a partnership's K-1 of a year (matched by EIN). */
export function k1DetailFor(file: K1DetailsFile | { error: string } | null | undefined, ein: string | null, year: number): K1Detail | null {
  if (!file || "error" in file || !ein) return null;
  return file.k1s.find((k) => k.ein === ein && k.year === year) ?? null;
}
