import { PrismaClient } from "@prisma/client";
import { sqliteFileUrlForPath } from "../sqliteDbPath.ts";
import { runBackup } from "./auto.ts";
import { backupRoot, type BackupDb } from "./backup.ts";
import { drillDue, readDrill, runRestoreDrill, saveDrill, type CountingDb, type DrillResult } from "./drill.ts";

/**
 * The server's side of the restore drill (drill.ts): one at a time, and a daily look at
 * whether the monthly one is due. It backs up first, so the snapshot it tries holds the data
 * as it is now and any difference it finds is a real one.
 */
const g = globalThis as unknown as { __pfDrill?: { running: Promise<DrillResult> | null; auto: boolean } };
const state = () => (g.__pfDrill ??= { running: null, auto: false });

export type DrillLog = (r: DrillResult, reason: string) => Promise<void>;

export function runDrillNow(db: BackupDb & CountingDb, reason: string, log?: DrillLog): Promise<DrillResult> {
  const s = state();
  if (s.running) return s.running;
  const run = (async () => {
    const found = backupRoot();
    if (!found) throw new Error("No backup folder: the drill tries the newest backup, and there is none to try.");
    await runBackup(db, "drill").catch(() => null);
    const result = await runRestoreDrill({
      root: found.root,
      live: db,
      open: (file) => new PrismaClient({ datasources: { db: { url: sqliteFileUrlForPath(file) } } }),
    });
    saveDrill(result);
    await log?.(result, reason).catch(() => {});
    return result;
  })().finally(() => {
    s.running = null;
  });
  s.running = run;
  return run;
}

export function drillRunning(): boolean {
  return state().running != null;
}

/** Looks once a day (first a while after the server starts) and runs the drill when a month has passed. Never throws. */
export function startMonthlyDrill(db: BackupDb & CountingDb, log?: DrillLog, opts: { firstAfterMs?: number; everyMs?: number } = {}) {
  const s = state();
  if (s.auto) return;
  s.auto = true;
  const tick = () => {
    if (!backupRoot() || !drillDue(readDrill())) return;
    runDrillNow(db, "monthly", log).catch((e: unknown) => console.error("[restore drill]", e instanceof Error ? e.message : e));
  };
  setTimeout(tick, opts.firstAfterMs ?? 10 * 60_000).unref?.();
  setInterval(tick, opts.everyMs ?? 24 * 60 * 60_000).unref?.();
}
