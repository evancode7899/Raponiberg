/**
 * The render audit (SSOT F6): opens every page of a running app in a headless browser,
 * clicks through every tab, and holds what each one draws to the proof sweep of the same
 * data (lib/book/proof/renderAudit.ts): every figure drawn is one the sweep cleared, at the
 * value the page draws; no money or rate reaches a page outside a figure (pages still in
 * BYPASS_PENDING are listed, not failed); and it lists the cleared figures no view drew.
 * Prints every problem; exits 1 on any.
 *
 * Usage (on the demo: npm run demo -- --render-audit):
 *   node scripts/render-audit.ts <base-url>
 * In shards, as CI runs it (RENDER_AUDIT_SHARD=i/N with RENDER_AUDIT_OUT=<file> on each, then):
 *   node scripts/render-audit.ts --merge <file>…
 *
 * Drives the Chrome or Edge already installed (playwright-core downloads no browser);
 * RENDER_AUDIT_BROWSER names another executable.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright-core";
import { auditRender, BYPASS_PENDING, drawerStrays, figureFamily, pageOf, UNDRAWN_PENDING, type DrawnView, type RenderProblem, type SweepVerdicts } from "../src/lib/book/proof/renderAudit.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** --merge <shard files…>: no browser, just the whole run's audit from what each shard drew. */
const MERGE = process.argv[2] === "--merge" ? process.argv.slice(3) : null;
const base = MERGE ? "" : (process.argv[2] ?? "").replace(/\/$/, "");
if (!base && !MERGE?.length) {
  console.error("Usage: node scripts/render-audit.ts <base-url>\n       node scripts/render-audit.ts --merge <shard.json>…");
  process.exit(2);
}

/** How long a view may take to settle (its data loaded, no figure still verifying). */
const SETTLE_MS = 30_000;
/** How many problems of each kind to list; the counts are always whole. */
const LISTED = Number(process.env.RENDER_AUDIT_LIST ?? 40);
/** Pages audited at once. */
const WORKERS = Math.max(1, Number(process.env.RENDER_AUDIT_WORKERS ?? 8));
/** RENDER_AUDIT_ONLY=/cash-flow,/taxes: just those pages (a partial run: it can't tell what no page draws). */
const ONLY = process.env.RENDER_AUDIT_ONLY?.split(",").map((s) => s.trim()).filter(Boolean);
/** The day the server pins (APP_TODAY, set by scripts/demo.ts): the browser's clock reads it too. */
const TODAY = process.env.APP_TODAY?.trim();
/** Drill-downs opened per view, and proof drawers held to their proofs per view. */
const DRILLS_PER_VIEW = 80;
const DRAWERS_PER_VIEW = 4;
/** The audit's time budget (F6e), a shard's own when sharded: the owner wants proof checks in minutes, so a slower run fails. RENDER_AUDIT_BUDGET_MS overrides (0: none). */
const BUDGET_MS = Number(process.env.RENDER_AUDIT_BUDGET_MS ?? 240_000);
/**
 * RENDER_AUDIT_SHARD=i/N: just the i-th of N shares of the units (CI runs N at once, then
 * --merge). Shares are dealt from the units' last costs, so each shard knows its own without
 * asking the others; a tab no costs file lists runs on the shard that ran its page.
 */
const SHARD = (() => {
  const s = process.env.RENDER_AUDIT_SHARD?.trim();
  if (!s) return null;
  const m = /^(\d+)\/(\d+)$/.exec(s);
  if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) {
    console.error(`RENDER_AUDIT_SHARD=${s}: expected i/N with 1 ≤ i ≤ N.`);
    process.exit(2);
  }
  return { i: Number(m[1]), n: Number(m[2]) };
})();
/** RENDER_AUDIT_OUT=<file>: every unit this run drew and the sweep it held them to, for --merge. */
const OUT = process.env.RENDER_AUDIT_OUT?.trim();
/**
 * What each unit took last time (scripts/render-audit-costs.json): the busiest start first,
 * and shards are dealt from them. Stale costs only slow a run down, never skip a unit: a tab
 * no costs file lists is still found and run. RENDER_AUDIT_COSTS=<file> writes this run's.
 */
const COSTS_FILE = path.join(ROOT, "scripts", "render-audit-costs.json");
type Cost = Unit & { ms: number };

