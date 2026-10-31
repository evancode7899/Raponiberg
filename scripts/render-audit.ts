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
 * RENDER_AUDIT_BROWSER names another executable.
 */
import { readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { auditRender, BYPASS_PENDING, pageOf, type DrawnView, type SweepVerdicts } from "../src/lib/book/proof/renderAudit.ts";

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
  // labels (a scale, not data) and text marked data-not-figure (a calculator's own step)
  // aren't figures. Words that open a proof (data-drawn="words") are held in renderAudit.ts.
  const strays = new Set<string>();
  const re = /\$\s?\d|\d(?:[.,]\d+)*\s?%/;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent ?? "";
    if (!re.test(t)) continue;
    const el = n.parentElement;
    if (!el || el.closest("[data-proof-key], [data-not-figure], .recharts-cartesian-axis-tick-value, input, textarea, select, option, script, style, noscript") || !visible(el)) continue;
    const where = (el.closest("tr, li, [class*='rounded-lg'], section") ?? el).textContent?.replace(/\s+/g, " ").trim().slice(0, 90) ?? "";
    strays.add(`${t.replace(/\s+/g, " ").trim().slice(0, 60)}" in "${where}`);
  }
  return { figures, strays: [...strays], verifying: document.querySelectorAll('[data-clearance="verifying"]').length, size: document.body.innerText.length };
}

/** Waits until the view's data has loaded and nothing changes: no requests in flight, no figure verifying, the same drawing twice. */
async function settle(page: Page): Promise<string | null> {
  await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => {});
  const until = Date.now() + SETTLE_MS;
  let last = "";
  while (Date.now() < until) {
    const s = await page.evaluate(collect);
    const sig = `${s.verifying}|${s.figures.length}|${s.size}|${s.figures.map((f) => f.clearance + f.text).join()}`;
    if (!s.verifying && sig === last) return null;
    last = sig;
    await page.waitForTimeout(300);
  }
  return `never settled in ${SETTLE_MS / 1000}s (figures still verifying, or the page kept changing)`;
}

async function view(page: Page, name: string, errors: string[]): Promise<DrawnView> {
  const unsettled = await settle(page);
  const s = await page.evaluate(collect);
  return { view: name, figures: s.figures, strays: s.strays, errors: [...errors.splice(0), ...(unsettled ? [unsettled] : [])] };
}

const started = Date.now();
// The sweep the pages clear from, run to the end first: the server's own report.
const res = await fetch(`${base}/api/proof/sweep?wait=1`);
if (!res.ok) {
  console.error(`The server's proof sweep answered ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const report = (await res.json()) as SweepVerdicts & { stamp: string; figures: number; problemCount: number };
console.log(`Sweep of ${report.stamp}: ${report.figures} figures, ${Object.keys(report.cleared).length} cleared, ${report.problemCount} problem(s) (${Date.now() - started}ms)`);

const browser = await launch();
const views: DrawnView[] = [];
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce", timezoneId: process.env.TZ || undefined });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`The page threw: ${e.message.split("\n")[0]}`));
  const seen = new Set<string>();
  for (const route of routes()) {
    const t0 = Date.now();
    const r = await page.goto(`${base}${route}`, { waitUntil: "load" }).catch((e: Error) => (errors.push(`Couldn't open: ${e.message.split("\n")[0]}`), null));
    if (r && !r.ok()) errors.push(`Answered ${r.status()}`);
    // A page that redirects to one already audited (an old address) is that page.
    const landed = new URL(page.url()).pathname + new URL(page.url()).search;
    if (seen.has(landed)) {
      errors.splice(0);
      continue;
    }
    seen.add(landed);
    views.push(await view(page, route, errors));
    const tabs = page.locator('[role="tablist"] [role="tab"]');
    const labels = (await tabs.allTextContents()).map((l) => l.replace(/\d+$/, "").trim());
    for (let i = 0; i < labels.length; i++) {
      if ((await tabs.nth(i).getAttribute("aria-selected")) === "true") continue;
      await tabs.nth(i).click();
      views.push(await view(page, `${route} › ${labels[i]}`, errors));
    }
    console.log(`${route.padEnd(18)} ${String(labels.length || 1).padStart(2)} view(s) ${String(Date.now() - t0).padStart(6)}ms`);
  }
} finally {
  await browser.close();
}

const audit = auditRender(views, report);
// RENDER_AUDIT_JSON=<file>: everything drawn and every problem, for working through them.
if (process.env.RENDER_AUDIT_JSON) writeFileSync(process.env.RENDER_AUDIT_JSON, JSON.stringify({ views, audit }, null, 1));
const figures = views.reduce((n, v) => n + v.figures.length, 0);
console.log(`\nRendered ${views.length} views: ${figures} figures drawn, ${audit.drawn} of the sweep's ${audit.cleared} cleared figures among them (${Date.now() - started}ms).`);
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
if (audit.missing.length) {
  const family = (k: string) => {
    const d = JSON.parse(k) as Record<string, unknown>;
    return [d.report, d.page, d.figure ?? d.metric ?? d.line].filter((x) => typeof x === "string").join(" › ");
  };
  console.log(`\n[NOT DRAWN] ${audit.missing.length} cleared figure(s) no view drew (F6d drives year pickers and drill-downs, then fails on them):`);
  for (const [f, n] of count(audit.missing.map(family)).slice(0, LISTED)) console.log(`   ${f.padEnd(44)} ${String(n).padStart(6)}`);
}
const bad = audit.problems.length;
console.log(`\n${bad ? `${bad} render problem(s).` : "Every drawn figure is the one its proof cleared, at the value drawn; no money reaches a held page outside a figure."}`);
process.exit(bad ? 1 : 0);
