import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { filesUnder, hashFiles, importGraph } from "./importGraph";

const ROOT = path.resolve(__dirname, "..", "..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "import-graph-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function tree(files: Record<string, string>) {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
    writeFileSync(path.join(tmp, f), text);
  }
}

describe("importGraph", () => {
  tree({
    "scripts/main.ts": `import { a } from "../src/lib/a.ts";\nimport type { T } from "@/lib/types";\nexport * from "./re";\nconst later = await import("./lazy.ts");\nimport "node:fs";\nimport x from "some-package";`,
    "scripts/re.ts": `export const r = 1;`,
    "scripts/lazy.ts": `export const l = 1;`,
    "src/lib/a.ts": `import {\n  b,\n  c,\n} from "./dir";`,
    "src/lib/dir/index.ts": `export const b = 1, c = 2;`,
    "src/lib/types.ts": `export type T = 1;`,
    "src/lib/unused.ts": `export const u = 1;`,
  });

  it("follows relative, @/ (src/), re-exports, dynamic and multi-line imports, through to index files; not packages", () => {
    const got = importGraph(tmp, ["scripts/main.ts"]).map((f) => path.relative(tmp, f).replace(/\\/g, "/"));
    expect(got).toEqual(["scripts/lazy.ts", "scripts/main.ts", "scripts/re.ts", "src/lib/a.ts", "src/lib/dir/index.ts", "src/lib/types.ts"].sort());
  });

  it("hashes paths and bytes: a change to any file reached changes it, one not reached doesn't", () => {
    const h = () => hashFiles(tmp, importGraph(tmp, ["scripts/main.ts"]));
    const before = h();
    writeFileSync(path.join(tmp, "src/lib/unused.ts"), "export const u = 2;");
    expect(h()).toBe(before);
    writeFileSync(path.join(tmp, "src/lib/dir/index.ts"), "export const b = 1, c = 3;");
    expect(h()).not.toBe(before);
    expect(hashFiles(tmp, [], ["a"])).not.toBe(hashFiles(tmp, [], ["b"]));
  });

  it("lists every file under a folder", () => {
    expect(filesUnder(path.join(tmp, "src", "lib", "dir")).map((f) => path.basename(f))).toEqual(["index.ts"]);
  });

  // The kept proof sweep (book/proof/sweepStore.ts) is keyed by this graph of scripts/proof-sweep.ts: it's only whole if
  // every import there names its file outright.
  it("reaches all of the proof sweep's code: no import built from a variable, no require", () => {
    const graph = importGraph(ROOT, ["scripts/proof-sweep.ts"]);
    expect(graph.length).toBeGreaterThan(100);
    const odd = graph.filter((f) => /\.[mc]?[jt]sx?$/.test(f)).flatMap((f) => {
      const t = readFileSync(f, "utf8");
      return [...t.matchAll(/\bimport\(\s*([^)\s][^)]*)\)/g)].filter((m) => !/^["'][^"'`$]*["']$/.test(m[1]!.trim())).map((m) => `${path.relative(ROOT, f)}: import(${m[1]})`).concat(/\brequire\(/.test(t) ? [`${path.relative(ROOT, f)}: require`] : []);
    });
    expect(odd).toEqual([]);
  });
});
