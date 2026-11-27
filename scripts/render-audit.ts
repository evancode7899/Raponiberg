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
 * The browser side (opening a tab, clicking through its views, recording what each draws) is
 * scripts/render-audit-drive.ts; this plans the run, holds what was drawn to the sweep, and
 * prints. RENDER_AUDIT_CACHE=<folder> keeps each tab's recording with everything it was drawn
 * from and draws again only the tabs whose inputs changed (scripts/render-audit-cache.ts);
 * a few kept tabs are drawn again on every run to check the cache (RENDER_AUDIT_RECHECK).
 * A slow tab is split into parts that run on several workers at once (RENDER_AUDIT_SPLIT=0: never).
 *
 * Drives the Chrome or Edge already installed (playwright-core downloads no browser);
 * RENDER_AUDIT_BROWSER names another executable. On the owner's own data it runs through
 * scripts/render-audit-real.ts (npm run audit:real), which sets RENDER_AUDIT_UNLOCK and
 * RENDER_AUDIT_REDACT.
 */
import { availableParallelism } from "node:os";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright-core";
import { auditRender, BYPASS_PENDING, drawerStrays, figureFamily, pageOf, UNDRAWN_PENDING, type DrawnView, type RenderProblem, type SweepVerdicts } from "../src/lib/book/proof/renderAudit.ts";
import { dropEntry, loadEntries, Replayer, saveEntry, type Entry } from "./render-audit-cache.ts";
import { auditUnit, openWorker, tabKey, unitName, type DriveConfig, type RawView, type Unit, type UnitRun, type Worker } from "./render-audit-drive.ts";
import { byCost, clean, deal, firstDiff, mergeParts, withParts, type Cost } from "./render-audit-plan.ts";
import { hashFiles } from "../src/lib/importGraph.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** --merge <shard files…>: no browser, just the whole run's audit from what each shard drew. */
const MERGE = process.argv[2] === "--merge" ? process.argv.slice(3) : null;
const base = MERGE ? "" : (process.argv[2] ?? "").replace(/\/$/, "");
if (!base && !MERGE?.length) {
  console.error("Usage: node scripts/render-audit.ts <base-url>\n       node scripts/render-audit.ts --merge <shard.json>…");
  process.exit(2);
}

/** How many problems of each kind to list; the counts are always whole. */
const LISTED = Number(process.env.RENDER_AUDIT_LIST ?? 40);
/**
 * Pages audited at once. The browser's drawing is the work, so past the cores the server and
 * Chrome leave free, more workers only slow each other (8 cores: 6 and 8 take the same time, 4 half again as long).
 */
const WORKERS = Math.max(1, Number(process.env.RENDER_AUDIT_WORKERS ?? Math.min(8, Math.max(4, availableParallelism() - 2))));
/** RENDER_AUDIT_ONLY=/cash-flow,/taxes: just those pages (a partial run: it can't tell what no page draws). */
const ONLY = process.env.RENDER_AUDIT_ONLY?.split(",").map((s) => s.trim()).filter(Boolean);
const CONFIG: DriveConfig = {
  base,
  settleMs: 30_000,
  // As long as the old sampler's gap (two looks 120 ms apart), but every change in between counts now.
  quietMs: 120,
  today: process.env.APP_TODAY?.trim() || undefined,
  // RENDER_AUDIT_UNLOCK=1: the caller had the server check the lock-screen password (render-audit-real.ts), so each tab starts unlocked, as the lock screen leaves it.
  unlock: process.env.RENDER_AUDIT_UNLOCK === "1",
  // Drill-downs opened per view (RENDER_AUDIT_DRILLS caps it on a big Book), and proof drawers held to their proofs per view.
  drillsPerView: Number(process.env.RENDER_AUDIT_DRILLS ?? 80),
  drawersPerView: 4,
};
/** The audit's time budget (F6e), a shard's own when sharded: the owner wants proof checks in minutes, so a slower run fails. RENDER_AUDIT_BUDGET_MS overrides (0: none). */
const BUDGET_MS = Number(process.env.RENDER_AUDIT_BUDGET_MS ?? 240_000);
/** RENDER_AUDIT_REDACT=1: real data, so the console says problem kinds, pages and counts, never a drawn value, key or name. */
const REDACT = process.env.RENDER_AUDIT_REDACT === "1";
/** RENDER_AUDIT_CACHE=<folder>: draw again only the tabs whose inputs changed (render-audit-cache.ts). Not with shards: each must deal the same plan. */
const CACHE = process.env.RENDER_AUDIT_CACHE?.trim() || null;
/** Kept tabs drawn again on every run, to check that a kept recording is what the tab draws now. */
const RECHECK = Math.max(0, Number(process.env.RENDER_AUDIT_RECHECK ?? 3));
/** A tab costing more than its share is split into parts (up to MAX_PARTS), so no one tab holds the run up. */
const SPLIT = process.env.RENDER_AUDIT_SPLIT !== "0";
const MAX_PARTS = 6;
/** Each part draws the page and its first view again: below this a tab isn't worth splitting. */
const MIN_PART_MS = 8_000;
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
 * What each tab took last time (scripts/render-audit-costs.json): the busiest start first,
 * slow ones are split, and shards are dealt from them. Stale costs only slow a run down, never
 * skip a unit: a tab no costs file lists is still found and run. RENDER_AUDIT_COSTS=<file> writes this run's.
 */
