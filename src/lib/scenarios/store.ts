import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../dataDir.ts";
import { EMPTY_FILE, normalizeScenarioFile, type ScenarioFile } from "./types.ts";

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
