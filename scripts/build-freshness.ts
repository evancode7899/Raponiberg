/**
 * Whether a production build is as new as the code it was built from: the render audits
 * (scripts/demo.ts --render-audit, scripts/render-audit-real.ts) never audit old code.
 *
 * Run directly, `node scripts/build-freshness.ts --stamp <dir>` writes the digest of the
 * build inputs into the build folder, so the same build copied to another machine (CI builds
 * once and its render-audit shards reuse it) is known by what it was built from, not by when
 * its files were written.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What a production build is made from: the set the launcher stamps before it rebuilds
 * (scripts/start-local-server.ps1). Scripts under scripts/ run from source, so they're not in it.
 */
const BUILD_INPUTS = ["src", "prisma", "next.config.ts", "postcss.config.mjs", "tsconfig.json", "package.json", "package-lock.json"];

/** The file in a build folder that names the inputs it was built from (inputsDigest). */
export const INPUTS_STAMP = "BUILD_INPUTS_SHA256";

/** Every build input file, relative to root with forward slashes, sorted. */
function inputFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    const st = statSync(p, { throwIfNoEntry: false });
    if (st?.isDirectory()) for (const e of readdirSync(p)) walk(path.join(p, e));
    else if (st) out.push(path.relative(root, p).split(path.sep).join("/"));
  };
  for (const p of BUILD_INPUTS) walk(path.join(root, p));
  return out.sort();
}

/** The most recently written build input, and when. */
export function newestInput(root: string): { file: string; at: number } {
  const newest = { file: "", at: 0 };
  for (const f of inputFiles(root)) {
    const at = statSync(path.join(root, f)).mtimeMs;
    if (at > newest.at) Object.assign(newest, { file: path.join(root, f), at });
  }
  return newest;
}

/** A digest of every build input's path and bytes (line endings as checked out). */
export function inputsDigest(root: string): string {
  const h = createHash("sha256");
  for (const f of inputFiles(root)) {
    h.update(`${f}\0`);
    h.update(readFileSync(path.join(root, f)));
    h.update("\0");
  }
  return h.digest("hex");
}

/** When the build in this folder finished (next build writes BUILD_ID last), or null with no build. */
export function builtAt(root: string, dir: string): number | null {
  return statSync(path.join(root, dir, "BUILD_ID"), { throwIfNoEntry: false })?.mtimeMs ?? null;
}

/** NEXT_BUILD_DIR, else the newer of the launcher's build (.next-app) and a plain `npm run build` (.next). */
export function latestBuildDir(root: string): string {
  if (process.env.NEXT_BUILD_DIR) return process.env.NEXT_BUILD_DIR;
  return (builtAt(root, ".next-app") ?? -1) > (builtAt(root, ".next") ?? -1) ? ".next-app" : ".next";
}

/** The digest a build was stamped with (stampBuild), or null when it wasn't. */
function stampOf(root: string, dir: string): string | null {
  try {
    return readFileSync(path.join(root, dir, INPUTS_STAMP), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Notes in the build folder which inputs it was built from: run right after the build, on the same checkout. */
export function stampBuild(root: string, dir: string): string {
  if (builtAt(root, dir) == null) throw new Error(`No production build in ${dir} to stamp.`);
  const digest = inputsDigest(root);
  writeFileSync(path.join(root, dir, INPUTS_STAMP), `${digest}\n`);
  return digest;
}

/**
 * Why the build in dir can't be audited (none, or older than the code), or null when it's
 * fresh: stamped from these very inputs, or (unstamped) finished after every input last changed.
 */
export function staleBuild(root: string, dir: string): string | null {
  const at = builtAt(root, dir);
  if (at == null) return `No production build in ${dir}`;
  const stamp = stampOf(root, dir);
  if (stamp) return stamp === inputsDigest(root) ? null : `The build in ${dir} was built from other code than this checkout's`;
  const newest = newestInput(root);
  if (at >= newest.at) return null;
  return `The build in ${dir} is older than the code (${path.relative(root, newest.file)} changed since)`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--stamp");
  if (i < 0 || !process.argv[i + 1]) {
    console.error("Usage: node scripts/build-freshness.ts --stamp <build dir>");
    process.exit(2);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  console.log(`Stamped ${process.argv[i + 1]} with its inputs: ${stampBuild(root, process.argv[i + 1]!).slice(0, 12)}`);
}
