/**
 * Sets up this copy of the app on a new (or wiped) computer, after `npm install`:
 *   1. creates .env from .env.example if it's missing
 *   2. restores the newest snapshot from the OneDrive backup folder, if there's no
 *      database here yet (an existing database is left alone)
 *   3. brings the database up to the current schema (npm run db:refresh)
 *   4. turns on the repository's git hooks (.githooks/pre-push: the privacy check before
 *      every push)
 *   5. puts the Raponiberg shortcut on the Desktop
 *
 * Usage:
 *   npm run setup [-- --from <backup folder>] [--no-shortcuts]
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { databaseFilePath } from "../src/lib/backup/backup.ts";
import { restore } from "./restore-backup.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd: string) => spawnSync(cmd, { cwd: ROOT, stdio: "inherit", shell: true }).status === 0;
const i = process.argv.indexOf("--from");
const from = i > 0 ? process.argv[i + 1] : undefined;

try {
  const env = path.join(ROOT, ".env");
  if (!existsSync(env)) {
    copyFileSync(path.join(ROOT, ".env.example"), env);
    console.log("Created .env from .env.example");
  }
  process.loadEnvFile(env);

  if (existsSync(path.join(ROOT, ".git")) && run("git config core.hooksPath .githooks")) console.log("Turned on the privacy check before every git push (.githooks/pre-push).");

  let migrated = false;
  if (existsSync(databaseFilePath())) {
    console.log("A database is already here; not restoring (use npm run restore to replace it).");
  } else {
    const r = await restore({ from, yes: true, ifAvailable: !from });
    migrated = r === "restored";
    if (r === "none") console.log("Starting with an empty database: import statements from Statements > Import.");
  }
  if (!migrated && !run("npm run db:refresh")) throw new Error("npm run db:refresh failed.");

  if (process.platform === "win32" && !process.argv.includes("--no-shortcuts") && !run("npm run desktop:shortcut")) console.warn("Could not create the Desktop shortcut; run npm run desktop:shortcut later.");
  console.log('\nDone. Double-click "Raponiberg" on the Desktop to start the app.');
} catch (e) {
  console.error(`Setup failed: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
}
