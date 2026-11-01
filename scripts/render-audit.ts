/**
 * The render audit (SSOT F6): opens every page of a running app in a headless browser,
 * clicks through every tab, and holds what each one draws to the proof sweep of the same
 * data (lib/book/proof/renderAudit.ts): every figure drawn is one the sweep cleared, at the
 * value the page draws; no money or rate reaches a page outside a figure (pages still in
 * BYPASS_PENDING are listed, not failed); and it lists the cleared figures no view drew.
 * Prints every problem; exits 1 on any. About a minute and a half on the demo.
 *
 * Usage (on the demo, as CI runs it: npm run demo -- --render-audit):
 *   node scripts/render-audit.ts <base-url>
 *
 * Drives the Chrome or Edge already installed (playwright-core downloads no browser);
 * RENDER_AUDIT_BROWSER names another executable. On the owner's own data it runs through
 * scripts/render-audit-real.ts (npm run audit:real), which sets RENDER_AUDIT_UNLOCK and
 * RENDER_AUDIT_REDACT.
 */
import { readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { auditRender, BYPASS_PENDING, drawerStrays, figureFamily, pageOf, UNDRAWN_PENDING, type DrawnView, type RenderProblem, type SweepVerdicts } from "../src/lib/book/proof/renderAudit.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!base) {
  console.error("Usage: node scripts/render-audit.ts <base-url>");
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
/** Drill-downs opened per view (RENDER_AUDIT_DRILLS caps it on a big Book), and proof drawers held to their proofs per view. */
const DRILLS_PER_VIEW = Number(process.env.RENDER_AUDIT_DRILLS ?? 80);
const DRAWERS_PER_VIEW = 4;
/** The whole audit's time budget (F6e): the owner wants proof checks in minutes, so a slower run fails. RENDER_AUDIT_BUDGET_MS overrides (0: none). */
const BUDGET_MS = Number(process.env.RENDER_AUDIT_BUDGET_MS ?? 240_000);
/** RENDER_AUDIT_UNLOCK=1: the caller had the server check the lock-screen password (render-audit-real.ts), so each tab starts unlocked, as the lock screen leaves it. */
const UNLOCK = process.env.RENDER_AUDIT_UNLOCK === "1";
/** RENDER_AUDIT_REDACT=1: real data, so the console says problem kinds, pages and counts, never a drawn value, key or name. */
const REDACT = process.env.RENDER_AUDIT_REDACT === "1";
/** The pages with the most views, started first so they don't finish last. */
const SLOW = ["/cash-flow", "/taxes", "/net-worth", "/car", "/hsa", "/statements", "/fire", "/home-budget"];

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
type UnitRun = Unit & { views: DrawnView[]; ms: number; skipped?: string };
const unitName = (u: Unit) => (u.tab ? `${u.route} › ${u.tab.label}` : u.route);

/** The proof drawers opened so far, by family (report › page › figure): one of each is enough to hold the drawer's drawing. */
const drawerFamilies = new Set<string>();
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
 * own first tab also finds the others (kit Tabs: data-tab-id) and queues them, so a page with
 * many tabs runs on several workers at once.
 */
async function auditUnit(browser: Browser, unit: Unit, all: readonly string[], queue: Unit[]): Promise<UnitRun> {
  const t0 = Date.now();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce" });
  // The demo's day in the browser too (scripts/demo.ts DEMO_TODAY): the year a page opens on, its default range.
  if (TODAY) await context.clock.setFixedTime(new Date(`${TODAY}T12:00:00`));
  // The flag the lock screen sets once its password is accepted (components/shell/LockScreen.tsx).
  if (UNLOCK) await context.addInitScript(() => sessionStorage.setItem("pf-unlocked", "1"));
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
  const views: DrawnView[] = [];
  // A view drawn before (the same figures, the same strays): nothing new to drill into or explore from it.
  const seen = new Set<string>();

  const draw = async (name: string): Promise<DrawnView & { repeat: boolean }> => {
    const unsettled = await settle(page);
    const s = await page.evaluate(collect);
    const v: DrawnView = { view: name, figures: s.figures, strays: s.strays, chart: s.chart, errors: [...errors.splice(0), ...(unsettled ? [unsettled] : [])] };
    const sig = JSON.stringify([s.figures.map((f) => [f.key, f.clearance, f.text]), s.strays]);
    const repeat = seen.has(sig) && !v.errors.length;
    seen.add(sig);
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
  try {
    const r = await page.goto(`${base}${unit.route}${unit.tab ? `?tab=${encodeURIComponent(unit.tab.id)}` : ""}`, { waitUntil: "load" }).catch((e: Error) => (errors.push(`Couldn't open: ${e.message.split("\n")[0]}`), null));
    if (r && !r.ok()) errors.push(`Answered ${r.status()}`);
    // An old address that redirects to a page audited in its own right is that page.
    const landed = new URL(page.url()).pathname;
    if (!unit.tab && landed !== unit.route && all.includes(landed)) return { ...unit, views: [], ms: Date.now() - t0, skipped: `redirects to ${landed}` };
    await visit(name);
    if (!unit.tab) {
      // The page's other tabs, each a unit of its own for the next free worker.
      const tabs = page.locator('[role="tablist"] [role="tab"][data-tab-id]');
      for (let i = 0; i < (await tabs.count()); i++) {
        if ((await tabs.nth(i).getAttribute("aria-selected")) === "true") continue;
        const id = (await tabs.nth(i).getAttribute("data-tab-id"))!;
        queue.push({ route: unit.route, tab: { id, label: (await tabs.nth(i).innerText()).replace(/\d+$/, "").trim() } });
      }
    }
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
  return { ...unit, views, ms: Date.now() - t0 };
}

const started = Date.now();
// The sweep the pages clear from, run to the end first: the server's own report. Asked
// again while it runs (202), as pages do: one request held open past fetch's 5-minute
// header timeout would fail on a large Book's cold start.
let res = await fetch(`${base}/api/proof/sweep`);
while (res.status === 202) {
  await new Promise((r) => setTimeout(r, 1000));
  res = await fetch(`${base}/api/proof/sweep`);
}
if (!res.ok) {
  console.error(`The server's proof sweep answered ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const report = (await res.json()) as SweepVerdicts & { stamp: string; figures: number; problemCount: number };
console.log(`Sweep${REDACT ? "" : ` of ${report.stamp}`}:${report.figures} figures, ${Object.keys(report.cleared).length} cleared, ${report.problemCount} problem(s) (${Date.now() - started}ms)`);

const all = routes();
const todo = ONLY ? all.filter((r) => ONLY.includes(r)) : all;
if (!todo.length) {
  console.error(`No page to audit${ONLY ? ` among ${ONLY.join(", ")} (pages: ${all.join(" ")})` : ""}.`);
  process.exit(2);
}
const browser = await launch();
const runs: UnitRun[] = [];
try {
  // A few units at once; the busiest pages first, so their tabs fan out early.
  const queue: Unit[] = [...todo].sort((a, b) => (SLOW.indexOf(b) + 1 || 0) - (SLOW.indexOf(a) + 1 || 0)).map((route) => ({ route, tab: null }));
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
        const run = await auditUnit(browser, unit, all, queue).finally(() => busy--);
        runs.push(run);
        console.log(`${unitName(unit).padEnd(40)} ${run.skipped ?? `${String(run.views.length).padStart(4)} view(s)`} ${String(run.ms).padStart(7)}ms`);
      }
    }),
  );
} finally {
  await browser.close();
}
// In page order, each page's own tab first: the report reads the same whatever finished first.
const views = todo.flatMap((route) => runs.filter((r) => r.route === route).sort((a, b) => (a.tab ? 1 : 0) - (b.tab ? 1 : 0) || unitName(a).localeCompare(unitName(b))).flatMap((r) => r.views));

const audit = auditRender(views, report, BYPASS_PENDING, { partial: !!ONLY });
// RENDER_AUDIT_JSON=<file>: everything drawn and every problem, for working through them.
if (process.env.RENDER_AUDIT_JSON) writeFileSync(process.env.RENDER_AUDIT_JSON, JSON.stringify({ views, audit }, null, 1));
const figures = views.reduce((n, v) => n + v.figures.length, 0);
const opened = views.reduce((n, v) => n + (v.drawers?.length ?? 0), 0);
console.log(`\nRendered ${views.length} views: ${figures} figures drawn, ${audit.drawn} of the sweep's ${audit.cleared} cleared figures among them; ${opened} proof drawers held to their proofs (${Date.now() - started}ms).`);
const count = (xs: string[]) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
const byKind = new Map<string, typeof audit.problems>();
for (const p of audit.problems) byKind.set(p.kind, [...(byKind.get(p.kind) ?? []), p]);
for (const [kind, ps] of byKind) {
  console.log(`\n[${kind}] ${ps.length}`);
  if (REDACT) {
    for (const [page, n] of count(ps.map((p) => pageOf(p.view)))) console.log(`   ${page.padEnd(16)} ${String(n).padStart(5)}`);
    continue;
  }
  for (const p of ps.slice(0, LISTED)) console.log(`   ${p.view}: ${p.detail}${p.key ? `\n      ${p.key}` : ""}`);
  if (ps.length > LISTED) console.log(`   …and ${ps.length - LISTED} more`);
}
// Debts said out loud, not failed yet: bypasses on pages a later stage holds, and cleared figures no view drew.
if (audit.pending.length) {
  console.log(`\n[PENDING] ${audit.pending.length} bypass(es) on pages a later stage holds (BYPASS_PENDING, lib/book/proof/renderAudit.ts):`);
  for (const [page, n] of count(audit.pending.map((p) => pageOf(p.view)))) console.log(`   ${page.padEnd(16)} ${String(n).padStart(5)}  ${BYPASS_PENDING[page]}`);
}
const undrawn = audit.missing.filter((k) => UNDRAWN_PENDING[figureFamily(k)]);
if (undrawn.length) {
  console.log(`\n[NOT DRAWN] ${undrawn.length} cleared figure(s) of families still pending (UNDRAWN_PENDING, lib/book/proof/renderAudit.ts):`);
  for (const [f, n] of count(undrawn.map(figureFamily)).slice(0, LISTED)) console.log(`   ${f.padEnd(44)} ${String(n).padStart(6)}  ${UNDRAWN_PENDING[f]}`);
}
const took = Date.now() - started;
if (BUDGET_MS && took > BUDGET_MS) {
  const p: RenderProblem = { kind: "RENDER_ERROR", view: "(the whole audit)", detail: `Took ${Math.round(took / 1000)} s, over its ${Math.round(BUDGET_MS / 1000)} s budget: find the slow view (RENDER_AUDIT_JSON) before raising it.` };
  audit.problems.push(p);
  console.log(`
[RENDER_ERROR] ${p.detail}`);
}
const bad = audit.problems.length;
console.log(`\n${bad ? `${bad} render problem(s).` : "Every drawn figure is the one its proof cleared, at the value drawn; no money reaches a held page outside a figure."}`);
process.exit(bad ? 1 : 0);
