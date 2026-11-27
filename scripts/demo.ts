/**
 * Starts the demo: a second copy of the app, on its own port, reading only made-up data
 * in data/demo. It shares the code and the build with the real app but never its data:
 *   DATABASE_URL  data/demo/finance.db
 *   DATA_DIR      data/demo (JSON stores, stored statements)
 *   APP_PROFILE   demo, which turns off backups and the real statements folder
 *
 * data/demo is rebuilt from scratch every start, so whatever visitors change is gone next
 * time. The real app (port 3000) can run at the same time.
 *
 * Usage:
 *   npm run demo              next start on the newer production build of .next-app and .next
 *   npm run demo -- --dev     next dev, in its own build folder (.next-dev-demo)
 *   npm run demo -- --build-only   rebuild data/demo and exit
 *   npm run demo -- --sweep        rebuild data/demo and run the proof sweep on it (CI): exits 1 on any problem
 *   npm run demo -- --render-audit start the demo on the production build, render every page in a
 *                                  headless browser and hold what it draws to the sweep (CI, SSOT F6;
 *                                  scripts/render-audit.ts): exits 1 on any problem. Takes --sweep too.
 *                                  Refuses a build older than the code it would audit; add --build to
 *                                  build first (into .next, never the launcher's .next-app). In a
 *                                  worktree sharing another checkout's node_modules, it builds with the
 *                                  Prisma client already there instead of regenerating it.
 *   npm run demo -- --render-audit --reuse-data   on the data/demo already there (CI's shards share
 *                                  one: each seed mints its own record ids, which proof keys carry)
 *   npm run demo -- --render-audit --timings   times every warmed report first (scripts/endpoint-timings.ts)
 *   npm run demo -- --render-audit --ui-checks keyboard, component and visual checks after the audit (scripts/ui-checks.ts)
 *   npm run demo -- --render-audit --full      every tab drawn afresh, the render cache unused (below)
 * DEMO_PORT changes the port (default 3001).
 *
 * The seeded demo is kept (DEMO_SEED_CACHE, default the system temp folder), keyed by every
 * file the seed runs (lib/importGraph.ts), the schema and migrations, the lockfile and
 * DEMO_TODAY: the next start with nothing changed copies it back instead of seeding again
 * (--fresh-seed seeds anyway). The same seed keeps the same record ids, which proof keys carry.
 * Off CI, --render-audit keeps each tab's drawing in a render cache (RENDER_AUDIT_CACHE,
 * default the system temp folder; scripts/render-audit-cache.ts) and draws again only the
 * tabs whose answers changed. With --sweep as well, the server's own sweep (the same sweep,
 * on the same data) is held to the sweep's rules instead of sweeping a second time.
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REAL_DATA_ENV } from "../src/lib/dataEnv.ts";
import { latestBuildDir, staleBuild } from "./build-freshness.ts";
import { filesUnder, hashFiles, importGraph } from "../src/lib/importGraph.ts";
import { prismaClientIsShared } from "../src/lib/sharedModules.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEMO_DIR = path.join(ROOT, "data", "demo");
const DB = path.join(DEMO_DIR, "finance.db");
const PORT = process.env.DEMO_PORT?.trim() || "3001";
const dev = process.argv.includes("--dev");

// Files and folders the real .env may point elsewhere (every one the app reads: lib/dataEnv.ts).
// Set empty here, they win over .env (Next and Prisma never override a variable that's
// already set) and fall back to DATA_DIR.
const REAL_FILES = REAL_DATA_ENV;

// Started by the real server (lib/demo/launch.ts), this inherits that server's runtime
// variables (its origin, phase, NODE_ENV); the demo's own Next server sets its own.
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("__NEXT") && !["NEXT_RUNTIME", "NEXT_PHASE", "NODE_ENV", "PORT"].includes(k)),
);

/**
 * The demo's "today": its made-up statements run through June 2026, so it always reads as
 * mid-July 2026, figure for figure, whatever the date (lib/dates/isoDate.ts localToday). The
 * render audit pins the browser's clock to the same day. DEMO_TODAY moves it.
 */
const DEMO_TODAY = process.env.DEMO_TODAY?.trim() || "2026-07-15";

const env: Record<string, string | undefined> = {
  ...inherited,
  ...Object.fromEntries(REAL_FILES.map((k) => [k, ""])),
  APP_PROFILE: "demo",
  APP_TODAY: DEMO_TODAY,
  DATA_DIR: DEMO_DIR,
  DATABASE_URL: `file:${DB.replace(/\\/g, "/")}`,
  BACKUP_AUTO: "0",
  PRISMA_HIDE_UPDATE_MESSAGE: "1",
};

