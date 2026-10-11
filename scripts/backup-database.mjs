/**
 * Timestamped copy of SQLite DB + PRAGMA integrity_check (via Prisma).
 * Run from project root: npm run db:backup
 *
 * WAL: runs wal_checkpoint(TRUNCATE) so a single .db file is consistent for backup.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { loadDatabaseUrlFromEnvFile, resolveDbFilePath } from "./databasePath.mjs";

async function main() {
  if (!process.env.DATABASE_URL) {
    const fromFile = loadDatabaseUrlFromEnvFile();
    if (fromFile) {
      process.env.DATABASE_URL = fromFile;
    }
  }
  const dbPath = resolveDbFilePath();
  if (!existsSync(dbPath)) {
    console.error(`Database file not found: ${dbPath}`);
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    await prisma.$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)");
    const rows = await prisma.$queryRawUnsafe(
      "PRAGMA integrity_check",
    );
    const first = Array.isArray(rows) ? rows[0] : null;
    const check =
      first && typeof first === "object" && "integrity_check" in first
        ? String(
            /** @type {{ integrity_check: string }} */ (first).integrity_check,
          )
        : JSON.stringify(rows);
    if (check !== "ok") {
      console.error(`PRAGMA integrity_check failed: ${check}`);
      process.exit(1);
    }
    console.log("PRAGMA integrity_check: ok");
  } finally {
    await prisma.$disconnect();
  }

  const backupsDir = path.join(process.cwd(), "data", "backups");
  mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const dest = path.join(backupsDir, `finance_${stamp}.db`);
  copyFileSync(dbPath, dest);
  console.log(`Backed up to ${dest}`);

  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = dbPath + suffix;
    if (existsSync(sidecar)) {
      copyFileSync(sidecar, dest + suffix);
      console.log(`Copied sidecar ${path.basename(sidecar)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
