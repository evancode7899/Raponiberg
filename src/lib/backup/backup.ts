import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataDir as defaultDataDir, isDemo } from "../dataDir.ts";

/**
 * Off-machine backups: everything the app can't rebuild from the statements, copied into a
 * folder that OneDrive syncs, so a wiped or replaced computer gets the same app back.
 *
 * A snapshot is one folder under `<backup folder>/snapshots/`, named by its local time:
 *   finance.db     a consistent copy of the live database (SQLite VACUUM INTO, safe while
 *                  the app is running)
 *   *.json, *.jsonl, …  every other top-level file in data/ (exceptions, transfer and row
 *                  decisions, merchant rules, bonus letters, page inputs and their journals)
 *   manifest.json  written last; a folder without one is an unfinished snapshot
 * Stored statement PDFs (data/statements, named by their hash, never changed) are mirrored
 * once into `<backup folder>/statements/` rather than copied into every snapshot.
 *
 * A snapshot whose content matches the newest one is not written again, so backing up
 * often costs nothing while nothing changes. Older snapshots thin out (see pruneSnapshots).
 */

export const BACKUP_FOLDER_NAME = "Backup";
export const BACKUP_FORMAT = 1;

export type BackupFile = { name: string; bytes: number; sha256: string };
export type BackupManifest = {
  format: number;
  createdAt: string;
  reason: string;
  /** Hash of every file's name and content: equal hashes, same backup. */
  contentHash: string;
  /** Latest applied database migration, so a restore knows how far behind the schema is. */
  migration: string | null;
  files: BackupFile[];
  /** Statement PDFs in the shared mirror after this backup. */
  statements: number;
  host: string;
};
export type Snapshot = { name: string; dir: string; manifest: BackupManifest };

export type BackupResult =
  | { status: "created"; snapshot: Snapshot; root: string; statementsCopied: number; pruned: number }
  | { status: "unchanged"; snapshot: Snapshot; root: string; statementsCopied: number; pruned: number };

/** What a backup needs from the database client (a PrismaClient). */
export type BackupDb = {
  $executeRawUnsafe(query: string): Promise<unknown>;
  $queryRawUnsafe(query: string): Promise<unknown>;
};

type Env = Record<string, string | undefined>;

/**
 * The backup folder: BACKUP_DIR, else "Backup" in the folder that holds the
 * statements folder, else in OneDrive\Raponiberg. Null when none of those exist, so
 * nothing is written to a folder that would not leave the machine. Always null for the demo instance: its made-up
 * data must never land among the real snapshots.
 */
export function backupRoot(env: Env = process.env): { root: string; source: "BACKUP_DIR" | "statements" | "onedrive" } | null {
  if (isDemo(env)) return null;
  const explicit = env.BACKUP_DIR?.trim();
  if (explicit) return { root: path.resolve(explicit), source: "BACKUP_DIR" };
  const statements = env.STATEMENTS_DIR?.trim();
  if (statements) {
    const parent = path.dirname(path.resolve(statements));
    if (existsSync(parent)) return { root: path.join(parent, BACKUP_FOLDER_NAME), source: "statements" };
  }
  const onedrive = env.OneDrive?.trim() || env.OneDriveConsumer?.trim();
  if (onedrive) {
    const parent = path.join(onedrive, "Raponiberg");
    if (existsSync(parent)) return { root: path.join(parent, BACKUP_FOLDER_NAME), source: "onedrive" };
  }
  return null;
}

/** The SQLite file DATABASE_URL points at (relative paths resolve against prisma/, as Prisma does). */
export function databaseFilePath(env: Env = process.env, cwd = process.cwd()): string {
  const url = env.DATABASE_URL?.trim() || "file:../data/finance.db";
  const p = url.replace(/^file:/i, "").split("?")[0]!;
  return path.isAbsolute(p) ? p : path.resolve(cwd, "prisma", p);
}