const COSTS_FILE = path.join(ROOT, "scripts", "render-audit-costs.json");
/**
 * With a cache, what each tab took here last time, kept beside it: the real Book's tabs cost
 * several times the demo's, and this machine isn't CI's, so a run plans its parts from its own.
 */
const LOCAL_COSTS = CACHE ? path.join(CACHE, "costs.json") : null;
function readCosts(f: string): Cost[] {
  try {
    return JSON.parse(readFileSync(f, "utf8")) as Cost[];
  } catch {
    return [];
  }
}
function writeCosts(f: string, costs: readonly Cost[]) {
  const lines = [...costs].sort((a, b) => tabKey(a).localeCompare(tabKey(b))).map((c) => `  ${JSON.stringify({ route: c.route, tab: c.tab, ms: c.ms })}`);
  writeFileSync(f, `[\n${lines.join(",\n")}\n]\n`);
}

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

type Report = SweepVerdicts & { stamp: string; figures: number; problemCount: number; independence?: { unchecked: number } };
/** What a run, or one shard of it, drew: every unit and the sweep they were held to (RENDER_AUDIT_OUT, for --merge). */
type Drawn = { shard: string | null; only: string[] | null; report: Report; runs: UnitRun[]; ms: number; notes?: RenderProblem[] };

/** The tabs to run, busiest first: every page, and every tab of them the costs file lists. */
function plan(pages: readonly string[]): Cost[] {
  // No costs yet: every unit costs the same, and tabs are found as their pages load.
  const local = LOCAL_COSTS ? readCosts(LOCAL_COSTS) : [];
  const costs = local.length ? local : readCosts(COSTS_FILE);
  const known = new Map(costs.map((c) => [tabKey(c), c.ms]));
  const sorted = costs.map((c) => c.ms).sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1] ?? 0;
  const units: Unit[] = [...pages.map((route) => ({ route, tab: null })), ...costs.filter((c) => c.tab && pages.includes(c.route)).map(({ route, tab }) => ({ route, tab }))];
  return units.map((u) => ({ ...u, ms: known.get(tabKey(u)) ?? median })).sort(byCost);
}

const line = (u: Unit, r: UnitRun, note = "") =>
  console.log(`${unitName(u).padEnd(44)} ${r.skipped ?? `${String(r.views.length).padStart(4)} view(s) ${String(r.draws).padStart(4)} look(s) ${String(r.drawers).padStart(3)} drawer(s)`} ${String(r.ms).padStart(7)}ms${note}`);

