/**
 * The render audit's browser side (scripts/render-audit.ts runs it): opens one tab of one
 * page, clicks through every view it offers, and records what each draws, exactly as the
 * browser saw it. It judges nothing: render-audit.ts holds what this records to the proof
 * sweep (lib/book/proof/renderAudit.ts), fresh on every run, so a unit's recording can be
 * kept and reused while everything it was drawn from is unchanged (render-audit-cache.ts).
 * For that, this file imports nothing it runs from the app, and records every request a unit
 * made, to be asked again and compared.
 */
import type { Browser, BrowserContext, Locator, Page, Request } from "playwright-core";

/** A unit of the audit: a page's tab, or one part of one (a share of its views, when a tab is split to run on several workers). */
export type Unit = { route: string; tab: { id: string; label: string } | null; part?: { i: number; n: number } | null };
export type DrawnFigure = { key: string; shown: string; shownKind: "" | "cents" | "ratio" | "text"; perMonths: number | null; clearance: string; text: string; drawn?: string };
/** A proof drawer as drawn: the money and rates it shows and the proof the server answered (held to each other in render-audit.ts). */
export type RawDrawer = { key: string; tokens: string[]; proof: unknown; perMonths: number | null } | { key: string; none: string };
export type RawView = {
  view: string;
  figures: DrawnFigure[];
  strays: string[];
  chart?: string[];
  errors: string[];
  whatIf?: { why: string; figures: { key: string; clearance: string }[]; tokens: string[] }[];
  rawDrawers?: RawDrawer[];
};
/** A request a unit's page made, as needed to ask it again: path and query, method, the headers the answer can turn on, and a POST's body. */
export type Asked = { method: string; url: string; headers: Record<string, string>; body?: string };
/** What a unit drew; a page's own unit (part 0) also lists the page's tabs. `draws` counts every look, `repeats` those that drew nothing new. */
export type UnitRun = Unit & { views: RawView[]; ms: number; skipped?: string; tabs?: Unit[]; draws: number; repeats: number; drawers: number; settleMs?: number; collectMs?: number; asked?: Asked[] };

export const unitName = (u: Unit) => `${u.tab ? `${u.route} › ${u.tab.label}` : u.route}${u.part && u.part.n > 1 ? ` [${u.part.i + 1}/${u.part.n}]` : ""}`;
/** A tab's identity across runs and shards: its page, tab id and the tab's label (parts share it). */
export const tabKey = (u: Unit) => JSON.stringify([u.route, u.tab?.id ?? null, u.tab?.label ?? null]);
/** A unit's own identity: its tab and which part. */
export const unitKey = (u: Unit) => JSON.stringify([u.route, u.tab?.id ?? null, u.tab?.label ?? null, u.part && u.part.n > 1 ? `${u.part.i}/${u.part.n}` : null]);

export type DriveConfig = {
  base: string;
  /** How long a view may take to settle (its data loaded, no figure still verifying). */
  settleMs: number;
  /** How long nothing may change before a view counts as drawn. */
  quietMs: number;
  /** The day the server pins (APP_TODAY): the browser's clock reads it too. */
  today?: string;
  /** The lock screen was passed already (render-audit-real.ts): each page starts unlocked. */
  unlock: boolean;
  drillsPerView: number;
  drawersPerView: number;
};

