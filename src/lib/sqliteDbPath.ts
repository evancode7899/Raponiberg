import path from "node:path";

/** Absolute path to the SQLite file for `file:` DATABASE_URL, or null if not SQLite file URL. */
export function resolveSqliteDatabaseFilePath(): string | null {
  const url = process.env.DATABASE_URL?.trim();
  if (!url?.toLowerCase().startsWith("file:")) {
    return null;
  }
  let p = url.replace(/^file:/i, "");
  if (!path.isAbsolute(p)) {
    p = path.resolve(process.cwd(), "prisma", p);
  }
  return p;
}

/** Prisma `file:` URL for an absolute filesystem path (Windows-safe). */
export function sqliteFileUrlForPath(absPath: string): string {
  const slash = absPath.replace(/\\/g, "/");
  return /^[A-Za-z]:/.test(slash) ? `file:${slash}` : `file:${slash}`;
}

const SQLITE_MAGIC = Buffer.from("SQLite format 3\0");

export function bufferLooksLikeSqliteDatabase(buf: Buffer): boolean {
  return buf.length >= 16 && buf.subarray(0, 16).equals(SQLITE_MAGIC);
}
