/**
 * The README's screenshots, from the demo's made-up household:
 *
 *   npm run demo                                      (in one terminal; DEMO_PORT moves it)
 *   node scripts/screenshots.ts http://127.0.0.1:3001 [--themes terminal,dark,light] [--out docs/screenshots]
 *
 * Each page is drawn at 1440 by 900 once every figure on it has cleared its proof (none still
 * being checked), and saved as <page>.png (the first theme) or <page>-<theme>.png. It asks the
 * server first and refuses anything but the demo: real data never reaches a screenshot.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "package.json"));

export const SHOTS: { name: string; at: string }[] = [
  { name: "dashboard", at: "/" },
  { name: "net-worth", at: "/net-worth" },
  { name: "cash-flow", at: "/cash-flow" },
  { name: "taxes", at: "/taxes" },
  { name: "forecast", at: "/forecast" },
  { name: "insurance", at: "/insurance?tab=auto" },
  { name: "checks", at: "/statements?tab=checks" },
];
export const THEMES = ["terminal", "dark", "light"] as const;

/** The file a shot is saved as: the first theme keeps the plain name the README links to. */
export const fileOf = (name: string, theme: string, first: boolean) => (first ? `${name}.png` : `${name}-${theme}.png`);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const base = process.argv[2]?.replace(/\/$/, "");
  if (!base || base.startsWith("--")) {
    console.error("Usage: node scripts/screenshots.ts <demo-url> [--themes terminal,dark,light] [--out docs/screenshots]");
    process.exit(2);
  }
  // The demo says so itself (api/app-password); the real app never does.
  const who = (await fetch(`${base}/api/app-password`).then((r) => r.json(), () => null)) as { demo?: boolean } | null;
  if (!who?.demo) throw new Error(`${base} isn't the demo: screenshots are only ever taken of the made-up household.`);
  const themes = (arg("--themes") ?? "terminal").split(",").filter((t): t is (typeof THEMES)[number] => (THEMES as readonly string[]).includes(t));
  if (!themes.length) throw new Error(`--themes takes ${THEMES.join(", ")}`);
  const out = path.resolve(ROOT, arg("--out") ?? "docs/screenshots");
  mkdirSync(out, { recursive: true });

  const { chromium } = require("playwright-core") as typeof import("playwright-core");
  const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch({ channel: "chrome" }));
  try {
    for (const [i, theme] of themes.entries()) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      // The theme, and the demo's first-run tour already seen.
      await ctx.addInitScript((t) => {
        localStorage.setItem("pf-theme", t);
        localStorage.setItem("pf-tour-done", "1");
      }, theme);
      for (const s of SHOTS) {
        const page = await ctx.newPage();
        await page.goto(base + s.at, { timeout: 60_000 });
        await page.waitForFunction(() => document.querySelectorAll('[data-clearance="cleared"]').length > 0 && !document.querySelector('[data-clearance="verifying"], [data-skeleton]'), null, { timeout: 90_000 });
        await page.waitForTimeout(600);
        const file = path.join(out, fileOf(s.name, theme, i === 0));
        await page.screenshot({ path: file });
        console.log(`${theme.padEnd(9)} ${s.at.padEnd(26)} ${path.relative(ROOT, file)}`);
        await page.close();
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1]?.endsWith("screenshots.ts")) main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
