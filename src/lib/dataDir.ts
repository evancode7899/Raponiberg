import path from "node:path";

/**
 * The folder this server keeps its data in: the JSON stores, stored statement files and
 * pre-import database copies. DATA_DIR, or data/ in the app folder. The database itself is
 * DATABASE_URL; the demo instance (scripts/demo.ts) points both at data/demo.
 */
export function dataDir(env: Record<string, string | undefined> = process.env): string {
  const d = env.DATA_DIR?.trim();
  return d ? path.resolve(d) : path.join(process.cwd(), "data");
}

/**
 * The demo instance (APP_PROFILE=demo): made-up data, so it never backs up (the backup
 * folder holds the owner's real snapshots) and never reads the real statements folder.
 */
export function isDemo(env: Record<string, string | undefined> = process.env): boolean {
  return env.APP_PROFILE === "demo";
}
