/**
 * Whether a production build is as new as the code it was built from: the render audits
 * (scripts/demo.ts --render-audit, scripts/render-audit-real.ts) never audit old code.
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * What a production build is made from: the set the launcher stamps before it rebuilds
 * (scripts/start-local-server.ps1). Scripts under scripts/ run from source, so they're not in it.
 */
const BUILD_INPUTS = ["src", "prisma", "next.config.ts", "postcss.config.mjs", "tsconfig.json", "package.json", "package-lock.json"];

/** The most recently written build input, and when. */
export function newestInput(root: string): { file: string; at: number } {
  const newest = { file: "", at: 0 };
  const walk = (p: string) => {
    const st = statSync(p, { throwIfNoEntry: false });
    if (st?.isDirectory()) for (const e of readdirSync(p)) walk(path.join(p, e));
    else if (st && st.mtimeMs > newest.at) Object.assign(newest, { file: p, at: st.mtimeMs });
  };
  for (const p of BUILD_INPUTS) walk(path.join(root, p));
  return newest;
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

/** Why the build in dir can't be audited (none, or older than the code), or null when it's fresh. */
export function staleBuild(root: string, dir: string): string | null {
  const at = builtAt(root, dir);
  const newest = newestInput(root);
  if (at != null && at >= newest.at) return null;
  return at == null ? `No production build in ${dir}` : `The build in ${dir} is older than the code (${path.relative(root, newest.file)} changed since)`;
}
