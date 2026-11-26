import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Five text sizes and no more (globals.css: --step-meta, small, body, title, display). Pages
 * name a step (text-2xs … text-3xl); the few pixel sizes written before the scale are each
 * drawn at a step by globals.css, and no new one may appear.
 */
const STEP_NAMES = new Set(["2xs", "xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl"]);
const MAPPED_PX = new Set(["9px", "10px", "11px", "11.5px", "12px", "12.5px", "13px", "15px"]);

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* sources(p);
    else if (/\.tsx$/.test(name)) yield p;
  }
}

describe("the type scale", () => {
  it("every text size is a step, or a pixel size globals.css draws at one", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    for (const px of MAPPED_PX) expect(css, px).toContain(`.text-\\[${px.replace(".", "\\.")}\\]`);
    const strays: string[] = [];
    for (const f of sources("src")) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/(?<![\w-])text-(\[[^\]]+\]|\d?xs|sm|base|lg|\dxl|xl)(?![\w-])/g)) {
        const v = m[1]!;
        const ok = v.startsWith("[") ? MAPPED_PX.has(v.slice(1, -1)) || /^\[(var|color|#)/.test(v) : STEP_NAMES.has(v);
        if (!ok) strays.push(`${f}: text-${v}`);
      }
    }
    expect(strays).toEqual([]);
  });

  it("has exactly five steps", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    expect([...css.matchAll(/^\s*--step-([a-z]+):/gm)].map((m) => m[1])).toEqual(["meta", "small", "body", "title", "display"]);
  });
});
