/**
 * The render audit (scripts/render-audit.ts) on the owner's own data, on this computer
 * only. It starts a second, read-only copy of the app on the last production build, on a
 * free port (never 3000, where the real app runs), with the real DATA_DIR/DATABASE_URL
 * (from the environment or .env), and stops only the server it started.
 *
 *   - Never in CI: it refuses when CI is set.
 *   - Read-only: LAUNCH_UPKEEP=0 and BACKUP_AUTO=0 keep the second server from re-reading
 *     statements, moving files or backing up, and the audit itself refuses every write.
 *   - The lock screen: the password is read from the local data file at run time and
 *     checked by the server the way the lock screen does (POST /api/app-password); it is
 *     never printed, passed on, or written anywhere.
 *   - No real figures in the output: the console lists problem kinds, pages and counts
 *     (RENDER_AUDIT_REDACT), and the JSON dump goes to the system temp folder, never into
 *     the repo. --detail prints each problem in full, for working through them locally.
 *
 * Usage:
 *   npm run audit:real                         every page, drills capped (default 10 a view)
 *   npm run audit:real -- --pages /taxes,/hsa  just those pages (a partial run)
 *   npm run audit:real -- --drills 0           no drill-downs (fastest); --drills 80 is CI's depth
 *   npm run audit:real -- --detail             each problem with its view, value and key (local only)
 *   npm run audit:real -- --json <file>        where the dump goes (outside the repo; default: temp)
 * AUDIT_PORT picks the port; NEXT_BUILD_DIR the build (default the newer of .next-app and
 * .next; one older than the code is refused);
 * RENDER_AUDIT_BUDGET_MS the time budget (default 5 minutes here).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readAppPassword } from "../src/lib/appPassword.ts";
import { latestBuildDir, staleBuild } from "./build-freshness.ts";
import { dataDir } from "../src/lib/dataDir.ts";
import { resolveSqliteDatabaseFilePath, sqliteFileUrlForPath } from "../src/lib/sqliteDbPath.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function fail(why: string): never {
  console.error(`audit:real: ${why}`);
  process.exit(2);
}

if (process.env.CI) fail("refusing to run in CI: this audits the owner's real data, which CI never has.");

// The real app's settings, as next start would read them (variables already set win).
const envFile = path.join(ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
if (process.env.APP_PROFILE === "demo") fail("APP_PROFILE is demo: use npm run demo -- --render-audit for the demo.");
const DATA = dataDir();
// A relative file: URL is Prisma's, relative to prisma/ (lib/sqliteDbPath.ts); the server gets it absolute.
if (!process.env.DATABASE_URL?.trim()) process.env.DATABASE_URL = sqliteFileUrlForPath(path.join(DATA, "finance.db"));
const dbFile = resolveSqliteDatabaseFilePath();
if (!dbFile || !existsSync(dbFile)) fail("no SQLite database at DATABASE_URL (set it, or DATA_DIR, in .env).");
const DATABASE_URL = sqliteFileUrlForPath(dbFile);

// The dump holds real figures: never inside the repo, bar the gitignored data folder.
const json = path.resolve(option("--json") ?? path.join(os.tmpdir(), "raponiberg-render-audit-real.json"));
const inside = (dir: string, f: string) => !path.relative(dir, f).startsWith("..") && !path.isAbsolute(path.relative(dir, f));
if (inside(ROOT, json) && !inside(path.join(ROOT, "data"), json)) fail("--json must be outside the repo (or under data/): it holds real figures.");

// Never old code: the same rule as the demo's audit (scripts/build-freshness.ts).
const dir = latestBuildDir(ROOT);
const stale = staleBuild(ROOT, dir);
if (stale) fail(`${stale}: run npm run build first.`);

/** A free port on 127.0.0.1, or AUDIT_PORT; never the real app's 3000 or the demo's 3001. */
async function freePort(): Promise<string> {
  const asked = process.env.AUDIT_PORT?.trim();
  if (asked) {
    if (asked === "3000" || asked === "3001") fail(`AUDIT_PORT ${asked} is the real app's or the demo's.`);
    return asked;
  }
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(String(port)));
    });
  });
}

