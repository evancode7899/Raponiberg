/**
 * Backs up the database and data/ to the OneDrive backup folder now (the app also does
 * this on its own every 15 minutes while it runs). See src/lib/backup/backup.ts.
 *
 * Usage:
 *   npm run backup [-- --reason <why>]
 */
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
const { prisma } = await import("../src/lib/db.ts");
const { backupRoot, createBackup } = await import("../src/lib/backup/backup.ts");

const i = process.argv.indexOf("--reason");
const reason = i > 0 ? (process.argv[i + 1] ?? "cli") : "cli";

try {
  const found = backupRoot();
  if (!found) throw new Error("No backup folder: set BACKUP_DIR in .env to a folder OneDrive syncs.");
  const r = await createBackup(prisma, { reason });
  console.log(r.status === "created" ? `Backed up to ${r.snapshot.dir}` : `Nothing changed since ${r.snapshot.name}; no new snapshot.`);
  if (r.statementsCopied) console.log(`Copied ${r.statementsCopied} statement PDF(s) to ${r.root}\\statements`);
  if (r.pruned) console.log(`Removed ${r.pruned} older snapshot(s).`);
} catch (e) {
  console.error(`Backup failed: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
