import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../dataDir.ts";
import { compileHousehold, NO_HOUSEHOLD, type HouseholdFile, type HouseholdPatterns } from "./patterns.ts";

/**
 * data/household.json: everything personal the rules need (names as statements print
 * them, the partner's accounts, private funds, merchants only this household visits, the
 * merge date). Gitignored and backed up with the rest of data/, so the code itself stays
 * free of anything that identifies the household; household.example.json shows the shape.
 *
 * A missing file is a household with none of these. A damaged one is an error, never
 * "none": quietly dropping the partner's names would refile their money.
 */
export function householdFilePath(): string {
  return process.env.HOUSEHOLD_FILE || path.join(dataDir(), "household.json");
}

/** The file as written, or null when there is none. */
export function readHouseholdFile(file = householdFilePath()): HouseholdFile | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as HouseholdFile;
  } catch {
    throw new Error(`The household file ${file} is damaged (not valid JSON). Restore it from the latest backup before continuing.`);
  }
}

let cached: { file: string; stamp: string; patterns: HouseholdPatterns } | null = null;

/** The compiled household, re-read whenever the file changes. */
export function householdPatterns(file = householdFilePath()): HouseholdPatterns {
  let stamp = "-";
  try {
    const s = statSync(file);
    stamp = `${s.mtimeMs}:${s.size}`;
  } catch {
    /* no file */
  }
  if (cached?.file === file && cached.stamp === stamp) return cached.patterns;
  const raw = stamp === "-" ? null : readHouseholdFile(file);
  const patterns = raw ? compileHousehold(raw, file) : NO_HOUSEHOLD;
  cached = { file, stamp, patterns };
  return patterns;
}