/** Every page the app has: each folder under src/app with a page.tsx, bar the API and dynamic segments. */
function routes(): string[] {
  const out: string[] = [];
  const walk = (dir: string, url: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (!statSync(full).isDirectory()) {
        if (name === "page.tsx") out.push(url || "/");
        continue;
      }
      if (name === "api" || name.startsWith("[") || name.startsWith("_") || name.startsWith("(")) continue;
      walk(full, `${url}/${name}`);
    }
  };
  walk(path.join(ROOT, "src", "app"), "");
  return out;
}

async function launch(): Promise<Browser> {
  // Loaded only to render: --merge runs without the packages installed.
  const { chromium } = await import("playwright-core");
  const exe = process.env.RENDER_AUDIT_BROWSER?.trim();
  if (exe) return chromium.launch({ executablePath: exe, headless: true });
  const tried: string[] = [];
  for (const channel of ["chrome", "msedge"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (e) {
      tried.push(`${channel}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error(`No browser to drive (set RENDER_AUDIT_BROWSER to Chrome or Edge):\n  ${tried.join("\n  ")}`);
}

/** What the page draws now: every figure's data attributes and text, and money drawn outside any figure. Runs in the browser. */
function collect() {
  const visible = (el: Element) => (el as HTMLElement).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true;
  const figures = [...document.querySelectorAll<HTMLElement>("[data-proof-key]")].filter(visible).map((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll("[data-proof-mark]").forEach((m) => m.remove());
    const kind = el.dataset.shownKind ?? "";
    return {
      key: el.dataset.proofKey ?? "",
      shown: el.dataset.shown ?? "",
      shownKind: (kind === "cents" || kind === "ratio" || kind === "text" ? kind : "") as "" | "cents" | "ratio" | "text",
      perMonths: el.dataset.perMonths ? Number(el.dataset.perMonths) : null,
      clearance: el.dataset.clearance ?? "",
      text: (c.textContent ?? "").trim(),
      drawn: el.dataset.drawn,
    };
  });
  // Money or a rate in a text node that no figure holds. Form fields, a chart axis's tick
  // labels (a scale, not data) and text marked data-not-figure with a reason (kit NotFigure:
  // a rule's threshold, an input you typed) aren't figures. Words that open a proof (data-drawn="words") are held in renderAudit.ts.
  const strays = new Set<string>();
  const chart = new Set<string>();
  const re = /\$\s?\d|\d(?:[.,]\d+)*\s?%/;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent ?? "";
    if (!re.test(t)) continue;
    const el = n.parentElement;
    // An open proof drawer's numbers are held to its proof's JSON (drawerTokens), not to this view; a chart tooltip is where the mouse last was.
    if (!el || el.closest('.pf-drawer:has([data-proof-clearance]), .recharts-tooltip-wrapper, [data-proof-key], [data-not-figure]:not([data-not-figure=""]), .recharts-cartesian-axis-tick-value, #recharts_measurement_span, input, textarea, select, option, script, style, noscript') || !visible(el)) continue;
    const where = (el.closest("tr, li, [class*='rounded-lg'], section") ?? el).textContent?.replace(/\s+/g, " ").trim().slice(0, 90) ?? "";
    // In a chart (SVG): a label for a figure the view draws, held to it in renderAudit.ts.
    if (el.closest("svg")) chart.add(t.replace(/\s+/g, " ").trim());
    else strays.add(`${t.replace(/\s+/g, " ").trim().slice(0, 60)}" in "${where}`);
  }
  return { figures, strays: [...strays], chart: [...chart], verifying: document.querySelectorAll('[data-clearance="verifying"]').length, size: document.body.innerText.length };
}

/** Money and rates a proof drawer (the dialog the figure opened) draws. Runs in the browser. */
function drawerTokens(): string[] {
  const d = [...document.querySelectorAll('[role="dialog"]')].at(-1);
  if (!d) return [];
  const re = /[+\-−]?\(?\$\s?\d[\d,]*(?:\.\d+)?[kMB]?\)?|[+\-−]?\(?\d[\d,]*(?:\.\d+)?\s?%\)?/g;
  return [...((d as HTMLElement).innerText ?? "").matchAll(re)].map((m) => m[0]);
}

/** The page's requests still in flight, so settle() knows when a click's data has come back. */
const inflight = new WeakMap<Page, number>();

/** A cheap look at the page: what settle() waits on (figures verifying, how much is drawn). Runs in the browser. */
function glance(): string {
  const figures = document.querySelectorAll("[data-proof-key]");
  let text = 0;
  figures.forEach((f) => (text += (f.textContent ?? "").length));
  // A figure still verifying, or a spinner (kit Loading: data not loaded yet), means the view isn't drawn yet.
  const waiting = document.querySelectorAll('[data-clearance="verifying"], [role="status"] .animate-spin').length;
  return `${waiting}|${figures.length}|${text}|${document.body.textContent?.length ?? 0}|${document.querySelectorAll('[role="dialog"]').length}`;
}

/** Waits until the view's data has loaded and nothing changes: no requests in flight, no figure verifying, the same drawing twice. */
async function settle(page: Page): Promise<string | null> {
  const until = Date.now() + SETTLE_MS;
  let last = "";
  while (Date.now() < until) {
    const sig = await page.evaluate(glance);
    if (!sig.startsWith("0|") || inflight.get(page)) last = "";
    else if (sig === last) return null;
    else last = sig;
    await page.waitForTimeout(120);
  }
  return `never settled in ${SETTLE_MS / 1000}s (figures still verifying, or the page kept changing)`;
}

/** One unit of the audit (a page's tab) and what it drew, in order. */
type Unit = { route: string; tab: { id: string; label: string } | null };
/** What a unit drew; a page's own unit also lists the page's tabs (each a unit of its own). `draws` counts every look, `repeats` those that drew nothing new. */
type UnitRun = Unit & { views: DrawnView[]; ms: number; skipped?: string; tabs?: Unit[]; draws: number; repeats: number; drawers: number };
const unitName = (u: Unit) => (u.tab ? `${u.route} › ${u.tab.label}` : u.route);
/** A unit's identity across runs and shards: its page, tab id and the tab's label. */
const unitKey = (u: Unit) => JSON.stringify([u.route, u.tab?.id ?? null, u.tab?.label ?? null]);

const familyOf = (key: string) => {
  try {
    const d = JSON.parse(key) as Record<string, unknown>;
    return [d.report, d.page, d.figure ?? d.metric ?? d.line ?? d.measure ?? d.op].filter((x) => typeof x === "string").join(" › ");
  } catch {
    return key;
  }
};

/**
 * Audits one tab of one page in a browser context of its own (its own storage). The page's
 * own first tab also lists the others (kit Tabs: data-tab-id) as soon as it has loaded, and
 * hands each to `found` (queued for the next free worker unless already planned), so a page
 * with many tabs runs on several workers at once.
 */
async function auditUnit(browser: Browser, unit: Unit, all: readonly string[], found: (tab: Unit) => void): Promise<UnitRun> {
  const t0 = Date.now();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce" });
  // The demo's day in the browser too (scripts/demo.ts DEMO_TODAY): the year a page opens on, its default range.
  if (TODAY) await context.clock.setFixedTime(new Date(`${TODAY}T12:00:00`));
  // The audit only looks: any write (a saved input, a decision) is refused, so the data the sweep cleared is the data drawn.
  await context.route(/\/api\//, (r) => {
    const q = r.request();
    return q.method() === "GET" || (q.method() === "POST" && new URL(q.url()).pathname === "/api/proof") ? r.continue() : r.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  inflight.set(page, 0);
  page.on("request", () => inflight.set(page, (inflight.get(page) ?? 0) + 1));
  const done = () => inflight.set(page, Math.max(0, (inflight.get(page) ?? 1) - 1));
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`The page threw: ${e.message.split("\n")[0]}`));
  // A read the page's data came from that failed leaves the page showing an error note, not its figures: said, not drawn as an empty view.
  const read = (q: { method(): string; url(): string }) => {
    const p = new URL(q.url()).pathname;
    return p.startsWith("/api/") && (q.method() === "GET" || p === "/api/proof") ? `${q.method()} ${p}` : null;
  };
  page.on("response", (r) => {
    const what = read(r.request());
    if (what && r.status() >= 400) errors.push(`${what} answered ${r.status()}`);
  });
  page.on("requestfailed", (q) => {
    const what = read(q);
    // Aborted is the browser dropping a read the page no longer needs (it moved on), not a failure.
    if (what && q.failure()?.errorText !== "net::ERR_ABORTED") errors.push(`${what} failed: ${q.failure()?.errorText}`);
  });
  const views: DrawnView[] = [];
  // A view drawn before (the same figures, the same strays): nothing new to drill into or explore from it.
  const seen = new Set<string>();
  // The proof drawers this unit opened, by family (report › page › figure): one of each is enough to hold the
  // drawer's drawing. Per unit, not per run, so which drawers open never depends on which worker or shard got there first.
  const drawerFamilies = new Set<string>();
  const stats = { draws: 0, repeats: 0, drawers: 0 };

  const draw = async (name: string): Promise<DrawnView & { repeat: boolean }> => {
    const unsettled = await settle(page);
    const s = await page.evaluate(collect);
    const v: DrawnView = { view: name, figures: s.figures, strays: s.strays, chart: s.chart, errors: [...errors.splice(0), ...(unsettled ? [unsettled] : [])] };
    const sig = JSON.stringify([s.figures.map((f) => [f.key, f.clearance, f.text]), s.strays]);
    const repeat = seen.has(sig) && !v.errors.length;
    seen.add(sig);
    stats.draws++;
    if (repeat) stats.repeats++;
    if (!repeat) views.push(v);
    // The view itself (drawers() adds to it), marked when it repeats one drawn before.
    return Object.assign(v, { repeat });
  };
  const closeDialog = async () => {
    for (let k = 0; k < 4 && (await page.locator('[role="dialog"]').count()); k++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(50);
    }
    await page.locator('[role="dialog"]').first().waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  };

  /** Opens a few figures' proof drawers (F6e) and holds what each draws to the proof the server answered. */
  const drawers = async (v: DrawnView) => {
    const picks = v.figures.filter((f) => f.clearance === "cleared" && !drawerFamilies.has(familyOf(f.key)));
    for (const f of picks.slice(0, DRAWERS_PER_VIEW)) {
      if (drawerFamilies.has(familyOf(f.key))) continue;
      drawerFamilies.add(familyOf(f.key));
      const el = page.locator(`[data-clearance="cleared"][data-proof-key="${f.key.replace(/["\\]/g, "\\$&")}"]`).first();
      if (!(await el.isVisible().catch(() => false))) continue;
      stats.drawers++;
      // Caught as it's made: a click that throws mustn't leave it to reject unheard.
      const answer = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/proof" && r.request().method() === "POST", { timeout: 15_000 }).catch(() => null);
      await el.click();
      const res = await answer;
      if (!res) {
        v.drawers = [...(v.drawers ?? []), { key: f.key, strays: ["(the drawer asked for no proof)"] }];
        await closeDialog();
        continue;
      }
      // A response whose body is already gone (the page moved on) leaves this drawer unchecked, not the page broken.
      const proof = (await res.json().catch(() => null)) as unknown;
      if (proof == null) {
        await closeDialog();
        continue;
      }
      await settle(page);
      v.drawers = [...(v.drawers ?? []), { key: f.key, strays: drawerStrays(await page.evaluate(drawerTokens), proof, f.perMonths) }];
      await closeDialog();
    }
  };

  /**
   * What each drill-down on the view opens (data-audit-drill: a month, a category, a
   * merchant) as a view of its own. One that opens a drawer is closed again; one that
   * changes the page in place (a year month by month) is stepped through with its
   * data-audit-step buttons, each step drawn, and left with its data-audit-back button.
   */
  const drills = async (name: string) => {
    const openers = page.locator('[data-audit-drill]:not([role="dialog"] *)');
    const n = Math.min(await openers.count(), DRILLS_PER_VIEW);
    for (let i = 0; i < n; i++) {
      const o = openers.nth(i);
      if (!(await o.isVisible().catch(() => false))) continue;
      const label = ((await o.getAttribute("data-audit-drill")) || (await o.innerText()).slice(0, 30)).replace(/\s+/g, " ").trim();
      await o.click();
      const back = page.locator("[data-audit-back]").first();
      // A drawer, a view in place with a way back, or a row that opens where it is: whichever came, once it settles.
      await draw(`${name} ▸ ${label}`);
      if (await back.isVisible().catch(() => false)) {
        const steps = page.locator("[data-audit-step]");
        for (let j = 0; j < (await steps.count()); j++)
          for (let k = 1; k <= 60 && (await steps.nth(j).isEnabled().catch(() => false)); k++) {
            await steps.nth(j).click();
            await draw(`${name} ▸ ${label} ▸ ${(await steps.nth(j).getAttribute("aria-label")) ?? "step"} ${k}`);
          }
        await back.click();
        await settle(page);
      } else if (await page.locator('[role="dialog"]').count()) await closeDialog();
    }
  };

  /**
   * Every option of each control the page marks as a view (data-audit-view), and with each
   * one, every option of the controls after it (a year, then its basis): every pair, so a
   * column only a year and a basis together show is drawn too. Drill-downs open on each
   * single change, not on every pair. Options the control names in data-audit-view are left
   * alone (it says why in data-audit-skip-why).
   */
  const explore = async (name: string, from = 0, depth = 0) => {
    const controls = page.locator('[data-audit-view]:not([role="dialog"] *)');
    const count = await controls.count();
    for (let i = from; i < count; i++) {
      const c = controls.nth(i);
      if (!(await c.isVisible().catch(() => false))) continue;
      const label = (await c.getAttribute("aria-label")) || `view ${i + 1}`;
      const skip = new Set(((await c.getAttribute("data-audit-view")) ?? "").split(",").filter(Boolean));
      const show = async (opt: string) => {
        const at = `${name} · ${label}=${opt}`;
        const v = await draw(at);
        if (v.repeat) return;
        await drawers(v);
        if (depth === 0) {
          await drills(at);
          await explore(at, i + 1, 1);
        }
      };
      if ((await c.evaluate((e) => e.tagName)) === "SELECT") {
        const was = await c.inputValue();
        for (const value of await c.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))) {
          if (value === was || skip.has(value)) continue;
          await c.selectOption(value);
          await show(value);
        }
        await c.selectOption(was);
      } else {
        const radios = c.locator('[role="radio"]');
        const n = await radios.count();
        let on = -1;
        for (let j = 0; j < n; j++) if ((await radios.nth(j).getAttribute("aria-checked")) === "true") on = j;
        for (let j = 0; j < n; j++) {
          if (j === on || skip.has((await radios.nth(j).getAttribute("data-value")) ?? "")) continue;
          await radios.nth(j).click();
          await show((await radios.nth(j).innerText()).trim());
        }
        if (on >= 0) await radios.nth(on).click();
      }
      await settle(page);
    }
  };

  const visit = async (name: string) => {
    // "Show more" (data-audit-more) until there is no more: every row the page can list is drawn.
    const more = page.locator('[data-audit-more]:not([role="dialog"] *)').first();
    for (let k = 1; k <= 10 && (await more.isVisible().catch(() => false)); k++) {
      await draw(`${name} (page ${k})`);
      await more.click();
    }
    const v = await draw(name);
    await drawers(v);
    await drills(name);
    await explore(name);
  };

  const name = unitName(unit);
  const tabs: Unit[] = [];
  try {
    const r = await page.goto(`${base}${unit.route}${unit.tab ? `?tab=${encodeURIComponent(unit.tab.id)}` : ""}`, { waitUntil: "load" }).catch((e: Error) => (errors.push(`Couldn't open: ${e.message.split("\n")[0]}`), null));
    if (r && !r.ok()) errors.push(`Answered ${r.status()}`);
    // Settled first: a server redirect() lands in the browser after "load".
    await settle(page);
    // A page that draws nothing yet may only be between hydrating and asking for its data on a busy machine: one more look.
    const first = await page.evaluate(collect);
    if (!first.figures.length && !first.strays.length) {
      await page.waitForTimeout(1000);
      await settle(page);
    }
    // An old address that redirects to a page audited in its own right is that page.
    const landed = new URL(page.url()).pathname;
    if (!unit.tab && landed !== unit.route && all.includes(landed)) return { ...unit, views: [], ms: Date.now() - t0, skipped: `redirects to ${landed}`, ...stats };
    if (!unit.tab) {
      // The page's other tabs, listed as soon as the page has drawn its tab strip (not after this tab's own
      // views and drills), each a unit of its own for the next free worker.
      const strip = page.locator('[role="tablist"] [role="tab"][data-tab-id]');
      for (let i = 0; i < (await strip.count()); i++) {
        if ((await strip.nth(i).getAttribute("aria-selected")) === "true") continue;
        const id = (await strip.nth(i).getAttribute("data-tab-id"))!;
        const tab = { route: unit.route, tab: { id, label: (await strip.nth(i).innerText()).replace(/\d+$/, "").trim() } };
        tabs.push(tab);
        found(tab);
      }
    }
    await visit(name);
    // Tabs of the page's own (one per car, one per policy): each drawn as a view of this unit.
    const own = page.locator('[role="tablist"] [role="tab"]:not([data-tab-id])');
    for (let i = 0; i < (await own.count()); i++) {
      if ((await own.nth(i).getAttribute("aria-selected")) === "true") continue;
      const label = (await own.nth(i).innerText()).trim();
      await own.nth(i).click();
      await visit(`${name} ▸ ${label}`);
    }
  } catch (e) {
    views.push({ view: name, figures: [], strays: [], errors: [`The audit couldn't finish the page: ${(e as Error).message.split("\n")[0]}`] });
  } finally {
    await context.close();
  }
  return { ...unit, views, ms: Date.now() - t0, ...(unit.tab ? {} : { tabs }), ...stats };
}

