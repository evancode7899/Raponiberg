import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataContent, stampTag } from "../cache.ts";

/**
 * The last proof sweep, kept on disk beside the build (<build dir>/cache/proof-sweep.json),
 * so reopening the app with nothing changed shows every figure at once instead of sweeping
 * all over again (owner's rule, 2026-11-01: the app is ready the moment it opens).
 *
 * A kept sweep is reused only for the same data, read off the files' bytes (cache.ts
 * dataContent: their modified times move on every launch), and the same build of the app
 * (BUILD_ID: other code can work out other figures). A new build lands in a fresh folder,
 * so it never finds an old build's sweep. A dev server has no BUILD_ID and keeps nothing.
 */

type Kept = { buildId: string; content: string; body: string };

const buildDir = () => path.resolve(process.cwd(), process.env.NEXT_BUILD_DIR || ".next");
const file = () => path.join(buildDir(), "cache", "proof-sweep.json");

function buildId(): string | null {
  try {
    return readFileSync(path.join(buildDir(), "BUILD_ID"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** The kept sweep's answer for the data as `stamp` names it, re-tagged with that stamp; null when there's none for it. */
export function restoreSweep(stamp: string): string | null {
  const id = buildId();
  if (!id) return null;
  try {
    const kept = JSON.parse(readFileSync(file(), "utf8")) as Kept;
    if (kept.buildId !== id || kept.content !== dataContent(stamp)) return null;
    const body = JSON.parse(kept.body) as { stamp?: string };
    return JSON.stringify({ ...body, stamp: stampTag(stamp) });
  } catch {
    return null;
  }
}

/** Keeps a finished sweep's answer for the data as `stamp` names it. Never fails the sweep. */
export function keepSweep(stamp: string, body: string): void {
  const id = buildId();
  if (!id) return;
  try {
    const kept: Kept = { buildId: id, content: dataContent(stamp), body };
    mkdirSync(path.dirname(file()), { recursive: true });
    const tmp = `${file()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(kept));
    renameSync(tmp, file());
  } catch {
    /* the next launch sweeps again */
  }
}
