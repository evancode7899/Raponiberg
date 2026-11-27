/**
 * What a script is made of: the file and every local file it imports, followed through
 * relative and "@/" (src/) specifiers, static and dynamic. Packages count through
 * package-lock.json, which callers hash beside it. Used to key what's kept from code run from
 * source: the proof sweep (book/proof/sweepStore.ts, which runs scripts/proof-sweep.ts) and the
 * seeded demo (scripts/demo.ts), so a change to any file that code could run invalidates it.
 * Every import must name its file outright: one built from a variable can't be followed.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SPECIFIER = /(?:\bimport\s*(?:[\w*{}\s,$]+\s*from\s*)?|\bexport\s*(?:[\w*{}\s,$]+\s*from\s*)|\bimport\s*\(\s*)["'`]([^"'`]+)["'`]/g;
const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".mjs", ".js", ".json", "/index.ts", "/index.tsx", "/index.js"];

function resolve(root: string, from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? path.join(root, "src", spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
  if (!base) return null;
  for (const ext of EXTENSIONS) {
    const f = base + ext;
    if (statSync(f, { throwIfNoEntry: false })?.isFile()) return f;
  }
  return null;
}

/** Every local file the entries reach, sorted (absolute paths). */
export function importGraph(root: string, entries: string[]): string[] {
  const seen = new Set<string>();
  const todo = entries.map((e) => path.resolve(root, e));
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    if (!/\.(m?[jt]sx?)$/.test(f)) continue;
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(SPECIFIER)) {
      const r = resolve(root, f, m[1]!);
      if (r && !seen.has(r)) todo.push(r);
    }
  }
  return [...seen].sort();
}

/** Every file under a folder (or the file itself), sorted. */
export function filesUnder(p: string): string[] {
  const st = statSync(p, { throwIfNoEntry: false });
  if (!st) return [];
  if (!st.isDirectory()) return [p];
  return readdirSync(p)
    .sort()
    .flatMap((e) => filesUnder(path.join(p, e)));
}

/** A hash of the files' paths (relative to root) and bytes, and of any extra strings. */
export function hashFiles(root: string, files: string[], extra: string[] = []): string {
  const h = createHash("sha256");
  for (const f of [...new Set(files)].sort()) h.update(`\n${path.relative(root, f).replace(/\\/g, "/")}\n`).update(readFileSync(f));
  for (const x of extra) h.update(`\n${x}`);
  return h.digest("hex");
}
