import type { Lane } from "./taxonomy.ts";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../dataDir.ts";

/**
 * Merchant rules — the owner's (taught by recategorizing a merchant) and the AI's (see
 * aiCategorize.ts). Like the transfer decisions, they live in a file next to the database,
 * not only in it: rebuilding the database would otherwise forget every merchant anyone
 * taught. Rules are keyed by merchantKey(), which is stable across re-imports.
 *
 * Every ledger refresh syncs both ways (see syncMerchantRules): a rule only in the
 * database is saved here, a rule only here is restored to the database. Every change is
 * also appended to a journal beside the file.
 */

export type RuleSource = "USER" | "LLM_PROMOTED";

export type SavedRule = {
  merchantKey: string;
  category: string;
  lane: Lane | null;
  source: RuleSource;
  /** What the AI took the merchant to be ("Italian restaurant in Florence"). */
  note?: string | null;
  savedAt: string;
};

export type RulesFile = { version: 1; rules: SavedRule[] };

export function rulesFilePath(): string {
  return process.env.MERCHANT_RULES_FILE || path.join(dataDir(), "merchant-rules.json");
}

const journalPath = (file: string) => file.replace(/\.json$/, "") + ".journal.jsonl";

/** Reads the rules. A missing file is none; a damaged one is an error, never none. */
export function readRules(file = rulesFilePath()): RulesFile {
  if (!existsSync(file)) return { version: 1, rules: [] };
  let parsed: Partial<RulesFile>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<RulesFile>;
  } catch {
    throw new Error(`The merchant rules file ${file} is damaged (not valid JSON). Restore it from ${journalPath(file)} before continuing.`);
  }
  if (typeof parsed.version === "number" && parsed.version > 1) {
    throw new Error(`The merchant rules file ${file} was written by a newer version of the app (format ${parsed.version}). Update the app before continuing.`);
  }
  if (!Array.isArray(parsed.rules)) {
    throw new Error(`The merchant rules file ${file} is damaged (missing its list). Restore it from ${journalPath(file)} before continuing.`);
  }
  return { version: 1, rules: parsed.rules };
}

/**
 * Saves rules (replacing any earlier rule for the same merchant); returns how many
 * changed. Unchanged rules are skipped, so a sync that finds nothing new writes nothing.
 */
export function saveRules(rules: Omit<SavedRule, "savedAt">[], file = rulesFilePath()): number {
  const data = readRules(file);
  const changed: SavedRule[] = [];
  for (const r of rules) {
    const i = data.rules.findIndex((x) => x.merchantKey === r.merchantKey);
    const old = i >= 0 ? data.rules[i]! : null;
    if (old && old.category === r.category && old.lane === r.lane && old.source === r.source && (r.note === undefined || old.note === r.note)) continue;
    const saved: SavedRule = { ...r, note: r.note ?? old?.note ?? null, savedAt: new Date().toISOString() };
    if (i >= 0) data.rules[i] = saved;
    else data.rules.push(saved);
    changed.push(saved);
  }
  if (changed.length === 0) return 0;
  data.rules.sort((a, b) => a.merchantKey.localeCompare(b.merchantKey));
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(journalPath(file), JSON.stringify({ at: new Date().toISOString(), op: "save", rules: changed }) + "\n");
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
  return changed.length;
}