function node(args: string[], what: string, extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env: { ...env, ...extra } as NodeJS.ProcessEnv, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${what} failed.`);
}

/** Where seeded demos are kept, one folder per seed key; the newest few are kept. */
const SEED_CACHE = process.env.DEMO_SEED_CACHE?.trim() || path.join(os.tmpdir(), "raponiberg-demo-seed");
const SEEDS_KEPT = 4;

/** Everything the seeded demo is made from: the seed's code (every local file it imports), the schema and migrations, the packages, and its day. */
function seedKey(): string {
  const files = [...importGraph(ROOT, ["scripts/demo-seed.ts", "scripts/seed-categories.mjs"]), ...filesUnder(path.join(ROOT, "prisma")), path.join(ROOT, "package-lock.json")];
  return hashFiles(ROOT, files, [DEMO_TODAY, process.versions.node.split(".")[0]!]).slice(0, 24);
}

/** A fresh demo database on the current schema, filled with the made-up household: copied from the kept seed of the same code, or seeded and kept. */
function buildDemoData() {
  const key = seedKey();
  const kept = path.join(SEED_CACHE, key);
  rmSync(DEMO_DIR, { recursive: true, force: true });
  if (!process.argv.includes("--fresh-seed") && existsSync(path.join(kept, "finance.db"))) {
    // Times kept too: the data stamp reads them (lib/book/cache.ts), so the same data reads as the same data.
    cpSync(kept, DEMO_DIR, { recursive: true, preserveTimestamps: true });
    console.log(`Demo data: the kept seed ${key.slice(0, 12)} (nothing it's made from has changed).`);
    return;
  }
  mkdirSync(DEMO_DIR, { recursive: true });
  node([path.join(ROOT, "node_modules", "prisma", "build", "index.js"), "migrate", "deploy"], "Creating the demo database");
  node(["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", path.join(ROOT, "scripts", "seed-categories.mjs")], "Seeding demo categories");
  node(["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", path.join(ROOT, "scripts", "demo-seed.ts")], "Filling the demo data");
  // Kept whole or not at all (another checkout may be keeping the same seed at once).
  try {
    mkdirSync(SEED_CACHE, { recursive: true });
    const tmp = `${kept}.${process.pid}.tmp`;
    cpSync(DEMO_DIR, tmp, { recursive: true, preserveTimestamps: true });
    rmSync(kept, { recursive: true, force: true });
    renameSync(tmp, kept);
    const all = readdirSync(SEED_CACHE)
      .filter((n) => !n.endsWith(".tmp"))
      .map((n) => ({ n, at: statSync(path.join(SEED_CACHE, n)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const { n } of all.slice(SEEDS_KEPT)) rmSync(path.join(SEED_CACHE, n), { recursive: true, force: true });
  } catch (e) {
    console.log(`(The seed wasn't kept: ${(e as Error).message})`);
  }
}

function buildDir(): string {
  return dev ? ".next-dev-demo" : latestBuildDir(ROOT);
}

/**
 * The production build the render audit runs on: one finished after every build input last
 * changed, so it never audits old code. A missing or stale build fails, or with --build is
 * rebuilt first, into .next (or NEXT_BUILD_DIR): never .next-app, which the running app
 * serves and only the launcher swaps.
 */
function freshBuildDir(): string {
  const dir = buildDir();
  const why = staleBuild(ROOT, dir);
  if (!why) return dir;
  if (!process.argv.includes("--build")) throw new Error(`${why}: add --build, or run npm run build first (never in a worktree sharing node_modules).`);
  const target = process.env.NEXT_BUILD_DIR || ".next";
  console.log(`${why}: building into ${target}.`);
  const steps: [string[], string][] = [[[path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "build"], "next build"]];
  // Regenerating a shared client would point the running app at this checkout's database (lib/sharedModules.ts).
  if (prismaClientIsShared(ROOT)) console.log("The Prisma client is shared with another checkout: building with it as it is, without prisma generate.");
  else steps.unshift([[path.join(ROOT, "node_modules", "prisma", "build", "index.js"), "generate"], "prisma generate"]);
  for (const [args, what] of steps) {
    const r = spawnSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, NEXT_BUILD_DIR: target }, stdio: "inherit" });
    if (r.status !== 0) throw new Error(`${what} failed.`);
  }
  return target;
}

