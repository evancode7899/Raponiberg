import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hashFiles, importGraph } from "../../importGraph.ts";
import { dataContent, stampTag } from "../cache.ts";

/**
 * The last proof sweep, kept on disk beside the build (<build dir>/cache/proof-sweep.json),
 * so reopening the app with nothing changed shows every figure at once instead of sweeping
 * all over again (owner's rule, 2026-11-01: the app is ready the moment it opens).
 *
 * A kept sweep is reused only for the same data, read off the files' bytes (cache.ts
 * dataContent: their modified times move on every launch), and the same sweep code: the sweep
 * runs from source (scripts/proof-sweep.ts, sweepProcess.ts), so it is keyed by every file that
 * script imports, the packages and the schema (lib/importGraph.ts), not by the build: a
 * rebuild that changed only what pages draw keeps it, while other code that could work out other
 * figures sweeps again. A dev server (no BUILD_ID) keeps nothing.
 */

type Kept = { code: string; content: string; body: string };

const buildDir = () => path.resolve(process.cwd(), process.env.NEXT_BUILD_DIR || ".next");
const file = () => path.join(buildDir(), "cache", "proof-sweep.json");

let codeMemo: string | null | undefined;
/** The sweep's code, as the files it runs from (read once per server: the code under a running server doesn't change); null on a dev server. */
function sweepCode(): string | null {
  if (codeMemo !== undefined) return codeMemo;
  try {
    readFileSync(path.join(buildDir(), "BUILD_ID"), "utf8");
    const root = process.cwd();
    const files = [...importGraph(root, ["scripts/proof-sweep.ts"]), path.join(root, "package-lock.json"), path.join(root, "prisma", "schema.prisma")];
    codeMemo = hashFiles(root, files, [process.versions.node]);
  } catch {
    codeMemo = null;
  }
  return codeMemo;
}

/** The kept sweep's answer for the data as `stamp` names it, re-tagged with that stamp; null when there's none for it. */
export function restoreSweep(stamp: string): string | null {
  const code = sweepCode();
  if (!code) return null;
  try {
    const kept = JSON.parse(readFileSync(file(), "utf8")) as Kept;
    if (kept.code !== code || kept.content !== dataContent(stamp)) return null;
    const body = JSON.parse(kept.body) as { stamp?: string };
    return JSON.stringify({ ...body, stamp: stampTag(stamp) });
  } catch {
    return null;
  }
}

/** Keeps a finished sweep's answer for the data as `stamp` names it. Never fails the sweep. */
export function keepSweep(stamp: string, body: string): void {
  const code = sweepCode();
  if (!code) return;
  try {
    const kept: Kept = { code, content: dataContent(stamp), body };
    mkdirSync(path.dirname(file()), { recursive: true });
    const tmp = `${file()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(kept));
    renameSync(tmp, file());
  } catch {
    /* the next launch sweeps again */
  }
}
