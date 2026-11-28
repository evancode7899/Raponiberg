/**
 * Writes the phone digest: one read-only HTML page (no JavaScript, no network: inline CSS,
 * the chart as inline SVG) with net worth and its recent change, a small net worth chart,
 * the latest proven month's cash flow, what's coming up and how the goals stand. Only
 * figures the app already proves (the Dashboard's reports), as of the proven-through date.
 *
 * Where it goes: DIGEST_DIR (set it in .env to a folder your phone syncs), or --out <folder>.
 * Never inside this repository. The file is raponiberg-digest.html.
 *
 * On an iPhone, use iCloud Drive's Shortcuts folder (on Windows:
 * iCloudDrive/iCloud~is~workflow~my~workflows) and a Shortcut with one "Open File" action
 * on the digest. OneDrive's Files provider won't let Shortcuts pick its folders.
 *
 * Usage: npm run digest [-- --out <folder>]
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(path.join(ROOT, ".env"))) process.loadEnvFile(path.join(ROOT, ".env"));

const arg = process.argv.indexOf("--out");
const dir = (arg > 0 ? process.argv[arg + 1] : process.env.DIGEST_DIR)?.trim();
if (!dir) {
  console.error("Set DIGEST_DIR in .env to the folder the digest goes in (one your phone syncs), or pass --out <folder>.");
  process.exit(2);
}
const out = path.resolve(dir);
const rel = path.relative(ROOT, out);
if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
  console.error(`Refusing to write the digest inside the repository (${out}): pick a folder outside it.`);
  process.exit(2);
}

// Loaded after the env file, so the database is the one .env names.
const { loadBook } = await import("../src/lib/book/load.ts");
const { buildHomeSummary } = await import("../src/lib/dashboard/homeSummary.ts");
const { loadBriefing } = await import("../src/lib/dashboard/loadBriefing.ts");
const { prisma } = await import("../src/lib/db.ts");
const { renderDigest } = await import("../src/lib/digest/render.ts");

const DUE = 6;
const MONTHS = 24;

try {
  const book = await loadBook(prisma);
  const summary = buildHomeSummary(book);
  const briefing = await loadBriefing(prisma, book);
  const nw = summary.netWorth;
  const lm = summary.cashFlow.lastMonth;
  const html = renderDigest({
    asOf: nw.asOf,
    written: new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }),
    netWorth: { total: nw.totalCents, month: nw.change.month.cents, ytd: nw.change.ytd.cents, ytdYear: nw.change.ytdYear, series: nw.series.slice(-MONTHS).map((p) => ({ end: p.end, cents: p.cents })) },
    cashFlow: lm ? { label: lm.label, income: lm.incomeCents, spending: lm.spendingCents, net: lm.netCents } : null,
    due: briefing.due.filter((x) => !x.done).slice(0, DUE).map((x) => ({ date: x.date, title: x.title, cents: x.dateOnly ? null : x.cents })),
    goals: briefing.goals.map((g) => ({ name: g.name, status: g.status, current: g.blockers.length ? null : g.currentCents, target: g.targetCents, lands: g.blockers.length ? null : g.lands })),
  });
  mkdirSync(out, { recursive: true });
  const file = path.join(out, "raponiberg-digest.html");
  // Overwritten in place, never written to a temp file and renamed over: a synced folder
  // (iCloud Drive for Windows especially) treats a rename as delete + new file, so the
  // phone keeps a stale copy and a Shortcut's "Open File" stays pinned to it.
  writeFileSync(file, html);
  console.log(`Wrote ${file} (${Math.round(html.length / 1024)} KB), proven through ${nw.asOf}.`);
} finally {
  await prisma.$disconnect();
}