/** What a page draws now: every figure's data attributes and text, and money drawn outside any figure. Runs in the browser. */
function collect(scope?: string) {
  const visible = (el: Element) => (el as HTMLElement).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true;
  // A view that is a dialog (a chart's table) is that dialog alone: the page behind it is a view of its own.
  const root: HTMLElement = (scope ? [...document.querySelectorAll<HTMLElement>(scope)].at(-1) : null) ?? document.body;
  const figures = [...root.querySelectorAll<HTMLElement>("[data-proof-key]")].filter(visible).map((el) => {
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
  const tokenRe = /[+\-−]?\(?\$\s?\d[\d,]*(?:\.\d+)?[kMB]?\)?|[+\-−]?\(?\d[\d,]*(?:\.\d+)?\s?%\)?/g;
  // What-if regions (kit WhatIf): their bare numbers aren't strays, but renderAudit.ts holds them (and the figures inside) to the ledger.
  const regions = [...root.querySelectorAll<HTMLElement>("[data-what-if]")].filter((r) => visible(r) && (scope ? true : !r.closest('[role="dialog"]')));
  const regionTokens = new Map<Element, string[]>(regions.map((r) => [r, []]));
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent ?? "";
    if (!re.test(t)) continue;
    const el = n.parentElement;
    // An open proof drawer's numbers are held to its proof's JSON (drawerTokens), not to this view; a chart tooltip is where the mouse last was.
    if (!el || el.closest('.pf-drawer:has([data-proof-clearance]), .recharts-tooltip-wrapper, [data-proof-key], [data-not-figure]:not([data-not-figure=""]), .recharts-cartesian-axis-tick-value, #recharts_measurement_span, input, textarea, select, option, script, style, noscript') || !visible(el)) continue;
    const region = el.closest("[data-what-if]");
    if (region) {
      regionTokens.get(region)?.push(...[...t.matchAll(tokenRe)].map((m) => m[0]));
      continue;
    }
    const where = (el.closest("tr, li, [class*='rounded-lg'], section") ?? el).textContent?.replace(/\s+/g, " ").trim().slice(0, 90) ?? "";
    // In a chart (SVG): a label for a figure the view draws, held to it in renderAudit.ts.
    if (el.closest("svg")) chart.add(t.replace(/\s+/g, " ").trim());
    else strays.add(`${t.replace(/\s+/g, " ").trim().slice(0, 60)}" in "${where}`);
  }
  const whatIf = regions.map((r) => ({
    why: r.dataset.whatIf || "(no reason given)",
    figures: [...r.querySelectorAll<HTMLElement>("[data-proof-key]")].filter(visible).map((f) => ({ key: f.dataset.proofKey ?? "", clearance: f.dataset.clearance ?? "" })),
    tokens: regionTokens.get(r) ?? [],
  }));
  return { figures, strays: [...strays], chart: [...chart], whatIf };
}

/** Money and rates a proof drawer (the dialog the figure opened) draws. Runs in the browser. */
function drawerTokens(): string[] {
  const d = [...document.querySelectorAll('[role="dialog"]')].at(-1);
  if (!d) return [];
  const re = /[+\-−]?\(?\$\s?\d[\d,]*(?:\.\d+)?[kMB]?\)?|[+\-−]?\(?\d[\d,]*(?:\.\d+)?\s?%\)?/g;
  return [...((d as HTMLElement).innerText ?? "").matchAll(re)].map((m) => m[0]);
}

/**
 * Installed in every document before the app's own scripts: notes the last time anything the
 * audit reads changed (a node added or removed, text, or an attribute a figure, control or
 * loading state carries) and how many fetches the page has open, so settle() waits for the
 * page to go quiet instead of sampling it.
 */
function quietProbe() {
  const w = window as unknown as { __pfAudit?: { fetching: number; changed: number } };
  if (w.__pfAudit) return;
  const s = { fetching: 0, changed: performance.now() };
  w.__pfAudit = s;
  const f = window.fetch;
  window.fetch = function (this: unknown, ...a: Parameters<typeof fetch>) {
    s.fetching++;
    s.changed = performance.now();
    return f.apply(this, a).finally(() => {
      s.fetching--;
      s.changed = performance.now();
    });
  } as typeof fetch;
  new MutationObserver(() => {
    s.changed = performance.now();
  }).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["data-clearance", "data-shown", "data-proof-key", "data-skeleton", "data-tab-id", "aria-checked", "aria-selected", "aria-expanded", "hidden", "role", "open", "value", "disabled"],
  });
}

