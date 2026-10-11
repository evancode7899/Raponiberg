/**
 * Where the SQLite database lives: DATABASE_URL from the environment or `.env`, falling
 * back to data/finance.db. Relative `file:` paths resolve against prisma/, as Prisma does.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function loadDatabaseUrlFromEnvFile() {
  const envPath = path.join(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return null;
  }
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    if (key !== "DATABASE_URL") continue;
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    return val;
  }
  return null;
}

export function resolveDbFilePath() {
  const url =
    process.env.DATABASE_URL ?? loadDatabaseUrlFromEnvFile() ?? "file:../data/finance.db";
  let p = url.replace(/^file:/i, "");
  if (!path.isAbsolute(p)) {
    p = path.resolve(process.cwd(), "prisma", p);
  }
  return p;
}