const isDatabaseFile = (name: string) => /\.(db|sqlite)(-wal|-shm|-journal)?$/i.test(name);

/** Top-level files in data/ that belong in a backup: everything except database, temp and dot files (.gitkeep). */
export function dataFiles(dataDir: string): string[] {
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith(".") && !isDatabaseFile(e.name) && !e.name.endsWith(".tmp"))
    .map((e) => e.name)
    .sort();
}

function hashFile(file: string): BackupFile {
  const buf = readFileSync(file);
  return { name: path.basename(file), bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
}

export function contentHash(files: BackupFile[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) h.update(`${f.name}\0${f.sha256}\n`);
  return h.digest("hex");
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Local time, sortable: 2026-10-09_22-15-03. */
export function snapshotName(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
const SNAPSHOT_NAME = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(-\d+)?$/;

/** Finished snapshots, newest first. Folders without a readable manifest are skipped. */
export function listSnapshots(root: string): Snapshot[] {
  const dir = path.join(root, "snapshots");
  if (!existsSync(dir)) return [];
  const out: Snapshot[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || !SNAPSHOT_NAME.test(e.name)) continue;
    const snapDir = path.join(dir, e.name);
    try {
      const manifest = JSON.parse(readFileSync(path.join(snapDir, "manifest.json"), "utf8")) as BackupManifest;
      if (Array.isArray(manifest.files) && typeof manifest.contentHash === "string") out.push({ name: e.name, dir: snapDir, manifest });
    } catch {
      /* unfinished or damaged: not a snapshot */
    }
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : -1));
}

/** Problems with a snapshot's files (missing, wrong size or content); empty when it's whole. */
export function verifySnapshot(s: Snapshot): string[] {
  const problems: string[] = [];
  if (s.manifest.format > BACKUP_FORMAT) problems.push(`made by a newer version of the app (format ${s.manifest.format})`);
  if (!s.manifest.files.some((f) => f.name === "finance.db")) problems.push("no finance.db");
  for (const f of s.manifest.files) {
    const file = path.join(s.dir, f.name);
    if (!existsSync(file)) {
      problems.push(`${f.name} is missing`);
      continue;
    }
    const got = hashFile(file);
    if (got.bytes !== f.bytes || got.sha256 !== f.sha256) problems.push(`${f.name} doesn't match its manifest`);
  }
  return problems;
}

/** Copies files from `from` that `to` lacks (or holds at another size). Returns how many were copied. */
export function mirrorFolder(from: string, to: string): number {
  if (!existsSync(from)) return 0;
  mkdirSync(to, { recursive: true });
  const have = new Map<string, number>();
  for (const e of readdirSync(to, { withFileTypes: true })) if (e.isFile()) have.set(e.name, statSync(path.join(to, e.name)).size);
  let copied = 0;
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (!e.isFile() || e.name.endsWith(".tmp")) continue;
    const src = path.join(from, e.name);
    if (have.get(e.name) === statSync(src).size) continue;
    copyFileSync(src, path.join(to, e.name));
    copied++;
  }
  return copied;
}

const countFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).length : 0);

/**
 * Which snapshots to keep: the newest 10, the newest of each day for the last 45 days,
 * and the newest of each month before that.
 */
export function snapshotsToPrune(names: string[], now: Date): string[] {
  const sorted = [...names].sort().reverse();
  const cutoff = snapshotName(new Date(now.getTime() - 45 * 86_400_000)).slice(0, 10);
  const seen = new Set<string>();
  const drop: string[] = [];
  sorted.forEach((name, i) => {
    const day = name.slice(0, 10);
    const bucket = day >= cutoff ? day : name.slice(0, 7);
    if (i < 10 || !seen.has(bucket)) seen.add(bucket);
    else drop.push(name);
  });
  return drop;
}