/** True once nothing the audit reads has changed for `quiet` ms, no fetch is open, and no figure or list is still loading. Runs in the browser. */
function quietFor(quiet: number) {
  const s = (window as unknown as { __pfAudit?: { fetching: number; changed: number } }).__pfAudit;
  if (!s || s.fetching > 0) return false;
  if (document.querySelector('[data-clearance="verifying"], [data-skeleton]')) return false;
  return performance.now() - s.changed >= quiet;
}

/** When the page last changed anything the audit reads (quietProbe), in the page's clock. Runs in the browser. */
function changedAt(): number {
  return (window as unknown as { __pfAudit?: { changed: number } }).__pfAudit?.changed ?? 0;
}

/** True once the page has changed since `t` (a click took effect). Runs in the browser. */
function changedSince(t: number): boolean {
  return ((window as unknown as { __pfAudit?: { changed: number } }).__pfAudit?.changed ?? 0) > t;
}

/** The headers a server's answer can turn on (Next's router headers, content negotiation); never a secret, which a replay adds from its own environment. */
const KEPT_HEADERS = new Set(["accept", "content-type", "rsc", "next-router-state-tree", "next-router-prefetch", "next-router-segment-prefetch", "next-url", "next-hmr-refresh", "range"]);

/** One browser context and page a worker audits unit after unit in (the page's code and the sweep stay in its cache), and what the current unit has seen. */
export type Worker = {
  context: BrowserContext;
  page: Page;
  errors: string[];
  net: { inflight: number; last: number };
  asked: Map<string, Asked> | null;
  /** Every path the unit's page was on (loaded, redirected or routed to in place). */
  visited: Set<string>;
};

/** A worker's context: the demo's day, the lock screen passed, every row drawn, writes refused, and the quiet probe. */
export async function openWorker(browser: Browser, cfg: DriveConfig): Promise<Worker> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce" });
  // The demo's day in the browser too (scripts/demo.ts DEMO_TODAY): the year a page opens on, its default range.
  if (cfg.today) await context.clock.setFixedTime(new Date(`${cfg.today}T12:00:00`));
  // The flag the lock screen sets once its password is accepted (components/shell/LockScreen.tsx).
  if (cfg.unlock) await context.addInitScript(() => sessionStorage.setItem("pf-unlocked", "1"));
  // Long tables draw only the rows in view (components/ui/DataTable.tsx); the audit reads every row a list holds.
  await context.addInitScript(() => sessionStorage.setItem("pf-draw-every-row", "1"));
  // The demo's first-run tour (components/shell/Tour.tsx) opens on a timer, 1.2 s in: a dialog that may land on top of
  // a proof drawer just opened (read instead of it) or be closed by its Escape. Seen already, as ui-checks.ts starts
  // every check but the tour's own; it draws no figure.
  await context.addInitScript(() => localStorage.setItem("pf-tour-done", "1"));
  await context.addInitScript(quietProbe);
  // The audit only looks: any write (a saved input, a decision) is refused, so the data the sweep cleared is the data drawn.
  await context.route(/\/api\//, (r) => {
    const q = r.request();
    return q.method() === "GET" || (q.method() === "POST" && new URL(q.url()).pathname === "/api/proof") ? r.continue() : r.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const w: Worker = { context, page, errors: [], net: { inflight: 0, last: Date.now() }, asked: null, visited: new Set() };
  const origin = new URL(cfg.base).origin;
  page.on("request", (q: Request) => {
    w.net.inflight++;
    w.net.last = Date.now();
    const u = new URL(q.url());
    const allowed = q.method() === "GET" || (q.method() === "POST" && u.pathname === "/api/proof");
    if (!w.asked || u.origin !== origin || !allowed) return;
    const headers = Object.fromEntries(Object.entries(q.headers()).filter(([k]) => KEPT_HEADERS.has(k.toLowerCase())));
    const a: Asked = { method: q.method(), url: u.pathname + u.search, headers, ...(q.method() === "POST" ? { body: q.postData() ?? "" } : {}) };
    w.asked.set(JSON.stringify(a), a);
  });
  const done = () => {
    w.net.inflight = Math.max(0, w.net.inflight - 1);
    w.net.last = Date.now();
  };
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) w.visited.add(new URL(f.url()).pathname);
  });
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  page.on("pageerror", (e) => w.errors.push(`The page threw: ${e.message.split("\n")[0]}`));
  // A read the page's data came from that failed leaves the page showing an error note, not its figures: said, not drawn as an empty view.
  const read = (q: { method(): string; url(): string }) => {
    const p = new URL(q.url()).pathname;
    return p.startsWith("/api/") && (q.method() === "GET" || p === "/api/proof") ? `${q.method()} ${p}` : null;
  };
  page.on("response", (r) => {
    const what = read(r.request());
    if (what && r.status() >= 400) w.errors.push(`${what} answered ${r.status()}`);
  });
  page.on("requestfailed", (q) => {
    const what = read(q);
    // Aborted is the browser dropping a read the page no longer needs (it moved on), not a failure.
    if (what && q.failure()?.errorText !== "net::ERR_ABORTED") w.errors.push(`${what} failed: ${q.failure()?.errorText}`);
  });
  return w;
}

