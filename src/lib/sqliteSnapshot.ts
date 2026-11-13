import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type RawDb = { $executeRawUnsafe(query: string): Promise<unknown> };

/**
 * Writes a complete copy of the open database to `file` (which must not exist yet). SQLite
 * makes the copy itself (VACUUM INTO), so it holds everything committed so far, including
 * what still sits in the write-ahead log: copying finance.db alone can miss the latest
 * changes. The backup (lib/backup/backup.ts) copies the database the same way.
 */
export async function copyDatabaseTo(db: RawDb, file: string): Promise<void> {
  await db.$executeRawUnsafe(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
}

/** The bytes of a complete copy of the open database. */
export async function databaseBytes(db: RawDb): Promise<Buffer> {
  const work = mkdtempSync(path.join(os.tmpdir(), "pf-export-"));
  try {
    const copy = path.join(work, "finance.db");
    await copyDatabaseTo(db, copy);
    if (!existsSync(copy)) throw new Error("The database copy wasn't written.");
    return readFileSync(copy);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