type Report = SweepVerdicts & { stamp: string; figures: number; problemCount: number };
/** What a run, or one shard of it, drew: every unit and the sweep they were held to (RENDER_AUDIT_OUT, for --merge). */
type Drawn = { shard: string | null; only: string[] | null; report: Report; runs: UnitRun[]; ms: number };

/** The units to run, busiest first: every page, and every tab of them the costs file lists. */
function plan(pages: readonly string[]): Cost[] {
  let costs: Cost[] = [];
  try {
    costs = JSON.parse(readFileSync(COSTS_FILE, "utf8")) as Cost[];
  } catch {
    /* no costs yet: every unit costs the same, and tabs are found as their pages load */
  }
  const known = new Map(costs.map((c) => [unitKey(c), c.ms]));
  const sorted = costs.map((c) => c.ms).sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1] ?? 0;
  const units: Unit[] = [...pages.map((route) => ({ route, tab: null })), ...costs.filter((c) => c.tab && pages.includes(c.route)).map(({ route, tab }) => ({ route, tab }))];
  return units.map((u) => ({ ...u, ms: known.get(unitKey(u)) ?? median })).sort((a, b) => b.ms - a.ms || unitKey(a).localeCompare(unitKey(b)));
}

/** Deals the planned units to n shards, busiest first, each to the least loaded so far (a tie to the first): the same deal on every shard. */
function deal(units: readonly Cost[], n: number): Cost[][] {
  const shards = Array.from({ length: n }, () => ({ ms: 0, units: [] as Cost[] }));
  for (const u of units) {
    const s = shards.reduce((a, b) => (b.ms < a.ms ? b : a));
    s.units.push(u);
    s.ms += u.ms;
  }
  return shards.map((s) => s.units);
}

