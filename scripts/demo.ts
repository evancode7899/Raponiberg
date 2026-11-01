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
 *                                  build first (into .next, never the launcher's .next-app).
 *   npm run demo -- --render-audit --reuse-data   on the data/demo already there (CI's shards share
 *                                  one: each seed mints its own record ids, which proof keys carry)
 * DEMO_PORT changes the port (default 3001).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEMO_DIR = path.join(ROOT, "data", "demo");
const DB = path.join(DEMO_DIR, "finance.db");
const PORT = process.env.DEMO_PORT?.trim() || "3001";
const dev = process.argv.includes("--dev");

// Files the real .env may point elsewhere. Set empty here, they win over .env (Next and
// Prisma never override a variable that's already set) and fall back to DATA_DIR.
const REAL_FILES = [
  "INTEGRITY_EXCEPTIONS_FILE",
  "TRANSFER_DECISIONS_FILE",
  "BONUS_AWARDS_FILE",
  "BONUS_REVIEWS_FILE",
  "MERCHANT_RULES_FILE",
  "ROW_DECISIONS_FILE",
  "PAGE_INPUTS_FILE",
  "APP_PASSWORD_FILE",
  "HOUSEHOLD_FILE",
  "STATEMENTS_DIR",
  "BACKUP_DIR",
];

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

function node(args: string[], what: string) {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env: env as NodeJS.ProcessEnv, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${what} failed.`);
}

/** A fresh demo database on the current schema, filled with the made-up household. */
function buildDemoData() {
  rmSync(DEMO_DIR, { recursive: true, force: true });
  mkdirSync(DEMO_DIR, { recursive: true });
  node([path.join(ROOT, "node_modules", "prisma", "build", "index.js"), "migrate", "deploy"], "Creating the demo database");
  node(["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", path.join(ROOT, "scripts", "seed-categories.mjs")], "Seeding demo categories");
  node(["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", path.join(ROOT, "scripts", "demo-seed.ts")], "Filling the demo data");
}

/**
 * What a production build is made from: the set the launcher stamps before it rebuilds
 * (scripts/start-local-server.ps1). Scripts under scripts/ run from source, so they're not in it.
 */
const BUILD_INPUTS = ["src", "prisma", "next.config.ts", "postcss.config.mjs", "tsconfig.json", "package.json", "package-lock.json"];

/** The most recently written build input, and when. */
function newestInput(): { file: string; at: number } {
  const newest = { file: "", at: 0 };
  const walk = (p: string) => {
    const st = statSync(p, { throwIfNoEntry: false });
    if (st?.isDirectory()) for (const e of readdirSync(p)) walk(path.join(p, e));
    else if (st && st.mtimeMs > newest.at) Object.assign(newest, { file: p, at: st.mtimeMs });
  };
  for (const p of BUILD_INPUTS) walk(path.join(ROOT, p));
  return newest;
}

/** When the build in this folder finished (next build writes BUILD_ID last), or null with no build. */
function builtAt(dir: string): number | null {
  return statSync(path.join(ROOT, dir, "BUILD_ID"), { throwIfNoEntry: false })?.mtimeMs ?? null;
}

function buildDir(): string {
  if (dev) return ".next-dev-demo";
  if (process.env.NEXT_BUILD_DIR) return process.env.NEXT_BUILD_DIR;
  // The newer of the launcher's build and a plain `npm run build`.
  return (builtAt(".next-app") ?? -1) > (builtAt(".next") ?? -1) ? ".next-app" : ".next";
}

/**
 * The production build the render audit runs on: one finished after every build input last
 * changed, so it never audits old code. A missing or stale build fails, or with --build is
 * rebuilt first, into .next (or NEXT_BUILD_DIR): never .next-app, which the running app
 * serves and only the launcher swaps.
 */
function freshBuildDir(): string {
  const dir = buildDir();
  const at = builtAt(dir);
  const newest = newestInput();
  if (at != null && at >= newest.at) return dir;
  const why = at == null ? `No production build in ${dir}` : `The build in ${dir} is older than the code (${path.relative(ROOT, newest.file)} changed since)`;
  if (!process.argv.includes("--build")) throw new Error(`${why}: run npm run build first, or add --build.`);
  const target = process.env.NEXT_BUILD_DIR || ".next";
  console.log(`${why}: building into ${target}.`);
  for (const [args, what] of [
    [[path.join(ROOT, "node_modules", "prisma", "build", "index.js"), "generate"], "prisma generate"],
    [[path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "build"], "next build"],
  ] as [string[], string][]) {
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
    node(["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--disable-warning=ExperimentalWarning", path.join(ROOT, "scripts", "render-audit.ts"), base], "The demo's render audit");
  } finally {
    server.kill();
  }
}

try {
  // Checked first, so a stale build fails before the minutes of demo data and sweep.
  const auditDir = process.argv.includes("--render-audit") ? freshBuildDir() : null;
  if (!process.argv.includes("--reuse-data")) buildDemoData();
  else if (!existsSync(DB)) throw new Error(`--reuse-data: no demo database at ${path.relative(ROOT, DB)}.`);
  if (process.argv.includes("--sweep")) {
    node(["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--disable-warning=ExperimentalWarning", path.join(ROOT, "scripts", "proof-sweep.ts")], "The demo's proof sweep");
  }
  if (auditDir) {
    await renderAudit(auditDir);
  } else if (!process.argv.includes("--build-only") && !process.argv.includes("--sweep")) {
    const dir = buildDir();
    if (!dev && !existsSync(path.join(ROOT, dir, "BUILD_ID"))) throw new Error(`No production build in ${dir}: run npm run build first, or use npm run demo -- --dev.`);
    console.log(`\nDemo on http://127.0.0.1:${PORT} (data: ${path.relative(ROOT, DEMO_DIR)})`);
    const next = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
    const child = spawn(process.execPath, [next, dev ? "dev" : "start", "-H", "127.0.0.1", "-p", PORT], {
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