const PORT = await freePort();
const base = `http://127.0.0.1:${PORT}`;
// Another server already there would answer for ours and be audited instead.
if (await fetch(base).then(() => true, () => false)) fail(`something already answers on ${base}: pick another AUDIT_PORT.`);
const serverEnv: Record<string, string | undefined> = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("__NEXT") && !["NEXT_RUNTIME", "NEXT_PHASE", "NODE_ENV", "PORT", "APP_TODAY"].includes(k))),
  DATA_DIR: DATA,
  DATABASE_URL,
  NEXT_BUILD_DIR: dir,
  LAUNCH_UPKEEP: "0",
  BACKUP_AUTO: "0",
  PRISMA_HIDE_UPDATE_MESSAGE: "1",
};
console.log(`Starting a read-only copy of the app on ${base} (build ${dir})…`);
const next = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
const server = spawn(process.execPath, [next, "start", "-H", "127.0.0.1", "-p", PORT], { cwd: ROOT, env: serverEnv as NodeJS.ProcessEnv, stdio: ["ignore", "ignore", "pipe"] });
// The server's errors can quote data: kept to a count unless --detail.
let serverErrors = 0;
server.stderr.on("data", (b: Buffer) => {
  serverErrors++;
  if (flag("--detail")) process.stderr.write(b);
});

/** Stops the server this started and whatever it started (the proof sweep's own process), nothing else. */
function stop() {
  if (server.exitCode != null || server.pid == null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  else server.kill();
}
process.on("SIGINT", () => (stop(), process.exit(130)));

const started = Date.now();
let status = 1;
try {
  const until = Date.now() + 90_000;
  for (;;) {
    if (server.exitCode != null) throw new Error(`the server stopped (${server.exitCode}); run with --detail to see why.`);
    if (await fetch(`${base}/api/app-password`).then((r) => r.ok, () => false)) break;
    if (Date.now() > until) throw new Error(`the server didn't answer on ${base} within 90 s.`);
    await new Promise((r) => setTimeout(r, 500));
  }
  // The lock screen's own check: the server must accept the password before any page is opened.
  const unlocked = await fetch(`${base}/api/app-password`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: readAppPassword() }) })
    .then((r) => r.json() as Promise<{ ok?: boolean }>)
    .catch(() => ({ ok: false }));
  if (!unlocked.ok) throw new Error("the server refused the lock-screen password from the data folder.");

  const r = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--disable-warning=ExperimentalWarning", path.join(ROOT, "scripts", "render-audit.ts"), base], {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      APP_TODAY: "",
      RENDER_AUDIT_UNLOCK: "1",
      RENDER_AUDIT_REDACT: flag("--detail") ? "0" : "1",
      RENDER_AUDIT_JSON: json,
      RENDER_AUDIT_DRILLS: option("--drills") ?? process.env.RENDER_AUDIT_DRILLS ?? "10",
      RENDER_AUDIT_BUDGET_MS: process.env.RENDER_AUDIT_BUDGET_MS ?? "300000",
      ...(option("--pages") ? { RENDER_AUDIT_ONLY: option("--pages") } : {}),
    },
  });
  status = r.status ?? 1;
  if (existsSync(json) && statSync(json).mtimeMs >= started) console.log(`\nEverything drawn and every problem, in full: ${json} (real figures: keep it out of the repo).`);
  if (serverErrors && !flag("--detail")) console.log(`The server wrote ${serverErrors} error chunk(s); --detail shows them.`);
} catch (e) {
  console.error(`audit:real: ${e instanceof Error ? e.message : e}`);
} finally {
  stop();
}
process.exit(status);