/**
 * Leaves the worker's page as a fresh context would start a unit: no page state, nothing in
 * the origin's storage but what the init scripts set, and the pointer off the page (a new
 * document picks up hover from where the last unit clicked, and a hovered title draws its
 * tooltip: components/shell/Tooltips.tsx). Only the browser's HTTP cache carries over (the
 * same bytes the server would send again).
 */
async function reset(w: Worker, cfg: DriveConfig) {
  await w.page.mouse.move(-10, -10);
  await w.page.goto(`${cfg.base}/api/app-password`, { waitUntil: "load" });
  await w.page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  w.errors.length = 0;
}

/** Waits until the view's data has loaded and nothing changes: no request in flight, no figure verifying, nothing redrawn for quietMs. */
async function settle(w: Worker, cfg: DriveConfig): Promise<string | null> {
  const until = Date.now() + cfg.settleMs;
  const never = `never settled in ${cfg.settleMs / 1000}s (figures still verifying, or the page kept changing)`;
  for (;;) {
    const left = until - Date.now();
    if (left <= 0) return never;
    const quiet = await w.page.waitForFunction(quietFor, cfg.quietMs, { polling: 20, timeout: left }).then(
      () => true,
      () => false,
    );
    if (!quiet) return never;
    // The page is quiet, and so is the network (a body still arriving after its fetch resolved counts as loading).
    const netQuiet = Date.now() - w.net.last;
    if (w.net.inflight === 0 && netQuiet >= cfg.quietMs) return null;
    await w.page.waitForTimeout(Math.max(10, cfg.quietMs - netQuiet));
  }
}

/**
 * Audits one tab of one page (or one part of it) on a worker. The page's own first tab also
 * lists the others (kit Tabs: data-tab-id) as soon as it has loaded, and hands each to
 * `found`, so a page with many tabs runs on several workers at once.
 *
 * A part i of n draws the page as every part does, then keeps only its share of what it
 * would click through: the slots (the first view's drawers, each drill-down it offers, each
 * option of each control at the top) are dealt round-robin, and a slot's whole subtree goes
 * with it. Together the parts draw at least what one run would.
 */