/** Renders this run's units (all of them, or this shard's) on a few workers at once, drawing only what the cache can't vouch for. */
async function run(): Promise<Drawn> {
  const started = Date.now();
  // The sweep the pages clear from, run to the end first: the server's own report. Asked
  // again while it runs (202), as pages do: one request held open past fetch's 5-minute
  // header timeout fails on a large Book's cold start.
  let res = await fetch(`${base}/api/proof/sweep`);
  while (res.status === 202) {
    await new Promise((r) => setTimeout(r, 250));
    res = await fetch(`${base}/api/proof/sweep`);
  }
  if (!res.ok) {
    console.error(`The server's proof sweep answered ${res.status}${REDACT ? "" : `: ${await res.text()}`}`);
    process.exit(1);
  }
  const report = (await res.json()) as Report;
  console.log(`Sweep${REDACT ? "" : ` of ${report.stamp}`}: ${report.figures} figures, ${Object.keys(report.cleared).length} cleared, ${report.problemCount} problem(s) (${Date.now() - started}ms)`);
  const notes: RenderProblem[] = [];
  // RENDER_AUDIT_SWEEP_GATE=1 (scripts/demo.ts --sweep with --render-audit): the server's sweep is the same sweep npm run proof:sweep runs, so its verdict is held here instead of sweeping twice.
  if (process.env.RENDER_AUDIT_SWEEP_GATE === "1" && (report.problemCount || report.independence?.unchecked)) {
    notes.push({ kind: "RENDER_ERROR", view: "(the proof sweep)", detail: `${report.problemCount} sweep problem(s), ${report.independence?.unchecked ?? 0} figure(s) on their own route only: npm run proof:sweep lists them.` });
  }

  const all = routes();
  const todo = ONLY ? all.filter((r) => ONLY.includes(r)) : all;
  if (!todo.length) {
    console.error(`No page to audit${ONLY ? ` among ${ONLY.join(", ")} (pages: ${all.join(" ")})` : ""}.`);
    process.exit(2);
  }
  const browser = await launch();
  const planned = plan(todo);
  const runs: UnitRun[] = [];
  const queued = new Set(planned.map(tabKey));

  // The cache: each kept tab whose every answer is the same now is drawn from its recording.
  const driver = hashFiles(ROOT, [path.join(ROOT, "scripts", "render-audit-drive.ts")], [browser.version(), JSON.stringify({ ...CONFIG, base: null })]);
  // RENDER_AUDIT_BUILD_ID (scripts/demo.ts, render-audit-real.ts): the id of the build served, read past in its answers.
  const replayer = new Replayer(base, [report.stamp, process.env.RENDER_AUDIT_BUILD_ID?.trim() ?? ""]);
  const hits = new Map<string, Entry>();
  let toDraw: Cost[] = planned;
  const forced = new Map<string, number>();
  if (CACHE && !SHARD) {
    const t0 = Date.now();
    const kept = loadEntries(CACHE);
    const check = async (tabs: readonly Cost[]) => {
      const ok = await Promise.all(tabs.map(async (u) => {
        const e = kept.get(tabKey(u));
        return e && e.driver === driver && (await replayer.unchanged(e)) ? e : null;
      }));
      ok.forEach((e, i) => e && hits.set(tabKey(tabs[i]!), e));
    };
    await check(planned);
    // Tabs a kept page lists that the costs file doesn't: checked too, else drawn.
    for (let more = [...hits.values()]; more.length; ) {
      const extra = more.flatMap((e) => e.run.tabs ?? []).filter((t) => !queued.has(tabKey(t)) && todo.includes(t.route)).map((t) => ({ ...t, ms: 0 }));
      extra.forEach((t) => queued.add(tabKey(t)));
      planned.push(...extra);
      const before = new Set(hits.keys());
      await check(extra);
      more = [...hits.entries()].filter(([k]) => !before.has(k)).map(([, e]) => e);
    }
    // A few kept tabs drawn again anyway, as they were kept (same parts), and held to what was kept.
    const recheck = [...hits.keys()].sort(() => Math.random() - 0.5).slice(0, RECHECK);
    for (const k of recheck) forced.set(k, hits.get(k)!.parts);
    toDraw = planned.filter((u) => !hits.has(tabKey(u)) || forced.has(tabKey(u)));
    for (const k of recheck) hits.delete(k);
    console.log(`Cache: ${hits.size + recheck.length} of ${planned.length} tab(s) unchanged (${replayer.asked} answer(s) asked again, ${Date.now() - t0}ms: ${replayer.spentText() || "none"}); drawing ${toDraw.length - recheck.length}, and ${recheck.length} kept one(s) again to check the cache.`);
    for (const e of hits.values()) runs.push({ ...e.run, part: null });
  }

  const units = withParts(toDraw, { workers: WORKERS, shards: SHARD?.n ?? 1, split: SPLIT, minPartMs: MIN_PART_MS, maxParts: MAX_PARTS }, forced);
  const mine = SHARD ? deal(units, SHARD.n)[SHARD.i - 1]! : units;
  if (SHARD) console.log(`Shard ${SHARD.i}/${SHARD.n}: ${mine.length} of ${units.length} unit(s), about ${Math.round(mine.reduce((n, u) => n + u.ms, 0) / 1000)} s of work by the last costs.`);
  // Busiest first, so the long units don't finish last; a tab no plan lists joins the queue when its page finds it.
  const queue: Unit[] = mine.map(({ route, tab, part }) => ({ route, tab, part }));
  const found = (tab: Unit) => {
    if (queued.has(tabKey(tab))) return;
    queued.add(tabKey(tab));
    queue.push(tab);
  };
  const fresh: UnitRun[] = [];
  try {
    let busy = 0;
    await Promise.all(
      Array.from({ length: Math.min(WORKERS, Math.max(1, queue.length)) }, async () => {
        let w: Worker | null = null;
        try {
          // A worker with nothing queued waits while others may still queue tabs.
          for (;;) {
            const unit = queue.shift();
            if (!unit) {
              if (!busy) return;
              await new Promise((r) => setTimeout(r, 100));
              continue;
            }
            busy++;
            let r: UnitRun;
            try {
              w ??= await openWorker(browser, CONFIG);
              r = await auditUnit(w, CONFIG, unit, all, found);
              // A unit that hit an error runs once more, in a fresh context: one a busy machine caused doesn't change what the run reports, and a real one fails again.
              if (!clean(r)) {
                console.log(`${unitName(unit).padEnd(44)} retried${REDACT ? "" : `: ${r.views.flatMap((v) => v.errors)[0]}`}`);
                await w.context.close().catch(() => {});
                w = await openWorker(browser, CONFIG);
                r = await auditUnit(w, CONFIG, unit, all, found);
              }
            } finally {
              busy--;
            }
            fresh.push(r);
            line(unit, r);
          }
        } finally {
          await w?.context.close().catch(() => {});
        }
      }),
    );
  } finally {
    await browser.close();
  }

  if (CACHE && !SHARD) {
    // Each tab drawn whole and clean is kept with the answers it was drawn from; a rechecked one is held to what was kept first.
    for (const r of mergeParts(fresh)) {
      const k = tabKey(r);
      if (forced.has(k)) {
        const was = loadEntries(CACHE).get(k);
        const diff = was && clean(r) ? firstDiff(r, report.stamp, was.run, was.stamp) : null;
        if (diff) {
          notes.push({ kind: "RENDER_ERROR", view: unitName({ ...r, part: null }), detail: `Drawn again to check the render cache, it drew something other than what was kept from the same answers (${REDACT ? diff.replace(/"[^"]*"/g, "a view") : diff}): the cache missed something this page draws from, or the page doesn't draw the same twice.` });
          dropEntry(CACHE, k);
          continue;
        }
      }
      // An error (a part missing among them) keeps nothing: the tab is drawn again next time.
      if (!clean(r)) {
        dropEntry(CACHE, k);
        continue;
      }
      saveEntry(CACHE, { driver, unit: { route: r.route, tab: r.tab }, parts: r.part?.n ?? 1, answers: await replayer.answers(r.asked ?? []), stamp: report.stamp, run: { ...r, asked: undefined } });
    }
  }
  runs.push(...fresh);
  return { shard: SHARD ? `${SHARD.i}/${SHARD.n}` : null, only: ONLY ?? null, report, runs: runs.map((r) => ({ ...r, asked: undefined })), ms: Date.now() - started, notes };
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

/** A recorded view as the audit holds it: each drawer's drawing held to its proof (lib/book/proof/renderAudit.ts drawerStrays), now. */
const held = (v: RawView): DrawnView => ({
  view: v.view,
  figures: v.figures,
  strays: v.strays,
  ...(v.chart ? { chart: v.chart } : {}),
  errors: v.errors,
  ...(v.whatIf ? { whatIf: v.whatIf } : {}),
  ...(v.rawDrawers ? { drawers: v.rawDrawers.map((d) => ({ key: d.key, strays: "none" in d ? [d.none] : drawerStrays(d.tokens, d.proof, d.perMonths) })) } : {}),
});

/** The audit of everything drawn (a whole run's, or one shard's on its own), printed; exits 1 on any problem. */
function finish(parts: Drawn[]) {
  const { report, only } = parts[0]!;
  const shard = parts.length === 1 ? parts[0]!.shard : null;
  // A shard, or some pages only, can't tell a pending page is clean, nor which cleared figures no page draws.
  const partial = !!only || !!shard;
  // Split tabs whole again (a shard alone may hold only some of a tab's parts: those it has).
  const runs = shard ? parts.flatMap((p) => p.runs) : mergeParts(parts.flatMap((p) => p.runs));
  // A tab the costs file lists that its page no longer has (or names otherwise) drew the page's first tab again: dropped.
  const tabs = new Set(runs.flatMap((r) => r.tabs ?? []).map(tabKey));
  const roots = new Set(runs.filter((r) => !r.tab).map((r) => r.route));
  const stale = new Set(runs.filter((r) => r.tab && roots.has(r.route) && !tabs.has(tabKey(r))).map(tabKey));
  const kept = runs.filter((r) => !stale.has(tabKey(r)));
  if (stale.size) console.log(`\n${stale.size} tab(s) in scripts/render-audit-costs.json no page has now, dropped: rewrite it (RENDER_AUDIT_COSTS).`);
  // In page order, each page's own tab first: the report reads the same whatever finished first, sharded or not.
  const pages = routes();
  const views = kept
    .sort((a, b) => pages.indexOf(a.route) - pages.indexOf(b.route) || (a.tab ? 1 : 0) - (b.tab ? 1 : 0) || unitName(a).localeCompare(unitName(b)) || (a.part?.i ?? 0) - (b.part?.i ?? 0))
    .flatMap((r) => r.views.map(held));

  const audit = auditRender(views, report, BYPASS_PENDING, { partial });
  audit.problems.push(...parts.flatMap((p) => p.notes ?? []));
  // Every tab a page lists is audited somewhere (a whole run only: a shard sees its own units).
  if (!shard) {
    const ran = new Set(kept.map(tabKey));
    for (const r of kept) for (const t of r.tabs ?? []) if (!ran.has(tabKey(t))) audit.problems.push({ kind: "RENDER_ERROR", view: unitName(t), detail: "The page lists this tab, but no shard audited it." });
  }
  // RENDER_AUDIT_JSON=<file>: everything drawn, each unit's cost and every problem, for working through them.
  if (process.env.RENDER_AUDIT_JSON) writeFileSync(process.env.RENDER_AUDIT_JSON, JSON.stringify({ units: kept.map(({ views: v, ...u }) => ({ ...u, views: v.length })), views, audit }, null, 1));
  // RENDER_AUDIT_COSTS=<file>: what each tab took (all its parts), to plan the next runs from (scripts/render-audit-costs.json).
  const costs: Cost[] = kept.map((r) => ({ route: r.route, tab: r.tab, ms: Math.round(r.ms / 100) * 100 }));
  if (process.env.RENDER_AUDIT_COSTS && !partial) writeCosts(process.env.RENDER_AUDIT_COSTS, costs);
  // This machine's own, beside the cache (a partial run updates the tabs it ran).
  if (LOCAL_COSTS && !shard) {
    const merged = new Map(readCosts(LOCAL_COSTS).map((c) => [tabKey(c), c]));
    for (const c of costs) merged.set(tabKey(c), c);
    try {
      writeCosts(LOCAL_COSTS, [...merged.values()]);
    } catch {
      /* the next run plans from CI's costs */
    }
  }
  const figures = views.reduce((n, v) => n + v.figures.length, 0);
  const opened = views.reduce((n, v) => n + (v.drawers?.length ?? 0), 0);
  const took = Math.max(...parts.map((p) => p.ms));
  console.log(`\nRendered ${views.length} views: ${figures} figures drawn, ${audit.drawn} of the sweep's ${audit.cleared} cleared figures among them; ${opened} proof drawers held to their proofs (${took}ms${parts.length > 1 ? `, the slowest of ${parts.length} shards` : ""}).`);
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
  const regions = Object.entries(audit.whatIf);
  if (regions.length) {
    console.log(`\n[WHAT-IF] Exploratory regions (kit WhatIf): their numbers are scenarios, held only to keep real data out:`);
    for (const [page, whys] of regions) console.log(`   ${page.padEnd(16)} ${String(Object.keys(whys).length).padStart(3)} region(s): ${Object.keys(whys).join("; ")}`);
  }
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
