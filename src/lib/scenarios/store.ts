import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../dataDir.ts";
import { EMPTY_FILE, MAX_SCENARIOS, normalizeScenarioFile, type Scenario, type ScenarioFile } from "./types.ts";

/**
 * The saved scenarios: data/scenarios.json (SCENARIOS_FILE). In the data folder so backup
 * and restore carry it; no figure the Book proves reads it, so saving one never rebuilds the
 * Book (it is left out of book/cache.ts's stamp).
 */

export const SCENARIOS_FILE_NAME = "scenarios.json";
const MAX_BYTES = 256 * 1024;

export const scenariosFilePath = () => process.env.SCENARIOS_FILE || path.join(dataDir(), SCENARIOS_FILE_NAME);

export function readScenarios(file = scenariosFilePath()): ScenarioFile {
  if (!existsSync(file)) return structuredClone(EMPTY_FILE);
  try {
    return normalizeScenarioFile(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    // Exploratory plans only: a damaged file reads as none rather than stopping the page.
    return structuredClone(EMPTY_FILE);
  }
}

/** Saves the whole file (normalized first); returns what was saved. */
export function writeScenarios(raw: unknown, file = scenariosFilePath()): ScenarioFile {
  const data = normalizeScenarioFile(raw);
  const text = JSON.stringify(data, null, 2) + "\n";
  if (text.length > MAX_BYTES) throw new Error("Too many scenarios to save");
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, file);
  } catch {
    writeFileSync(file, text);
    rmSync(tmp, { force: true });
  }
  return data;
}

/**
 * FIRE's own saved scenarios from before the two were one (data/fire-scenarios.json): moved
 * into this file once, each as a scenario (a name already here is kept as it is), then the old
 * file renamed to fire-scenarios.migrated.json so it's never read again (backup still carries it).
 */
export function migrateFireScenarios(convert: (m: { id: string; says: string }) => Scenario | null, file = scenariosFilePath(), old = process.env.FIRE_SCENARIOS_FILE || path.join(dataDir(), "fire-scenarios.json")): void {
  if (!existsSync(old)) return;
  let marks: { id: string; says: string }[] = [];
  try {
    const parsed = JSON.parse(readFileSync(old, "utf8")) as { marks?: { id: string; says: string }[] };
    marks = Array.isArray(parsed.marks) ? parsed.marks : [];
  } catch {
    // A damaged file stays where it is, for the owner to look at: nothing is moved from it.
    return;
  }
  const cur = readScenarios(file);
  const have = new Set(cur.scenarios.map((s) => s.id));
  const add = marks.flatMap((m) => convert(m) ?? []).filter((s) => !have.has(s.id));
  if (add.length) writeScenarios({ ...cur, scenarios: [...cur.scenarios, ...add].slice(0, MAX_SCENARIOS) }, file);
  renameSync(old, old.replace(/\.json$/, ".migrated.json"));
}
