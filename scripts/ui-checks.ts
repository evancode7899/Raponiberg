/**
 * Keyboard, component and visual checks on the demo (item 63), in a real browser:
 *
 *   node scripts/ui-checks.ts <demo-url> [--update]
 *
 * scripts/demo.ts runs it with --ui-checks on the server it starts for a render-audit shard
 * (CI shard 2), so it adds well under a minute to CI. Each check drives the app the way a
 * person would (keys, clicks) and looks for what should happen. The visual checks hold a few
 * steady views to the pictures in scripts/ui-baselines/, pixel by pixel within a small
 * tolerance (fonts draw a little differently from machine to machine); --update writes the
 * pictures afresh from this server, to be committed after looking at them. A missing picture
 * is written, not failed. Exits 1 on any failure. Demo only: it refuses any other server.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINES = path.join(ROOT, "scripts", "ui-baselines");
/** How much may differ before a view fails: a pixel differs when a channel moves by more than DELTA; the share of such pixels may be up to SHARE. */
export const DELTA = 48;
export const SHARE = 0.02;

/** Steady views: no clock, no animation, the demo's fixed data. */
export const VIEWS: { name: string; at: string; theme: "terminal" | "dark" | "light" }[] = [
  { name: "help-terminal", at: "/help", theme: "terminal" },
  { name: "settings-light", at: "/settings?tab=general", theme: "light" },
  { name: "net-worth-dark", at: "/net-worth", theme: "dark" },
];

/** fresh: a browser that has never seen the app (the first-run tour); the others start with it seen. */
type Check = { name: string; fresh?: boolean; run: (page: Page) => Promise<void> };

/** The command line, once the app around the page has drawn it. */
const commandLine = async (page: Page) => {
  await page.locator("header [data-command-root] input").first().waitFor({ timeout: 30_000 });
  await page.keyboard.press("Control+k");
};

const settle = (page: Page) =>
  page.waitForFunction(() => document.querySelectorAll('[data-clearance="cleared"]').length > 0 && !document.querySelector('[data-clearance="verifying"], [data-skeleton]'), null, { timeout: 60_000 });

function expect(ok: boolean, what: string) {
  if (!ok) throw new Error(what);
}

export const CHECKS: Check[] = [
  {
    name: "? shows the keys for where you are, and Esc closes them",
    run: async (page) => {
      await page.goto("/net-worth");
      await settle(page);
      await page.locator("main").focus();
      await page.keyboard.press("Shift+?");
      await page.locator('[role="dialog"]').first().waitFor({ timeout: 5_000 });
      await page.keyboard.press("Escape");
      await page.locator('[role="dialog"]').first().waitFor({ state: "detached", timeout: 5_000 });
    },
  },
  {
    name: "G then a letter jumps to a page",
    run: async (page) => {
      await page.goto("/help");
      await page.locator("main").focus();
      await page.keyboard.press("g");
      await page.keyboard.press("c");
      await page.waitForURL(/\/cash-flow/, { timeout: 15_000 });
    },
  },
  {
    name: "Ctrl K reaches the command line, and a code goes to its page",
    run: async (page) => {
      await page.goto("/help");
      await commandLine(page);
      expect(await page.evaluate(() => document.activeElement?.tagName === "INPUT"), "the command line didn't take the keys");
      await page.keyboard.type("NW");
      await page.keyboard.press("Enter");
      await page.waitForURL(/\/net-worth/, { timeout: 15_000 });
    },
  },
  {
    name: "SPLIT puts a page beside this one",
    run: async (page) => {
      await page.goto("/net-worth");
      await commandLine(page);
      await page.keyboard.type("split tax");
      await page.waitForTimeout(300);
      await page.keyboard.press("Enter");
      await page.locator('section[aria-label^="Beside"] iframe').waitFor({ timeout: 10_000 });
      await page.keyboard.press("Control+k");
      await page.keyboard.type("split");
      await page.waitForTimeout(300);
      await page.keyboard.press("Enter");
      await page.locator('section[aria-label^="Beside"]').waitFor({ state: "detached", timeout: 10_000 });
    },
  },
  {
    name: "A Dashboard panel says what it is (I), and the arrows move between panels",
    run: async (page) => {
      await page.goto("/");
      await settle(page);
      await page.locator("[data-panel]").first().focus();
      await page.keyboard.press("ArrowRight");
      const second = await page.evaluate(() => document.activeElement === document.querySelectorAll("[data-panel]")[1]);
      expect(second, "ArrowRight didn't move to the next panel");
      await page.keyboard.press("i");
      await page.locator('[data-panel] [role="dialog"]').first().waitFor({ timeout: 5_000 });
      await page.keyboard.press("Escape");
    },
  },
  {
    name: "A figure opens its proof, which copies as text and pins",
    run: async (page) => {
      await page.goto("/net-worth");
      await settle(page);
      await page.locator('main [data-clearance="cleared"]').first().click();
      const drawer = page.locator(".pf-drawer");
      await drawer.locator("[data-proof-actions]").waitFor({ timeout: 20_000 });
      await drawer.getByRole("button", { name: "Pin" }).click();
      expect((await drawer.getByRole("button", { name: "Unpin" }).count()) === 1, "Pin didn't pin");
      await drawer.getByRole("button", { name: "Unpin" }).click();
      await page.keyboard.press("Escape");
      await drawer.waitFor({ state: "detached", timeout: 5_000 });
    },
  },
  {
    name: "The demo offers its tour once, and Esc ends it",
    fresh: true,
    run: async (page) => {
      await page.goto("/help");
      await page.locator('[role="dialog"][aria-label^="Tour"]').waitFor({ timeout: 30_000 });
      await page.keyboard.press("Escape");
      await page.locator('[role="dialog"][aria-label^="Tour"]').waitFor({ state: "detached", timeout: 5_000 });
      await page.reload();
      await page.waitForTimeout(2_000);
      expect((await page.locator('[role="dialog"][aria-label^="Tour"]').count()) === 0, "the tour came back after it was ended");
    },
  },
];