function pruneSnapshots(root: string, now: Date): number {
  const dir = path.join(root, "snapshots");
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of snapshotsToPrune(listSnapshots(root).map((s) => s.name), now)) {
    rmSync(path.join(dir, name), { recursive: true, force: true });
    removed++;
  }
  // Unfinished snapshots (no manifest) more than a day old: an interrupted backup.
  const finished = new Set(listSnapshots(root).map((s) => s.name));
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || finished.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (now.getTime() - statSync(p).mtimeMs > 86_400_000) {
      rmSync(p, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

/** The backup folder's README.txt; `repoUrl` is where this copy of the app was cloned from. */
export const readmeText = (repoUrl: string) => `Raponiberg: backups
===================

The app copies its data here on its own (every 15 minutes while it runs, only when
something changed, and when you close it with the power button). Settings > Data shows
the latest backup and has a "Back up now" button.

  snapshots\\<date_time>\\   finance.db (the ledger) + the owner-decision files from data\\
  statements\\              the stored statement PDFs (data\\statements)

Older snapshots thin out: the newest 10, one a day for 45 days, then one a month.

New or wiped computer
---------------------
1. Install Node.js (LTS) and Git for Windows. Sign in to OneDrive and let this folder
   finish syncing.
2. In PowerShell:

     git clone ${repoUrl} C:\\dev\\personal-finance
     cd C:\\dev\\personal-finance
     npm install
     npm run setup

   "npm run setup" creates .env, restores the newest snapshot from this folder, brings the
   database up to the current schema and puts the Raponiberg shortcut on the Desktop.
3. Double-click "Raponiberg" on the Desktop.

Restore on this computer (replaces the current data; it's copied to
data\\backups\\pre-restore_<time>\\ first): close the app with its power button, then

     npm run restore                  newest snapshot
     npm run restore -- --list        list snapshots
     npm run restore -- 2026-10-09_22-15-03
`;

/** This copy's git remote, minus any credentials in it; a placeholder when there isn't one. */
function cloneUrl(): string {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (url) return url.replace(/\/\/[^/@]*@/, "//");
  } catch {
    /* no git, or no remote */
  }
  return "<this app's GitHub address>";
}

function writeReadme(root: string) {
  const file = path.join(root, "README.txt");
  try {
    const text = readmeText(cloneUrl());
    if (existsSync(file) && readFileSync(file, "utf8") === text) return;
    writeFileSync(file, text);
  } catch {
    /* the readme is a convenience */
  }
}

/** One backup at a time per machine (the server's timer and a script could overlap). */
function lock(): () => void {
  const file = path.join(os.tmpdir(), "pf-backup.lock");
  try {
    if (existsSync(file) && Date.now() - statSync(file).mtimeMs > 10 * 60_000) rmSync(file, { force: true });
    closeSync(openSync(file, "wx"));
  } catch {
    throw new Error("Another backup is already running.");
  }
  return () => rmSync(file, { force: true });
}

async function latestMigration(db: BackupDb): Promise<string | null> {
  try {
    const rows = (await db.$queryRawUnsafe(
      "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1",
    )) as { migration_name: string }[];
    return rows[0]?.migration_name ?? null;
  } catch {
    return null;
  }
}

export type BackupOptions = { reason?: string; root?: string; dataDir?: string; now?: Date };

/** Backs up the database and data/ into the backup folder (see the top of this file). */
export async function createBackup(db: BackupDb, opts: BackupOptions = {}): Promise<BackupResult> {
  if (!opts.root && isDemo()) throw new Error("The demo doesn't back up: its data is made up.");
  const root = opts.root ?? backupRoot()?.root;
  if (!root) throw new Error("No backup folder: set BACKUP_DIR in .env (for example OneDrive\\Raponiberg\\Backup).");
  if (!existsSync(path.dirname(root))) throw new Error(`The backup folder's parent doesn't exist: ${path.dirname(root)}`);
  const dataDir = opts.dataDir ?? defaultDataDir();
  const now = opts.now ?? new Date();

  const unlock = lock();
  const work = mkdtempSync(path.join(os.tmpdir(), "pf-backup-"));
  try {
    const dbCopy = path.join(work, "finance.db");
    await db.$executeRawUnsafe(`VACUUM INTO '${dbCopy.replace(/'/g, "''")}'`);
    const files: BackupFile[] = [hashFile(dbCopy)];
    for (const name of dataFiles(dataDir)) {
      copyFileSync(path.join(dataDir, name), path.join(work, name));
      files.push(hashFile(path.join(work, name)));
    }
    const hash = contentHash(files);

    mkdirSync(root, { recursive: true });
    const statementsCopied = mirrorFolder(path.join(dataDir, "statements"), path.join(root, "statements"));
    writeReadme(root);

    const latest = listSnapshots(root)[0];
    if (latest && latest.manifest.contentHash === hash) {
      return { status: "unchanged", snapshot: latest, root, statementsCopied, pruned: 0 };
    }

    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      createdAt: now.toISOString(),
      reason: opts.reason ?? "manual",
      contentHash: hash,
      migration: await latestMigration(db),
      files,
      statements: countFiles(path.join(root, "statements")),
      host: os.hostname(),
    };
    const snapshots = path.join(root, "snapshots");
    let name = snapshotName(now);
    for (let i = 2; existsSync(path.join(snapshots, name)); i++) name = `${snapshotName(now)}-${i}`;
    const dir = path.join(snapshots, name);
    mkdirSync(dir, { recursive: true });
    for (const f of files) copyFileSync(path.join(work, f.name), path.join(dir, f.name));
    // Written last: it's what makes the folder a finished snapshot.
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

    const pruned = pruneSnapshots(root, now);
    return { status: "created", snapshot: { name, dir, manifest }, root, statementsCopied, pruned };
  } finally {
    rmSync(work, { recursive: true, force: true });
    unlock();
  }
}

