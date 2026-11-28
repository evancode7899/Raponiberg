import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { dataDir as defaultDataDir } from "../dataDir.ts";
import { readJsonStore, writeJsonAtomic } from "../jsonStore.ts";
import { listSnapshots, verifySnapshot } from "./backup.ts";

/**
 * The restore drill: a backup is only as good as a restore from it, so once a month (and on
 * Settings › Data's "Run the drill now") the newest snapshot is tried the way a restore would
 * use it, without touching the live data:
 *
 *  1. its files are whole (each matches the size and hash its manifest wrote down);
 *  2. its database opens from a copy in a temporary folder, and SQLite's own integrity check passes;
 *  3. it matches the live data: the same rows in every table, and the same data files.
 *     Changes made since the snapshot are said as such, not as a failure: the next backup takes them.
 *
 * The result is kept in data/restore-drill.json (lib/appFiles.ts: no figure reads it).
 */
export const DRILL_EVERY_DAYS = 30;
export const DRILL_FILE = "restore-drill.json";

export type DrillCheck = { label: string; ok: boolean; detail: string };
export type DrillResult = {
  at: string;
  snapshot: string | null;
  snapshotAt: string | null;
  /** The snapshot can be restored: whole, opens, intact. */
  ok: boolean;
  /** It holds exactly the live data (false: something changed since it was taken). */
  matches: boolean;
  checks: DrillCheck[];
  /** Tables whose row count differs from the live database's (snapshot, live). */
  differences: { table: string; snapshot: number; live: number }[];
  /** Data files that differ from the live ones, or are only on one side. */
  changedFiles: string[];
};

/** A database to count rows in: the snapshot's copy, or the live one. */
export type CountingDb = { $queryRawUnsafe(query: string): Promise<unknown> };

async function tableCounts(db: CountingDb): Promise<Map<string, number>> {
  const tables = (await db.$queryRawUnsafe(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma_%' ORDER BY name`)) as { name: string }[];
  const out = new Map<string, number>();
  for (const { name } of tables) {
    const [row] = (await db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`)) as { n: number | bigint }[];
    out.set(name, Number(row?.n ?? 0));
  }
  return out;
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

export type DrillOptions = {
  root: string;
  live: CountingDb;
  /** Opens a database file on its own (a PrismaClient for that file), to be disconnected after. */
  open: (file: string) => CountingDb & { $disconnect(): Promise<void> };
  dataDir?: string;
  now?: Date;
};

export async function runRestoreDrill(opts: DrillOptions): Promise<DrillResult> {
  const at = (opts.now ?? new Date()).toISOString();
  const dataDir = opts.dataDir ?? defaultDataDir();
  const checks: DrillCheck[] = [];
  const base: DrillResult = { at, snapshot: null, snapshotAt: null, ok: false, matches: false, checks, differences: [], changedFiles: [] };
  const snap = listSnapshots(opts.root)[0];
  if (!snap) {
    checks.push({ label: "A snapshot to restore", ok: false, detail: "No finished snapshot in the backup folder yet." });
    return base;
  }
  const result: DrillResult = { ...base, snapshot: snap.name, snapshotAt: snap.manifest.createdAt };

  const problems = verifySnapshot(snap);
  checks.push({ label: "Its files are whole", ok: problems.length === 0, detail: problems.length ? problems.join("; ") : `${snap.manifest.files.length} files, each the size and content its manifest wrote down.` });
  if (problems.length) return result;

  const work = mkdtempSync(path.join(os.tmpdir(), "pf-drill-"));
  let opened: ReturnType<DrillOptions["open"]> | null = null;
  try {
    const copy = path.join(work, "finance.db");
    copyFileSync(path.join(snap.dir, "finance.db"), copy);
    opened = opts.open(copy);
    const [row] = (await opened.$queryRawUnsafe("PRAGMA integrity_check")) as { integrity_check?: string }[];
    const intact = row?.integrity_check === "ok";
    checks.push({ label: "Its database opens and is intact", ok: intact, detail: intact ? "SQLite's integrity check passes on a copy." : `SQLite's integrity check says: ${row?.integrity_check ?? "nothing"}.` });
    if (!intact) return result;
    const [mine, live] = await Promise.all([tableCounts(opened), tableCounts(opts.live)]);
    for (const table of [...new Set([...mine.keys(), ...live.keys()])].sort()) {
      const a = mine.get(table) ?? 0;
      const b = live.get(table) ?? 0;
      if (a !== b) result.differences.push({ table, snapshot: a, live: b });
    }
    const rows = [...mine.values()].reduce((s, n) => s + n, 0);
    checks.push({
      label: "Its rows match the live database",
      ok: result.differences.length === 0,
      detail: result.differences.length ? `${result.differences.length} table${result.differences.length === 1 ? "" : "s"} changed since it was taken: ${result.differences.map((d) => d.table).join(", ")}.` : `${mine.size} tables, ${rows.toLocaleString("en-US")} rows, the same in both.`,
    });
  } catch (e) {
    checks.push({ label: "Its database opens and is intact", ok: false, detail: e instanceof Error ? e.message : String(e) });
    return result;
  } finally {
    await opened?.$disconnect().catch(() => {});
    // Windows can hold the copy's file a moment past $disconnect (EPERM/EBUSY): retried, and a
    // scratch folder left in the temp dir never fails the drill.
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* the system temp folder's own cleanup takes it */
    }
  }

  for (const f of snap.manifest.files) {
    if (f.name === "finance.db" || f.name === DRILL_FILE) continue;
    const live = path.join(dataDir, f.name);
    if (!existsSync(live) || sha256(live) !== f.sha256) result.changedFiles.push(f.name);
  }
  checks.push({ label: "Its data files match", ok: result.changedFiles.length === 0, detail: result.changedFiles.length ? `Changed since it was taken: ${result.changedFiles.join(", ")}.` : "Every data file is the same as the live one." });

  result.ok = true;
  result.matches = result.differences.length === 0 && result.changedFiles.length === 0;
  return result;
}

export const drillFilePath = (dir = defaultDataDir()) => path.join(dir, DRILL_FILE);

export function readDrill(file = drillFilePath()): DrillResult | null {
  try {
    return readJsonStore<DrillResult | null>(file, () => null);
  } catch {
    return null;
  }
}

export function saveDrill(r: DrillResult, file = drillFilePath()): void {
  writeJsonAtomic(file, r);
}

/** Whether the monthly drill is due: never run, or the last one is a month old. */
export function drillDue(last: DrillResult | null, now = new Date()): boolean {
  return !last || now.getTime() - new Date(last.at).getTime() >= DRILL_EVERY_DAYS * 86_400_000;
}