/**
 * A picture of the page once it has stopped changing: its fonts loaded, then two pictures in
 * a row the same. A fixed wait alone took /help mid-draw on a slow runner (5% off, CI 2026-11-26).
 */
async function steadyShot(page: Page): Promise<Buffer> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  let last = await page.screenshot();
  for (let k = 0; k < 20; k++) {
    await page.waitForTimeout(250);
    const now = await page.screenshot();
    if (now.equals(last)) return now;
    last = now;
  }
  return last;
}

/** The share of pixels that differ between two pictures of the same size, compared in the page (no image library needed). */
async function differs(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(
    async ({ a, b, delta }) => {
      const load = async (b64: string) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, c.width, c.height);
      };
      const [x, y] = await Promise.all([load(a), load(b)]);
      if (x.width !== y.width || x.height !== y.height) return 1;
      let off = 0;
      for (let i = 0; i < x.data.length; i += 4) if (Math.abs(x.data[i]! - y.data[i]!) > delta || Math.abs(x.data[i + 1]! - y.data[i + 1]!) > delta || Math.abs(x.data[i + 2]! - y.data[i + 2]!) > delta) off++;
      return off / (x.width * x.height);
    },
    { a: a.toString("base64"), b: b.toString("base64"), delta: DELTA },
  );
}

async function launch(): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  const exe = process.env.RENDER_AUDIT_BROWSER?.trim();
  if (exe) return chromium.launch({ executablePath: exe, headless: true });
  return chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ channel: "msedge", headless: true }));
}

export async function uiChecks(base: string, opts: { update?: boolean } = {}): Promise<string[]> {
  const who = (await fetch(`${base}/api/app-password`).then((r) => r.json(), () => null)) as { demo?: boolean } | null;
  if (!who?.demo) throw new Error(`${base} isn't the demo: the UI checks only drive the made-up household.`);
  const failures: string[] = [];
  const browser = await launch();
  try {
    for (const c of CHECKS) {
      const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      if (!c.fresh) await ctx.addInitScript(() => localStorage.setItem("pf-tour-done", "1"));
      const page = await ctx.newPage();
      const t0 = Date.now();
      try {
        await c.run(page);
        console.log(`ok    ${c.name} (${Date.now() - t0} ms)`);
      } catch (e) {
        failures.push(`${c.name}: ${(e as Error).message.split("\n")[0]}`);
        console.log(`FAIL  ${c.name}: ${(e as Error).message.split("\n")[0]}`);
      }
      await ctx.close();
    }
    mkdirSync(BASELINES, { recursive: true });
    for (const v of VIEWS) {
      const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      await ctx.addInitScript((theme) => {
        localStorage.setItem("pf-theme", theme);
        localStorage.setItem("pf-tour-done", "1");
      }, v.theme);
      const page = await ctx.newPage();
      await page.goto(v.at);
      if (v.at !== "/help" && !v.at.startsWith("/settings")) await settle(page);
      await page.waitForTimeout(800);
      const shot = await steadyShot(page);
      const file = path.join(BASELINES, `${v.name}.png`);
      if (opts.update || !existsSync(file)) {
        writeFileSync(file, shot);
        console.log(`wrote ${path.relative(ROOT, file)}`);
      } else {
        const share = await differs(page, readFileSync(file), shot);
        const line = `${v.name}: ${(share * 100).toFixed(2)}% of pixels differ (up to ${SHARE * 100}% allowed)`;
        if (share > SHARE) failures.push(line);
        console.log(`${share > SHARE ? "FAIL " : "ok   "} ${line}`);
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  return failures;
}

if (process.argv[1]?.endsWith("ui-checks.ts")) {
  const base = process.argv[2]?.replace(/\/$/, "");
  if (!base || base.startsWith("--")) {
    console.error("Usage: node scripts/ui-checks.ts <demo-url> [--update]");
    process.exit(2);
  }
  uiChecks(base, { update: process.argv.includes("--update") }).then(
    (f) => {
      if (f.length) {
        console.error(`${f.length} UI check(s) failed:\n  ${f.join("\n  ")}`);
        process.exit(1);
      }
      console.log("Every UI check passed.");
    },
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
