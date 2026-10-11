import { existsSync } from "node:fs";
import { backupRoot, createBackup, listSnapshots, type BackupDb, type BackupResult } from "./backup.ts";

/**
 * The server's side of the backups: one backup at a time, the outcome of the last one for
 * Settings › Data, and a timer that backs up shortly after the server starts and then every
 * 15 minutes (a backup with nothing new writes nothing).
 */

export const AUTO_BACKUP_EVERY_MS = 15 * 60_000;

type Outcome = { at: string; reason: string; ok: true; result: BackupResult } | { at: string; reason: string; ok: false; error: string };
type State = { running: Promise<BackupResult> | null; last: Outcome | null; auto: boolean };

// On globalThis: route bundles and instrumentation must share one state.
const g = globalThis as unknown as { __pfBackup?: State };
const state = (): State => (g.__pfBackup ??= { running: null, last: null, auto: false });

/** Backs up now, or joins the backup already running. */
export function runBackup(db: BackupDb, reason: string): Promise<BackupResult> {
  const s = state();
  if (s.running) return s.running;
  const at = new Date().toISOString();
  const run = createBackup(db, { reason })
    .then((result) => {
      s.last = { at, reason, ok: true, result };
      return result;
    })
    .catch((e: unknown) => {
      s.last = { at, reason, ok: false, error: e instanceof Error ? e.message : String(e) };
      throw e;
    })
    .finally(() => {
      s.running = null;
    });
  s.running = run;
  return run;
}

/** Starts the timer (once per process). Failures are kept for Settings and logged, never thrown. */
export function startAutoBackup(db: BackupDb, opts: { firstAfterMs?: number; everyMs?: number } = {}) {
  const s = state();
  if (s.auto) return;
  s.auto = true;
  const tick = () => {
    if (!backupRoot()) return;
    runBackup(db, "auto").catch((e: unknown) => console.error("[backup]", e instanceof Error ? e.message : e));
  };
  setTimeout(tick, opts.firstAfterMs ?? 60_000).unref?.();
  setInterval(tick, opts.everyMs ?? AUTO_BACKUP_EVERY_MS).unref?.();
}

export type BackupStatus = {
  root: string | null;
  source: string | null;
  rootExists: boolean;
  auto: boolean;
  everyMinutes: number;
  running: boolean;
  last: { at: string; reason: string; ok: boolean; status?: string; error?: string } | null;
  latest: { name: string; createdAt: string; reason: string; bytes: number; files: number; statements: number; host: string } | null;
  snapshots: number;
  error: string | null;
};

/** What Settings › Data shows. */
export function backupStatus(): BackupStatus {
  const s = state();
  const found = backupRoot();
  let snaps: ReturnType<typeof listSnapshots> = [];
  let error: string | null = null;
  try {
    if (found) snaps = listSnapshots(found.root);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const latest = snaps[0];
  return {
    root: found?.root ?? null,
    source: found?.source ?? null,
    rootExists: found ? existsSync(found.root) : false,
    auto: s.auto,
    everyMinutes: AUTO_BACKUP_EVERY_MS / 60_000,
    running: s.running != null,
    last: s.last ? { at: s.last.at, reason: s.last.reason, ok: s.last.ok, ...(s.last.ok ? { status: s.last.result.status } : { error: s.last.error }) } : null,
    latest: latest
      ? {
          name: latest.name,
          createdAt: latest.manifest.createdAt,
          reason: latest.manifest.reason,
          bytes: latest.manifest.files.reduce((t, f) => t + f.bytes, 0),
          files: latest.manifest.files.length,
          statements: latest.manifest.statements,
          host: latest.manifest.host,
        }
      : null,
    snapshots: snaps.length,
    error,
  };
}