export type RestorePlan = { snapshot: Snapshot; dataDir: string; dbFile: string; root: string };

/**
 * Puts a snapshot back: the current database and data files are copied to
 * data/backups/pre-restore_<time>/ first, then replaced; statement PDFs missing from
 * data/statements come back from the mirror. The app must be stopped. Returns the folder
 * holding the previous data (null when there was none).
 */
export function restoreSnapshot(plan: RestorePlan, now = new Date()): { previous: string | null; files: number; statementsCopied: number } {
  const problems = verifySnapshot(plan.snapshot);
  if (problems.length) throw new Error(`Snapshot ${plan.snapshot.name} can't be restored: ${problems.join("; ")}`);
  mkdirSync(plan.dataDir, { recursive: true });

  const replaced = plan.snapshot.manifest.files.filter((f) => f.name !== "finance.db").map((f) => path.join(plan.dataDir, f.name));
  const current = [plan.dbFile, `${plan.dbFile}-wal`, `${plan.dbFile}-shm`, ...replaced].filter((f) => existsSync(f));
  let previous: string | null = null;
  if (current.length) {
    previous = path.join(plan.dataDir, "backups", `pre-restore_${snapshotName(now)}`);
    mkdirSync(previous, { recursive: true });
    for (const f of current) copyFileSync(f, path.join(previous, path.basename(f)));
  }

  for (const side of ["-wal", "-shm", "-journal"]) rmSync(plan.dbFile + side, { force: true });
  mkdirSync(path.dirname(plan.dbFile), { recursive: true });
  for (const f of plan.snapshot.manifest.files) {
    copyFileSync(path.join(plan.snapshot.dir, f.name), f.name === "finance.db" ? plan.dbFile : path.join(plan.dataDir, f.name));
  }
  const statementsCopied = mirrorFolder(path.join(plan.root, "statements"), path.join(plan.dataDir, "statements"));
  return { previous, files: plan.snapshot.manifest.files.length, statementsCopied };
}
