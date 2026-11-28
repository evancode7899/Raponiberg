/**
 * Writes the phone digest now: one read-only HTML page (no JavaScript, no network: inline
 * CSS, charts as inline SVG) in five tabs: Home, Net worth, Cash, Invest and Plans. Only
 * figures the app already proves, as of the proven-through date (src/lib/digest). Every
 * backup writes it too (the app's, on its 15-minute timer and when it closes, and
 * `npm run backup`), so running this by hand is only needed to refresh it in between.
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
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(path.join(ROOT, ".env"))) process.loadEnvFile(path.join(ROOT, ".env"));

// Loaded after the env file, so the database is the one .env names.
const { digestDir, writeDigest } = await import("../src/lib/digest/write.ts");
const { loadBook } = await import("../src/lib/book/load.ts");
const { prisma } = await import("../src/lib/db.ts");

const arg = process.argv.indexOf("--out");
const asked = arg > 0 ? process.argv[arg + 1]?.trim() : undefined;
const dir = digestDir(ROOT, asked ? { ...process.env, DIGEST_DIR: asked } : process.env);
if (!dir) {
  console.error(
    (asked ?? process.env.DIGEST_DIR)?.trim()
      ? "Refusing to write the digest there: it must be outside the repository (and the demo never writes one)."
      : "Set DIGEST_DIR in .env to the folder the digest goes in (one your phone syncs), or pass --out <folder>.",
  );
  process.exit(2);
}

try {
  const r = await writeDigest(prisma, await loadBook(prisma), dir);
  console.log(`Wrote ${r.file} (${Math.round(r.bytes / 1024)} KB), proven through ${r.asOf}.`);
} finally {
  await prisma.$disconnect();
}