export async function auditUnit(w: Worker, cfg: DriveConfig, unit: Unit, all: readonly string[], found: (tab: Unit) => void): Promise<UnitRun> {
  const t0 = Date.now();
  const page = w.page;
  const part = unit.part ?? { i: 0, n: 1 };
  let slot = 0;
  const mine = () => slot++ % part.n === part.i;
  await reset(w, cfg);
  w.asked = new Map();
  w.visited = new Set([unit.route]);
  w.net.last = Date.now();
  const views: RawView[] = [];
  // A view drawn before (the same figures, the same strays): nothing new to drill into or explore from it.
  const seen = new Set<string>();
  // The proof drawers this unit opened, by family (report › page › figure): one of each is enough to hold the
  // drawer's drawing. Per unit, not per run, so which drawers open never depends on which worker or shard got there first.
  const drawerFamilies = new Set<string>();
  // settleMs/collectMs: where a unit's looks spend their time (waiting for the page, reading it), in RENDER_AUDIT_JSON.
  const stats = { draws: 0, repeats: 0, drawers: 0, settleMs: 0, collectMs: 0 };

  const draw = async (name: string, scope?: string): Promise<RawView & { repeat: boolean }> => {
    const t0 = Date.now();
    const unsettled = await settle(w, cfg);
    const t1 = Date.now();
    // A view that changed while it was read (a list still filling in on a slow machine) is settled and read again.
    let s: ReturnType<typeof collect>;
    for (let k = 0; ; k++) {
      const before = await page.evaluate(changedAt);
      s = await page.evaluate(collect, scope);
      if (k === 2 || (await page.evaluate(changedAt)) === before) break;
      await settle(w, cfg);
    }
    stats.settleMs += t1 - t0;
    stats.collectMs += Date.now() - t1;
    const v: RawView = { view: name, figures: s.figures, strays: s.strays, chart: s.chart, ...(s.whatIf.length ? { whatIf: s.whatIf } : {}), errors: [...w.errors.splice(0), ...(unsettled ? [unsettled] : [])] };
    const sig = JSON.stringify([s.figures.map((f) => [f.key, f.clearance, f.text]), s.strays, s.whatIf]);
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

  /** Opens a few figures' proof drawers (F6e) and records what each draws beside the proof the server answered. */
  const drawers = async (v: RawView) => {
    const picks = v.figures.filter((f) => f.clearance === "cleared" && !drawerFamilies.has(familyOf(f.key)));
    for (const f of picks.slice(0, cfg.drawersPerView)) {
      if (drawerFamilies.has(familyOf(f.key))) continue;
      drawerFamilies.add(familyOf(f.key));
      // On a chart table's view, the table's own figure: the page's copy of it sits behind the dialog.
      const within = (await page.locator("[data-chart-table-view]").count()) ? page.locator("[data-chart-table-view]").last() : page;
      const el = within.locator(`[data-clearance="cleared"][data-proof-key="${f.key.replace(/["\\]/g, "\\$&")}"]`).first();
      if (!(await el.isVisible().catch(() => false))) continue;
      stats.drawers++;
      // Caught as it's made: a click that throws mustn't leave it to reject unheard.
      const answer = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/proof" && r.request().method() === "POST", { timeout: 15_000 }).catch(() => null);
      await el.click();
      const res = await answer;
      if (!res) {
        v.rawDrawers = [...(v.rawDrawers ?? []), { key: f.key, none: "(the drawer asked for no proof)" }];
        await closeDialog();
        continue;
      }
      // A response whose body is already gone (the page moved on) leaves this drawer unchecked, not the page broken.
      const proof = (await res.json().catch(() => null)) as unknown;
      if (proof == null) {
        await closeDialog();
        continue;
      }
      await settle(w, cfg);
      v.rawDrawers = [...(v.rawDrawers ?? []), { key: f.key, tokens: await page.evaluate(drawerTokens), proof, perMonths: f.perMonths }];
      await closeDialog();
    }
  };

  /**
   * What each drill-down on the view opens (data-audit-drill: a month, a category, a
   * merchant) as a view of its own. One that opens a drawer is closed again; one that
   * changes the page in place (a year month by month) is stepped through with its
   * data-audit-step buttons, each step drawn, and left with its data-audit-back button.
   * `dealt`: each drill is a slot of its own (the first view's drills, split between parts).
   */
  const drills = async (name: string, dealt = false) => {
    const openers = page.locator('[data-audit-drill]:not([role="dialog"] *)');
    const n = Math.min(await openers.count(), cfg.drillsPerView);
    for (let i = 0; i < n; i++) {
      if (dealt && !mine()) continue;
      const o = openers.nth(i);
      if (!(await o.isVisible().catch(() => false))) continue;
      const label = ((await o.getAttribute("data-audit-drill")) || (await o.innerText()).slice(0, 30)).replace(/\s+/g, " ").trim();
      // The drill must take effect before the view is read: a slow page can look quiet before it reacts.
      const t = await page.evaluate(() => performance.now());
      await o.click();
      await page.waitForFunction(changedSince, t, { polling: 20, timeout: 3000 }).catch(() => {});
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
        await settle(w, cfg);
      } else if (await page.locator('[role="dialog"]').count()) await closeDialog();
    }
  };

  /**
   * Each chart's table (RechartsResponsive: data-chart-table), opened as a view of its own:
   * every value in it is a figure that opens its proof, or n.a. when its chart names none
   * (owner's rule, 2026-11-26), and a what-if chart's table is marked as that what-if.
   * `dealt`: each table is a slot of its own (the first view's tables, split between parts).
   */
  const tables = async (name: string, dealt = false) => {
    const openers = page.locator('[data-chart-table]:not([role="dialog"] *)');
    const n = await openers.count();
    for (let i = 0; i < n; i++) {
      if (dealt && !mine()) continue;
      const o = openers.nth(i);
      if (!(await o.count())) continue;
      const label = ((await o.getAttribute("data-chart-table")) || `chart ${i + 1}`).replace(/\s+/g, " ").trim();
      if (!(await o.isVisible().catch(() => false))) continue;
      // The button sits over the chart and shows on hover or focus: a pointer click can land on the chart's own layer, so click it as a keyboard user would.
      await o.evaluate((el) => (el as HTMLElement).click());
      // The table opens in a drawer: read it once it's there.
      await page.locator("[data-chart-table-view]").last().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
      const v = await draw(`${name} ▤ ${label}`, "[data-chart-table-view]");
      if (!v.repeat) await drawers(v);
      await closeDialog();
    }
  };

  /**
   * Clicks an option and waits for the control to show it picked. The control and the view
   * are drawn from the same state, so once it does, the new option's render has landed.
   * Without this, a slow runner can settle on the previous option's view, which then reads
   * as a repeat and the option is never audited.
   */
  const pick = async (radio: Locator) => {
    await radio.click();
    await radio
      .and(page.locator('[aria-checked="true"]'))
      .waitFor({ timeout: cfg.settleMs })
      .catch(() => {});
  };

  /**
   * Every option of each control the page marks as a view (data-audit-view), and with each
   * one, every option of the controls after it (a year, then its basis): every pair, so a
   * column only a year and a basis together show is drawn too. Drill-downs open on each
   * single change, not on every pair. A control marked data-audit-nest (kit Segmented view
   * nested) is clicked under every pair too: what it shows hangs on both pickers before it.
   * Options the control names in data-audit-view are left alone (it says why in
   * data-audit-skip-why). At the top (depth 0) each option is a slot, dealt between parts.
   */
  /** "Show more" (data-audit-more) until there is no more: every row the view can list is drawn (each page by part 0; every part clicks through to the whole list). */
  const showMore = async (name: string) => {
    const more = page.locator('[data-audit-more]:not([role="dialog"] *)').first();
    // Settled first: right after a picker changes, the list (and its button) is still being redrawn.
    await settle(w, cfg);
    for (let k = 1; k <= 100 && (await more.isVisible().catch(() => false)); k++) {
      if (part.i === 0) await draw(`${name} (page ${k})`);
      // A button the page swapped out mid-click is the end of what it can list, not a page the audit can't finish.
      if (!(await more.click().then(() => true, () => false))) break;
      await settle(w, cfg);
    }
  };

  const explore = async (name: string, from = 0, depth = 0) => {
    const controls = page.locator('[data-audit-view]:not([role="dialog"] *)');
    const count = await controls.count();
    for (let i = from; i < count; i++) {
      const c = controls.nth(i);
      if (!(await c.isVisible().catch(() => false))) continue;
      if (depth === 2 && (await c.getAttribute("data-audit-nest")) == null) continue;
      const label = (await c.getAttribute("aria-label")) || `view ${i + 1}`;
      const skip = new Set(((await c.getAttribute("data-audit-view")) ?? "").split(",").filter(Boolean));
      const show = async (opt: string) => {
        const at = `${name} · ${label}=${opt}`;
        // A picker can shorten the list again (a window, a category): every row of each view is drawn.
        await showMore(at);
        const v = await draw(at);
        if (v.repeat) return;
        await drawers(v);
        if (depth === 0) {
          await tables(at);
          await drills(at);
          await explore(at, i + 1, 1);
        } else if (depth === 1 && (await page.locator("[data-audit-nest]").count())) {
          // A page whose views pair up (a coverage, then each year of it) draws each pair's own charts: their tables too.
          await tables(at);
          await explore(at, i + 1, 2);
        }
      };
      if ((await c.evaluate((e) => e.tagName)) === "SELECT") {
        const was = await c.inputValue();
        for (const value of await c.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))) {
          if (value === was || skip.has(value)) continue;
          if (depth === 0 && !mine()) continue;
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
          if (depth === 0 && !mine()) continue;
          await pick(radios.nth(j));
          await show((await radios.nth(j).innerText()).trim());
        }
        if (on >= 0) await pick(radios.nth(on));
      }
      await settle(w, cfg);
    }
  };

  const visit = async (name: string) => {
    await showMore(name);
    // Every part draws the first view (so a later view repeating it is known); its drawers are one slot.
    const v = await draw(name);
    if (mine()) await drawers(v);
    await tables(name, true);
    await drills(name, true);
    await explore(name);
  };

  const name = unitName(unit);
  const tabs: Unit[] = [];
  try {
    const r = await page.goto(`${cfg.base}${unit.route}${unit.tab ? `?tab=${encodeURIComponent(unit.tab.id)}` : ""}`, { waitUntil: "load" }).catch((e: Error) => (w.errors.push(`Couldn't open: ${e.message.split("\n")[0]}`), null));
    if (r && !r.ok()) w.errors.push(`Answered ${r.status()}`);
    // Settled first: a server redirect() lands in the browser after "load".
    await settle(w, cfg);
    // A page that draws nothing yet may only be between hydrating and asking for its data on a busy machine: one more look.
    const first = await page.evaluate(collect, undefined);
    if (!first.figures.length && !first.strays.length) {
      await page.waitForTimeout(1000);
      await settle(w, cfg);
    }
    // An old address that redirects to a page audited in its own right is that page.
    const landed = new URL(page.url()).pathname;
    if (!unit.tab && landed !== unit.route && all.includes(landed)) return { ...unit, views: [], ms: Date.now() - t0, skipped: `redirects to ${landed}`, ...stats, asked: inputs(w) };
    if (!unit.tab && part.i === 0) {
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
  }
  const asked = inputs(w);
  w.asked = null;
  return { ...unit, views, ms: Date.now() - t0, ...(!unit.tab && part.i === 0 ? { tabs } : {}), ...stats, asked };
}

/** What the unit's drawing came from: every request but a link's prefetch of a page it never went to (the router reads a prefetched page only on arriving there). */
function inputs(w: Worker): Asked[] {
  const prefetch = (a: Asked) => "next-router-prefetch" in a.headers || "next-router-segment-prefetch" in a.headers;
  return [...(w.asked?.values() ?? [])].filter((a) => !prefetch(a) || w.visited.has(a.url.split("?")[0]!));
}

function familyOf(key: string) {
  try {
    const d = JSON.parse(key) as Record<string, unknown>;
    return [d.report, d.page, d.figure ?? d.metric ?? d.line ?? d.measure ?? d.op].filter((x) => typeof x === "string").join(" › ");
  } catch {
    return key;
  }
}
