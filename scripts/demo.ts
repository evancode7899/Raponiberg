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
 *   npm run demo              next start on the last production build (.next-app, else .next)
 *   npm run demo -- --dev     next dev, in its own build folder (.next-dev-demo)
 *   npm run demo -- --build-only   rebuild data/demo and exit
 *   npm run demo -- --sweep        rebuild data/demo and run the proof sweep on it (CI): exits 1 on any problem
 * DEMO_PORT changes the port (default 3001).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
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

const env: Record<string, string | undefined> = {
  ...inherited,
  ...Object.fromEntries(REAL_FILES.map((k) => [k, ""])),
  APP_PROFILE: "demo",
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

function buildDir(): string {
  if (dev) return ".next-dev-demo";
  if (process.env.NEXT_BUILD_DIR) return process.env.NEXT_BUILD_DIR;
  return existsSync(path.join(ROOT, ".next-app", "BUILD_ID")) ? ".next-app" : ".next";
}

try {
  buildDemoData();
  if (process.argv.includes("--sweep")) {
    node(["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--disable-warning=ExperimentalWarning", path.join(ROOT, "scripts", "proof-sweep.ts")], "The demo's proof sweep");
  } else if (!process.argv.includes("--build-only")) {
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