/** Starts the demo's Next server on the production build, waits until it answers, runs the render audit on it, and stops it. */
async function renderAudit(dir: string) {
  const base = `http://127.0.0.1:${PORT}`;
  // Another server already there (another checkout's demo) would answer for ours and be audited instead.
  if (await fetch(base).then(() => true, () => false)) throw new Error(`Something already answers on ${base}: stop it, or set DEMO_PORT.`);
  const next = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
  const server = spawn(process.execPath, [next, "start", "-H", "127.0.0.1", "-p", PORT], {
    cwd: ROOT,
    env: { ...env, NEXT_BUILD_DIR: dir } as Record<string, string | undefined> as NodeJS.ProcessEnv,
    stdio: ["ignore", "ignore", "inherit"],
  });
  try {
    const until = Date.now() + 60_000;
    for (;;) {
      if (server.exitCode != null) throw new Error(`The demo server stopped (${server.exitCode}).`);
      if (await fetch(`${base}/api/app-password`).then((r) => r.ok, () => false)) break;
      if (Date.now() > until) throw new Error(`The demo server didn't answer on ${base} within a minute.`);
      await new Promise((r) => setTimeout(r, 500));
    }
    if (process.argv.includes("--timings")) node(["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--disable-warning=ExperimentalWarning", path.join(ROOT, "scripts", "endpoint-timings.ts"), base], "The demo's endpoint timings");
    // Off CI, a render cache of the demo's own (CI's shards each deal one plan, and its main runs stay whole).
    const cache: Record<string, string> = !process.env.CI && !process.argv.includes("--full") && !process.env.RENDER_AUDIT_SHARD ? { RENDER_AUDIT_CACHE: process.env.RENDER_AUDIT_CACHE?.trim() || path.join(os.tmpdir(), "raponiberg-render-audit", "demo") } : {};
    node(["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--disable-warning=ExperimentalWarning", path.join(ROOT, "scripts", "render-audit.ts"), base], "The demo's render audit", {
      ...cache,
      RENDER_AUDIT_BUILD_ID: readFileSync(path.join(ROOT, dir, "BUILD_ID"), "utf8").trim(),
      ...(process.argv.includes("--sweep") ? { RENDER_AUDIT_SWEEP_GATE: "1" } : {}),
    });
    if (process.argv.includes("--ui-checks")) node(["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--disable-warning=ExperimentalWarning", path.join(ROOT, "scripts", "ui-checks.ts"), base], "The demo's UI checks");
  } finally {
    server.kill();
  }
}

try {
  // Checked first, so a stale build fails before the minutes of demo data and sweep.
  const auditDir = process.argv.includes("--render-audit") ? freshBuildDir() : null;
  if (!process.argv.includes("--reuse-data")) buildDemoData();
  else if (!existsSync(DB)) throw new Error(`--reuse-data: no demo database at ${path.relative(ROOT, DB)}.`);
  // With --render-audit too, the server's sweep is held to the same rules there (RENDER_AUDIT_SWEEP_GATE): one sweep, not two.
  if (process.argv.includes("--sweep") && !auditDir) {
    node(["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--disable-warning=ExperimentalWarning", path.join(ROOT, "scripts", "proof-sweep.ts")], "The demo's proof sweep");
  }
  if (auditDir) {
    await renderAudit(auditDir);
  } else if (!process.argv.includes("--build-only") && !process.argv.includes("--sweep")) {
    const dir = buildDir();
    if (!dev && !existsSync(path.join(ROOT, dir, "BUILD_ID"))) throw new Error(`No production build in ${dir}: run npm run build first, or use npm run demo -- --dev.`);
    console.log(`\nDemo on http://127.0.0.1:${PORT} (data: ${path.relative(ROOT, DEMO_DIR)})`);
    const next = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
    // --webpack: a worktree's junctioned node_modules is outside Turbopack's root.
    const bundler = dev && process.argv.includes("--webpack") ? ["--webpack"] : [];
    const child = spawn(process.execPath, [next, dev ? "dev" : "start", ...bundler, "-H", "127.0.0.1", "-p", PORT], {
      cwd: ROOT,
      env: { ...env, NEXT_BUILD_DIR: dir } as Record<string, string | undefined> as NodeJS.ProcessEnv,
      stdio: "inherit",
    });
    child.on("exit", (code) => process.exit(code ?? 0));
  }
} catch (e) {
  console.error(`Demo failed: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
}
