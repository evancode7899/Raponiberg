/**
 * Restores a snapshot from the OneDrive backup folder into this copy of the app: the
 * database, the decision files in data/ and the stored statement PDFs. The current data is
 * copied to data/backups/pre-restore_<time>/ first. Afterwards the database is brought up
 * to the current schema (the migrations of npm run db:refresh). The app must be stopped.
 *
 * Usage:
 *   npm run restore                      newest snapshot
 *   npm run restore -- --list            list snapshots
 *   npm run restore -- <snapshot name>   a specific one (e.g. 2026-10-09_22-15-03)
 *   options: --from <backup folder>  --yes (don't ask)  --if-available (no backup folder
 *            is not an error)  --no-migrate
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { BACKUP_FOLDER_NAME, backupRoot, databaseFilePath, listSnapshots, restoreSnapshot, verifySnapshot } from "../src/lib/backup/backup.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT, ".env");

export type RestoreOptions = { name?: string; from?: string; yes?: boolean; ifAvailable?: boolean; migrate?: boolean; list?: boolean };

/** Sets KEY="value" lines in .env, replacing an existing line for the key or appending one. */
export function setEnvValues(file: string, values: Record<string, string>) {
  let text = existsSync(file) ? readFileSync(file, "utf8") : "";
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}="${value.replace(/\\/g, "/")}"`;
    const re = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
    text = re.test(text) ? text.replace(re, line) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
  }
  writeFileSync(file, text);
}

function serverRunning(port = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.setTimeout(700);
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("timeout", () => (s.destroy(), resolve(false)));
    s.once("error", () => resolve(false));
  });
}

/** Opens a copy of the snapshot's database and runs PRAGMA integrity_check. */
async function checkDatabase(file: string) {
  const { PrismaClient } = await import("@prisma/client");
  const dir = mkdtempSync(path.join(os.tmpdir(), "pf-restore-"));
  const copy = path.join(dir, "check.db");
  copyFileSync(file, copy);
  const db = new PrismaClient({ datasources: { db: { url: `file:${copy.replace(/\\/g, "/")}` } } });
  try {
    const rows = (await db.$queryRawUnsafe("PRAGMA integrity_check")) as { integrity_check: string }[];
    if (rows[0]?.integrity_check !== "ok") throw new Error(`integrity_check: ${rows[0]?.integrity_check ?? "no answer"}`);
  } finally {
    await db.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Finds the backup folder: --from, BACKUP_DIR, or beside the statements folder / in OneDrive. */
function findRoot(from?: string): string | null {
  if (from) return path.resolve(from);
  const found = backupRoot();
  return found && existsSync(found.root) ? found.root : null;
}

export async function restore(opts: RestoreOptions): Promise<"restored" | "none" | "listed"> {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
  const root = findRoot(opts.from);
  if (!root) {
    if (opts.ifAvailable) {
      console.log("No backup folder found; nothing to restore.");
      return "none";
    }
    throw new Error(
      `No backup folder found. Let OneDrive finish syncing, or pass it: npm run restore -- --from "<OneDrive>\\Desktop\\Personal Finance\\${BACKUP_FOLDER_NAME}"`,
    );
  }
  const snapshots = listSnapshots(root);
  if (opts.list) {
    console.log(`Snapshots in ${root} (newest first):`);
    for (const s of snapshots) console.log(`  ${s.name}  ${s.manifest.files.length} files  ${s.manifest.reason}  ${s.manifest.host}`);
    if (!snapshots.length) console.log("  (none)");
    return "listed";
  }
  if (!snapshots.length) {
    if (opts.ifAvailable) {
      console.log(`No snapshots in ${root}; nothing to restore.`);
      return "none";
    }
    throw new Error(`No snapshots in ${root}.`);
  }
  const snapshot = opts.name ? snapshots.find((s) => s.name === opts.name) : snapshots[0];
  if (!snapshot) throw new Error(`No snapshot named ${opts.name} in ${root} (npm run restore -- --list).`);
  const problems = verifySnapshot(snapshot);
  if (problems.length) {
    throw new Error(
      `Snapshot ${snapshot.name} is incomplete (${problems.join("; ")}). If OneDrive is still downloading, wait and try again; or pick an older one (npm run restore -- --list).`,
    );
  }
  const dbFile = databaseFilePath();
  // Replacing a database the running app has open would corrupt it (a fresh copy has none to replace).
  if (existsSync(dbFile) && (await serverRunning())) throw new Error("The app is running. Close it first (the power button in the app), then run this again.");
  if (existsSync(dbFile) && !opts.yes) {
    if (!process.stdin.isTTY) throw new Error("A database already exists here. Re-run with --yes to replace it (it's copied to data/backups first).");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Replace the data in this app with snapshot ${snapshot.name}? The current data is copied to data/backups first. [y/N] `);
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log("Nothing changed.");
      return "none";
    }
  }

  console.log(`Checking ${snapshot.name}…`);
  await checkDatabase(path.join(snapshot.dir, "finance.db"));
  const r = restoreSnapshot({ snapshot, root, dataDir: path.join(ROOT, "data"), dbFile });
  console.log(`Restored ${r.files} files from ${snapshot.dir}`);
  if (r.statementsCopied) console.log(`Restored ${r.statementsCopied} statement PDF(s).`);
  if (r.previous) console.log(`The previous data is in ${r.previous}`);

  // Point this copy of the app at the backup folder and, if needed, the statements beside it.
  const env: Record<string, string> = {};
  if (!process.env.BACKUP_DIR) env.BACKUP_DIR = root;
  const statements = process.env.STATEMENTS_DIR;
  const sibling = path.join(path.dirname(root), "3. Statements");
  if ((!statements || !existsSync(statements)) && existsSync(sibling)) env.STATEMENTS_DIR = sibling;
  if (Object.keys(env).length) {
    setEnvValues(ENV_FILE, env);
    console.log(`Set ${Object.keys(env).join(", ")} in .env`);
  }

  if (opts.migrate !== false) {
    // db:refresh without its final `prisma generate`: this process has the Prisma engine
    // loaded (the integrity check), so regenerating it would fail, and npm install made it.
    console.log("Bringing the database up to the current schema…");
    const res = spawnSync("node scripts/rebaseline-database.mjs && npx prisma migrate deploy", {
      cwd: ROOT,
      stdio: "inherit",
      shell: true,
      env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    });
    if (res.status !== 0) throw new Error("Migrating the restored database failed; the restored files are in place. Run npm run db:refresh once the problem is fixed.");
  }
  return "restored";
}

function parseArgs(argv: string[]): RestoreOptions {
  const opts: RestoreOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--list") opts.list = true;
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--if-available") opts.ifAvailable = true;
    else if (a === "--no-migrate") opts.migrate = false;
    else if (a === "--from") opts.from = argv[++i];
    else if (!a.startsWith("-")) opts.name = a;
    else throw new Error(`Unknown option ${a}`);
  }
  return opts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await restore(parseArgs(process.argv.slice(2)));
  } catch (e) {
    console.error(`Restore failed: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}