/** Renders this run's units (all of them, or this shard's) on a few workers at once. */
async function run(): Promise<Drawn> {
  const started = Date.now();
  // The sweep the pages clear from, run to the end first: the server's own report.
  const res = await fetch(`${base}/api/proof/sweep?wait=1`);
  if (!res.ok) {
    console.error(`The server's proof sweep answered ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const report = (await res.json()) as Report;
  console.log(`Sweep of ${report.stamp}: ${report.figures} figures, ${Object.keys(report.cleared).length} cleared, ${report.problemCount} problem(s) (${Date.now() - started}ms)`);

  const all = routes();
  const todo = ONLY ? all.filter((r) => ONLY.includes(r)) : all;
  if (!todo.length) {
    console.error(`No page to audit${ONLY ? ` among ${ONLY.join(", ")} (pages: ${all.join(" ")})` : ""}.`);
    process.exit(2);
  }
  const planned = plan(todo);
  const mine = SHARD ? deal(planned, SHARD.n)[SHARD.i - 1]! : planned;
  if (SHARD) console.log(`Shard ${SHARD.i}/${SHARD.n}: ${mine.length} of ${planned.length} unit(s), about ${Math.round(mine.reduce((n, u) => n + u.ms, 0) / 1000)} s of work by the last costs.`);
  // Busiest first, so the long units don't finish last; a tab no plan lists joins the queue when its page finds it.
  const queue: Unit[] = mine.map(({ route, tab }) => ({ route, tab }));
  const queued = new Set(planned.map(unitKey));
  const found = (tab: Unit) => {
    if (queued.has(unitKey(tab))) return;
    queued.add(unitKey(tab));
    queue.push(tab);
  };
  const browser = await launch();
  const runs: UnitRun[] = [];
  try {
    let busy = 0;
    await Promise.all(
      Array.from({ length: WORKERS }, async () => {
        // A worker with nothing queued waits while others may still queue tabs.
        for (;;) {
          const unit = queue.shift();
          if (!unit) {
            if (!busy) return;
            await new Promise((r) => setTimeout(r, 100));
            continue;
          }
          busy++;
          let run: UnitRun;
          try {
            run = await auditUnit(browser, unit, all, found);
            // A unit that hit an error runs once more: one a busy machine caused doesn't change what the run reports, and a real one fails again.
            if (run.views.some((v) => v.errors.length)) {
              console.log(`${unitName(unit).padEnd(40)} retried: ${run.views.flatMap((v) => v.errors)[0]}`);
              run = await auditUnit(browser, unit, all, found);
            }
          } finally {
            busy--;
          }
          runs.push(run);
          console.log(`${unitName(unit).padEnd(40)} ${run.skipped ?? `${String(run.views.length).padStart(4)} view(s) ${String(run.draws).padStart(4)} look(s) ${String(run.drawers).padStart(3)} drawer(s)`} ${String(run.ms).padStart(7)}ms`);
        }
      }),
    );
  } finally {
    await browser.close();
  }
  return { shard: SHARD ? `${SHARD.i}/${SHARD.n}` : null, only: ONLY ?? null, report, runs, ms: Date.now() - started };
}

/** The shards' files, checked to be one whole run: every shard of the same N once, all held to the same sweep. */
function readShards(files: string[]): Drawn[] {
  const parts = files.map((f) => JSON.parse(readFileSync(f, "utf8")) as Drawn);
  const fail = (why: string) => {
    console.error(`The render audit's shards don't make one run: ${why}`);
    process.exit(1);
  };
  const n = Number(parts[0]!.shard?.split("/")[1] ?? 1);
  const got = parts.map((p) => p.shard ?? "1/1").sort();
  const want = Array.from({ length: n }, (_, i) => `${i + 1}/${n}`).sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(`expected shards ${want.join(", ")}, got ${got.join(", ")}.`);
  const sweep = (p: Drawn) => JSON.stringify([p.report.figures, p.report.cleared, p.only]);
  if (parts.some((p) => sweep(p) !== sweep(parts[0]!))) fail("they were held to different sweeps (or different pages), so they rendered different data.");
  return parts;
}

/** The audit of everything drawn (a whole run's, or one shard's on its own), printed; exits 1 on any problem. */
function finish(parts: Drawn[]) {
  const { report, only } = parts[0]!;
  const shard = parts.length === 1 ? parts[0]!.shard : null;
  // A shard, or some pages only, can't tell a pending page is clean, nor which cleared figures no page draws.
  const partial = !!only || !!shard;
  const runs = parts.flatMap((p) => p.runs);
  // A tab the costs file lists that its page no longer has (or names otherwise) drew the page's first tab again: dropped.
  const tabs = new Set(runs.flatMap((r) => r.tabs ?? []).map(unitKey));
  const roots = new Set(runs.filter((r) => !r.tab).map((r) => r.route));
  const stale = new Set(runs.filter((r) => r.tab && roots.has(r.route) && !tabs.has(unitKey(r))).map(unitKey));
  const kept = runs.filter((r) => !stale.has(unitKey(r)));
  if (stale.size) console.log(`\n${stale.size} tab(s) in scripts/render-audit-costs.json no page has now, dropped: rewrite it (RENDER_AUDIT_COSTS).`);
  // In page order, each page's own tab first: the report reads the same whatever finished first, sharded or not.
  const pages = routes();
  const views = kept
    .sort((a, b) => pages.indexOf(a.route) - pages.indexOf(b.route) || (a.tab ? 1 : 0) - (b.tab ? 1 : 0) || unitName(a).localeCompare(unitName(b)))
    .flatMap((r) => r.views);

  const audit = auditRender(views, report, BYPASS_PENDING, { partial });
  // Every tab a page lists is audited somewhere (a whole run only: a shard sees its own units).
  if (!shard) {
    const ran = new Set(kept.map(unitKey));
    for (const r of kept) for (const t of r.tabs ?? []) if (!ran.has(unitKey(t))) audit.problems.push({ kind: "RENDER_ERROR", view: unitName(t), detail: "The page lists this tab, but no shard audited it." });
  }
  // RENDER_AUDIT_JSON=<file>: everything drawn, each unit's cost and every problem, for working through them.
  if (process.env.RENDER_AUDIT_JSON) writeFileSync(process.env.RENDER_AUDIT_JSON, JSON.stringify({ units: kept.map(({ views: v, ...u }) => ({ ...u, views: v.length })), views, audit }, null, 1));
  // RENDER_AUDIT_COSTS=<file>: what each unit took, to deal the next runs' shards from (scripts/render-audit-costs.json).
  if (process.env.RENDER_AUDIT_COSTS && !partial) {
    const costs: Cost[] = kept.map((r) => ({ route: r.route, tab: r.tab, ms: Math.round(r.ms / 100) * 100 }));
    writeFileSync(process.env.RENDER_AUDIT_COSTS, `[\n${costs.sort((a, b) => unitKey(a).localeCompare(unitKey(b))).map((c) => `  ${JSON.stringify(c)}`).join(",\n")}\n]\n`);
  }
  const figures = views.reduce((n, v) => n + v.figures.length, 0);
  const opened = views.reduce((n, v) => n + (v.drawers?.length ?? 0), 0);
  const took = Math.max(...parts.map((p) => p.ms));
  console.log(`\nRendered ${views.length} views: ${figures} figures drawn, ${audit.drawn} of the sweep's ${audit.cleared} cleared figures among them; ${opened} proof drawers held to their proofs (${took}ms${parts.length > 1 ? `, the slowest of ${parts.length} shards` : ""}).`);
  const byKind = new Map<string, typeof audit.problems>();
  for (const p of audit.problems) byKind.set(p.kind, [...(byKind.get(p.kind) ?? []), p]);
  for (const [kind, ps] of byKind) {
    console.log(`\n[${kind}] ${ps.length}`);
    for (const p of ps.slice(0, LISTED)) console.log(`   ${p.view}: ${p.detail}${p.key ? `\n      ${p.key}` : ""}`);
    if (ps.length > LISTED) console.log(`   …and ${ps.length - LISTED} more`);
  }
  // Debts said out loud, not failed yet: bypasses on pages a later stage holds, and cleared figures no view drew.
  const count = (xs: string[]) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
  if (audit.pending.length) {
    console.log(`\n[PENDING] ${audit.pending.length} bypass(es) on pages a later stage holds (BYPASS_PENDING, lib/book/proof/renderAudit.ts):`);
    for (const [page, n] of count(audit.pending.map((p) => pageOf(p.view)))) console.log(`   ${page.padEnd(16)} ${String(n).padStart(5)}  ${BYPASS_PENDING[page]}`);
  }
  const undrawn = audit.missing.filter((k) => UNDRAWN_PENDING[figureFamily(k)]);
  if (undrawn.length) {
    console.log(`\n[NOT DRAWN] ${undrawn.length} cleared figure(s) of families still pending (UNDRAWN_PENDING, lib/book/proof/renderAudit.ts):`);
    for (const [f, n] of count(undrawn.map(figureFamily)).slice(0, LISTED)) console.log(`   ${f.padEnd(44)} ${String(n).padStart(6)}  ${UNDRAWN_PENDING[f]}`);
  }
  // Each shard holds itself to the budget as it runs; the merge has no clock of its own.
  if (!MERGE && BUDGET_MS && took > BUDGET_MS) {
    const p: RenderProblem = { kind: "RENDER_ERROR", view: shard ? `(shard ${shard})` : "(the whole audit)", detail: `Took ${Math.round(took / 1000)} s, over its ${Math.round(BUDGET_MS / 1000)} s budget: find the slow view (RENDER_AUDIT_JSON) before raising it.` };
    audit.problems.push(p);
    console.log(`\n[RENDER_ERROR] ${p.detail}`);
  }
  const bad = audit.problems.length;
  const whole = shard ? ` (shard ${shard}; the merge holds the whole run)` : "";
  console.log(`\n${bad ? `${bad} render problem(s)${whole}.` : `Every drawn figure is the one its proof cleared, at the value drawn; no money reaches a held page outside a figure${whole}.`}`);
  process.exit(bad ? 1 : 0);
}

if (MERGE) finish(readShards(MERGE));
else {
  const drawn = await run();
  if (OUT) writeFileSync(OUT, JSON.stringify(drawn));
  finish([drawn]);
}
