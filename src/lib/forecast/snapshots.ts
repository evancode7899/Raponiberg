import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../dataDir.ts";
import type { Forecast } from "./forecast.ts";
import { snapshotOf, type ForecastSnapshot } from "./vsActual.ts";

/**
 * Each saved forecast, kept as it was (data/forecast-snapshots.json): the months it projected
 * when it was saved, never rebuilt with hindsight. A forecast is kept when the owner saves
 * the forecast's settings (and the projection moved), or asks to keep it. Forecast › vs
 * actual reads them; figures read them, so the file is in the Book's stamp. Journaled.
 */

export const FORECAST_SNAPSHOTS_FILE_NAME = "forecast-snapshots.json";
type File = { version: 1; snapshots: ForecastSnapshot[] };
const MAX = 120;

export function forecastSnapshotsFile(): string {
  return process.env.FORECAST_SNAPSHOTS_FILE || path.join(dataDir(), FORECAST_SNAPSHOTS_FILE_NAME);
}
const journalOf = (file: string) => file.replace(/\.json$/, "") + ".journal.jsonl";

/** The snapshots, oldest first: none when there is no file; a damaged one is an error. */
export function readForecastSnapshots(file = forecastSnapshotsFile()): ForecastSnapshot[] {
  if (!existsSync(file)) return [];
  let parsed: Partial<File>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<File>;
  } catch {
    throw new Error(`${path.basename(file)} is damaged (not valid JSON). Restore it from ${path.basename(journalOf(file))} or a backup.`);
  }
  if (!Array.isArray(parsed.snapshots)) throw new Error(`${path.basename(file)} is damaged (no list of snapshots).`);
  return parsed.snapshots;
}

/**
 * Keeps the forecast as it stands. Unless `always`, nothing is kept when it projects the same
 * months as the latest snapshot (saving an unrelated setting). Returns the snapshot kept, or null.
 */
export function keepForecast(f: Forecast, opts: { always?: boolean; reason: string; now?: Date; file?: string }): ForecastSnapshot | null {
  const file = opts.file ?? forecastSnapshotsFile();
  const all = readForecastSnapshots(file);
  const snap = snapshotOf(f, (opts.now ?? new Date()).toISOString(), opts.reason);
  const last = all.at(-1);
  if (!opts.always && last && JSON.stringify(last.months) === JSON.stringify(snap.months)) return null;
  const next = [...all, snap].slice(-MAX);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(journalOf(file), JSON.stringify({ at: snap.savedAt, op: "keep", id: snap.id, reason: opts.reason }) + "\n");
  const text = JSON.stringify({ version: 1, snapshots: next } satisfies File, null, 2) + "\n";
  writeFileSync(`${file}.tmp`, text);
  try {
    renameSync(`${file}.tmp`, file);
  } catch {
    writeFileSync(file, text);
    rmSync(`${file}.tmp`, { force: true });
  }
  return snap;
}
