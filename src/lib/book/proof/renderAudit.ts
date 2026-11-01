import { differs, showValue, type SweepProblem } from "./clearance.ts";
import { clearedValue } from "./composite.ts";
import type { ProofValue } from "./types.ts";

/**
 * The render audit (SSOT F6): what the browser actually draws, held to the proof sweep.
 * Pure; scripts/render-audit.ts collects what each page draws (a headless browser on the
 * demo) and hands it here with the server's sweep report.
 *
 * What it holds every rendered page to:
 *  - RENDER_NOT_CLEARED: a figure drawn as cleared that the sweep never cleared, or cleared
 *    at another value than the page says it shows (the browser's clearance and the
 *    server's sweep disagree);
 *  - RENDER_TEXT: a cleared figure whose visible text isn't the value it says it shows
 *    (the page proves one number and draws another);
 *  - RENDER_WITHHELD: a figure withheld for a reason that is a bug on the demo (a mismatch,
 *    a flag, never swept, no sweep), or still "verifying…" once the page settled;
 *  - RENDER_BYPASS: money or a rate drawn outside any figure, or inside words that open a
 *    proof: it reached the page without one (mark text that truly isn't a figure, a form's
 *    own label, with data-not-figure). Pages still in BYPASS_PENDING are listed, not failed;
 *  - RENDER_DRAWER: a proof drawer draws money or a rate its proof (/api/proof) doesn't hold;
 *  - RENDER_ERROR: a page that threw, or never settled.
 *  - RENDER_UNDRAWN (F6d): a figure the sweep cleared that no view drew — a recipe nothing
 *    shows, or one only a view the audit can't reach. Families still in UNDRAWN_PENDING are
 *    listed, not failed, and the list only shrinks (a listed family drawn in full fails).
 */

export type RenderProblemKind = "RENDER_NOT_CLEARED" | "RENDER_TEXT" | "RENDER_WITHHELD" | "RENDER_BYPASS" | "RENDER_DRAWER" | "RENDER_UNDRAWN" | "RENDER_ERROR";
export type RenderProblem = { kind: RenderProblemKind; view: string; key?: string; detail: string };

/** One figure as drawn: ProofValue's data attributes and its visible text (marks left out). */
export type DrawnFigure = { key: string; shown: string; shownKind: "" | "cents" | "ratio" | "text"; perMonths: number | null; clearance: string; text: string; drawn?: string };

/** How a figure says it draws its value (ProofValue's drawn): words, or the number in other units rounded to a step. */
export function drawnOf(f: DrawnFigure): "words" | { per: number; step: number; zeroWithin: number | null } {
  if (f.drawn === "words") return "words";
  const m = /^per:([\d.e+-]+);step:([\d.e+-]+)(?:;zero:([\d.e+-]+))?$/.exec(f.drawn ?? "");
  const zero = m?.[3] != null && Number(m[3]) >= 0 ? Number(m[3]) : null;
  return m ? { per: Number(m[1]) || 1, step: Number(m[2]), zeroWithin: zero } : { per: 1, step: 0, zeroWithin: null };
}

/** What one view (a page, one tab of it) drew. */
export type DrawnView = {
  view: string;
  figures: DrawnFigure[];
  strays: string[];
  /** Money or rates a chart (SVG) labels: each must be a figure this view draws (a chart only pictures the figures beside it). */
  chart?: string[];
  errors: string[];
  /** Proof drawers opened from this view (F6e): the figure, and what the drawer drew that its proof doesn't hold. */
  drawers?: { key: string; strays: string[] }[];
};

/** The part of the sweep's report the audit reads. */
export type SweepVerdicts = { cleared: Record<string, ProofValue>; problems: Record<string, SweepProblem[]> };

/** Withheld for one of these is the app working: a finding blocks it, or there is nothing to show. */
const FINE_WITHHELD = new Set(["withheld:blocked", "withheld:no-figure"]);

/** Money or a rate in drawn text: "$1,234", "($5.2k)", "−$40", "6.5%". */
export const FIGURE_TEXT = /\$\s?\d|\d(?:[.,]\d+)*\s?%/;

/** A number as drawn, with how far the drawing may round it. */
export type Read = { value: number; tol: number; unit: "usd" | "pct" | "plain" };

const MULT: Record<string, number> = { k: 1e3, K: 1e3, M: 1e6, B: 1e9 };

/**
 * Reads a drawn number back: "$1,234.56", "($916.7k)", "+$1.24M", "−$4.1k", "6.5%", "12.3".
 * An em dash alone is zero (formatUsd draws zero as one). Null when the text holds no
 * number, or more than one.
 */
export function readDrawn(text: string): Read | null {
  const t = text.replace(/[\s ]+/g, " ").trim();
  if (/^[—–]$/.test(t)) return { value: 0, tol: 0, unit: "plain" };
  const all = [...t.matchAll(/([+\-−]?)\s?(\(?)\s?(\$?)\s?(\d[\d,]*(?:\.\d+)?)\s?([kKMB])?\)?\s?(%?)/g)];
  if (all.length !== 1) return null;
  const [, sign, paren, dollar, digits, suffix, pct] = all[0];
  const decimals = digits.includes(".") ? digits.split(".")[1].length : 0;
  const mult = suffix ? MULT[suffix] : 1;
  const neg = sign === "-" || sign === "−" || paren === "(" || /^\(.*\)$/.test(t);
  const value = Number(digits.replace(/,/g, "")) * mult * (neg ? -1 : 1);
  const tol = 0.5 * 10 ** -decimals * mult;
  if (pct) return { value: value / 100, tol: tol / 100, unit: "pct" };
  return { value, tol, unit: dollar ? "usd" : "plain" };
}

/** Whether a drawn figure's text is the value it says it shows (per month when the page divides it). */
export function textMatches(f: DrawnFigure): { ok: boolean; why: string } {
  const how = drawnOf(f);
  if (how === "words") return FIGURE_TEXT.test(f.text) ? { ok: false, why: `words that hold a number of their own: "${f.text}"` } : { ok: true, why: "words" };
  if (f.shownKind === "text" || f.shownKind === "") return { ok: true, why: "words" };
  const drawn = readDrawn(f.text);
  const per = f.perMonths && f.perMonths > 1 ? f.perMonths : 1;
  // Whole dollars from cents round at the cent too; ratios get a hair of float slack.
  const want = f.shownKind === "cents" ? Number(f.shown) / per : Number(f.shown);
  if (!drawn && how.zeroWithin != null && !FIGURE_TEXT.test(f.text))
    return Math.abs(want) <= how.zeroWithin * how.per + 0.005 ? { ok: true, why: "zero in words" } : { ok: false, why: `"${f.text}" stands for zero, shows ${f.shown}` };
  const read = drawn && { ...drawn, value: drawn.value * how.per, tol: Math.max(drawn.tol, how.step) * how.per };
  if (!read) return { ok: false, why: `"${f.text}" isn't one number` };
  const slack = read.tol + (f.shownKind === "cents" ? 0.005 : 1e-9);
  // A lone dash is zero, or what rounds to it drawn in whole dollars (a whole percent for a rate).
  if (read.value === 0 && read.tol === 0)
    return Math.abs(want) < (f.shownKind === "cents" ? 0.5 : 0.005) * how.per ? { ok: true, why: "zero" } : { ok: false, why: `drawn as a dash, shows ${f.shown}` };
  if (Math.abs(read.value - want) <= slack) return { ok: true, why: "same" };
  // A page may draw a negative figure's size alone when its label says which way it went (Spent, Owed).
  if (Math.abs(Math.abs(read.value) - Math.abs(want)) <= slack) return { ok: true, why: "size" };
  return { ok: false, why: `draws "${f.text}" (${read.value}), shows ${want}${per > 1 ? ` (${f.shown} ÷ ${per} months)` : ""}` };
}

/** A cleared value as a figure's data-shown would state it. */
const asShown = (v: ProofValue): Pick<DrawnFigure, "shown" | "shownKind"> =>
  "cents" in v ? { shown: (v.cents / 100).toFixed(2), shownKind: "cents" } : "ratio" in v ? { shown: String(v.ratio), shownKind: "ratio" } : { shown: v.text, shownKind: "text" };

/** The value a figure says it shows, as the sweep keeps values. */
function shownValue(f: DrawnFigure): ProofValue | null {
  if (f.shownKind === "cents") return { cents: Math.round(Number(f.shown) * 100) };
  if (f.shownKind === "ratio") return { ratio: Number(f.shown) };
  if (f.shownKind === "text") return { text: f.shown };
  return null;
}

/**
 * Pages that still draw money or rates outside any figure (F6a's inventory), and the stage
 * that holds them: their RENDER_BYPASS problems are listed on every run but don't fail it
 * yet. Every other page fails on its first one. Like unswept(why) in F3, it's a debt said
 * out loud: a page listed here that draws none fails, so the list only ever shrinks.
 */
export const BYPASS_PENDING: Readonly<Record<string, string>> = {
  "/": "F6b",
  "/annual": "F6b",
  "/bonuses": "F6b",
  "/goals": "F6b",
  "/hsa": "F6b",
  "/net-worth": "F6b",
  "/outlook": "F6b",
  "/tax-accounts": "F6b",
  "/car": "F6c",
  "/card-perks": "F6c",
  "/cash-flow": "F6c",
  "/fire": "F6c",
  "/home-budget": "F6c",
  "/investments": "F6c",
  "/mortgage": "F6c",
  "/taxes": "F6c",
};

/** A cleared figure's family: its report, page and figure (or metric, or line): "derived › taxes › worksheet". */
export function figureFamily(key: string): string {
  try {
    const d = JSON.parse(key) as Record<string, unknown>;
    return [d.report, d.page, d.figure ?? d.metric ?? d.line].filter((x) => typeof x === "string").join(" › ");
  } catch {
    return key;
  }
}

/**
 * Families of cleared figures some members of which no view draws yet (F6d): each sweeps
 * more members than the audit's views reach (every year, basis and filer of an estimate;
 * every granularity and period of a drill-down; every window of a cash-flow slice). Their
 * undrawn members are listed on every run, not failed; any other family fails on its first
 * undrawn figure, and a family listed here that draws every member fails too, so the list
 * only shrinks. The way off it: drive the view that draws them, or stop sweeping what no page shows.
 */
export const UNDRAWN_PENDING: Readonly<Record<string, string>> = {};

/** The page a view is on: "/cash-flow › Trends · Months shown=6M ▸ Dining" → "/cash-flow". */
export const pageOf = (view: string) => view.split(/ [›·▸] /)[0]!;

export type RenderAudit = {
  /** What fails the audit. */
  problems: RenderProblem[];
  /** Bypasses on pages BYPASS_PENDING lists: shown, not failed. */
  pending: RenderProblem[];
  /** Distinct cleared figures drawn, of the sweep's `cleared`. */
  drawn: number;
  cleared: number;
  /** Cleared figures no view drew: those of families UNDRAWN_PENDING lists are listed, the rest fail (RENDER_UNDRAWN). */
  missing: string[];
};

/** The tab a view is on: "/cash-flow › Merchants · Category=Dining ▸ Acme" → "/cash-flow › Merchants". */
export const tabOf = (view: string) => view.split(/ [·▸] /)[0]!;

/**
 * A chart's labels that are no figure its tab draws: each money or rate token a chart labels
 * must be the value of a cleared figure drawn on the same tab (`figures`: every figure the
 * tab drew, in any of its views), read back as drawn. A chart only pictures those figures.
 */
export function chartStrays(v: Pick<DrawnView, "chart">, figures: readonly DrawnFigure[], sweep: SweepVerdicts): string[] {
  const values = figures
    .filter((f) => f.clearance === "cleared")
    .map((f) => clearedValue(f.key, sweep.cleared))
    .flatMap((x) => (!x ? [] : "cents" in x ? [Math.abs(x.cents) / 100] : "ratio" in x ? [Math.abs(x.ratio)] : []));
  const out: string[] = [];
  for (const label of v.chart ?? [])
    for (const tok of label.match(FIGURE_TOKENS) ?? []) {
      const r = readDrawn(tok);
      if (!r || !values.some((x) => Math.abs(x - Math.abs(r.value)) <= r.tol + (r.unit === "pct" ? 1e-9 : 0.005))) out.push(tok);
    }
  return [...new Set(out)];
}

/** Every problem in what the pages drew, held to the sweep; and how many cleared figures were drawn. */
export function auditRender(views: DrawnView[], sweep: SweepVerdicts, pendingPages: Readonly<Record<string, string>> = BYPASS_PENDING, opts: { partial?: boolean; undrawnPending?: Readonly<Record<string, string>> } = {}): RenderAudit {
  const undrawnPending = opts.undrawnPending ?? UNDRAWN_PENDING;
  const all: RenderProblem[] = [];
  const problems: RenderProblem[] = [];
  const drawn = new Set<string>();
  const tabFigures = new Map<string, DrawnFigure[]>();
  for (const v of views) tabFigures.set(tabOf(v.view), [...(tabFigures.get(tabOf(v.view)) ?? []), ...v.figures]);
  for (const v of views) {
    for (const e of v.errors) all.push({ kind: "RENDER_ERROR", view: v.view, detail: e });
    for (const d of v.drawers ?? []) if (d.strays.length) all.push({ kind: "RENDER_DRAWER", view: v.view, key: d.key, detail: `Its proof drawer draws ${d.strays.map((x) => `"${x}"`).join(", ")}, which its proof doesn't hold.` });
    for (const s of v.strays) all.push({ kind: "RENDER_BYPASS", view: v.view, detail: `"${s}" is drawn outside any figure: no proof holds it.` });
    for (const s of chartStrays(v, tabFigures.get(tabOf(v.view)) ?? [], sweep)) all.push({ kind: "RENDER_BYPASS", view: v.view, detail: `A chart labels "${s}", which is no figure this view draws.` });
    for (const f of v.figures) {
      if (f.clearance === "cleared") {
        drawn.add(f.key);
        const cleared = clearedValue(f.key, sweep.cleared);
        const shown = shownValue(f);
        if (!cleared) all.push({ kind: "RENDER_NOT_CLEARED", view: v.view, key: f.key, detail: `Drawn as cleared, but the sweep never cleared it.` });
        // data-shown prints cents to two places: within a cent of the cleared value is the same figure.
        else if (shown && ("cents" in shown && "cents" in cleared ? Math.abs(shown.cents - cleared.cents) > 1 : differs(shown, cleared)))
          all.push({ kind: "RENDER_NOT_CLEARED", view: v.view, key: f.key, detail: `Drawn as cleared at ${f.shown}; the sweep cleared ${showValue(cleared)}.` });
        // A figure that states no value of its own (shownCents null) is held to the value the sweep cleared.
        const t = textMatches(f.shownKind || !cleared ? f : { ...f, ...asShown(cleared) });
        // Words that open a proof but hold a number of their own drew that number with no proof.
        if (!t.ok) all.push({ kind: drawnOf(f) === "words" ? "RENDER_BYPASS" : "RENDER_TEXT", view: v.view, key: f.key, detail: `The page proves one number and draws another: ${t.why}.` });
      } else if (!FINE_WITHHELD.has(f.clearance)) {
        const flagged = sweep.problems[f.key]?.map((p) => `${p.kind}: ${p.detail}`).join(" ");
        all.push({ kind: "RENDER_WITHHELD", view: v.view, key: f.key, detail: `Drawn ${f.clearance}${f.shown ? ` (shows ${f.shown})` : ""}${flagged ? `; the sweep: ${flagged}` : ""}.` });
      }
    }
  }
  const pending: RenderProblem[] = [];
  for (const p of all) (p.kind === "RENDER_BYPASS" && pendingPages[pageOf(p.view)] ? pending : problems).push(p);
  const audited = new Set(views.map((v) => pageOf(v.view)));
  // A partial run (some pages) can't tell a pending page is clean, nor which cleared figures no page draws.
  for (const [page, stage] of opts.partial ? [] : Object.entries(pendingPages))
    if (audited.has(page) && !pending.some((p) => pageOf(p.view) === page))
      problems.push({ kind: "RENDER_BYPASS", view: page, detail: `Draws nothing outside its figures now: take it off BYPASS_PENDING (it waited for ${stage}), so a new bypass fails.` });
  const missing = opts.partial ? [] : Object.keys(sweep.cleared).filter((k) => !drawn.has(k));
  // F6d: a cleared figure no view draws fails, unless its family is still listed as pending.
  const byFamily = new Map<string, string[]>();
  for (const k of missing) byFamily.set(figureFamily(k), [...(byFamily.get(figureFamily(k)) ?? []), k]);
  for (const [family, keys] of byFamily)
    if (!undrawnPending[family]) problems.push({ kind: "RENDER_UNDRAWN", view: family, key: keys[0], detail: `${keys.length} cleared figure(s) no view draws (first: ${keys[0]}): draw them, or stop sweeping what no page shows.` });
  if (!opts.partial)
    for (const [family, stage] of Object.entries(undrawnPending))
      if (!byFamily.has(family)) problems.push({ kind: "RENDER_UNDRAWN", view: family, detail: `Every cleared figure of it is drawn now: take it off UNDRAWN_PENDING (it waited for ${stage}), so a new undrawn one fails.` });
  return { problems, pending, drawn: drawn.size, cleared: Object.keys(sweep.cleared).length, missing };
}

/** Money and rates in drawn text, one by one: "$1,234", "(6.5%)", "−$4.1k". */
export const FIGURE_TOKENS = /[+\-−]?\(?\$\s?\d[\d,]*(?:\.\d+)?[kMB]?\)?|[+\-−]?\(?\d[\d,]*(?:\.\d+)?\s?%\)?/g;

/**
 * F6e: what a proof drawer draws, held to the proof the server answered (/api/proof). Every
 * money or rate token the drawer shows must be a value the proof holds: one of its numbers
 * (cents drawn as dollars, ratios as rates, per month when the page divides the figure), or
 * a token its own words print. Anything else the drawer worked out by itself, with no proof.
 * Returns the tokens that aren't.
 */
export function drawerStrays(tokens: readonly string[], proof: unknown, perMonths?: number | null): string[] {
  const values: number[] = [];
  const printed = new Set<string>();
  const squash = (s: string) => s.replace(/[\s ()+\-−]/g, "");
  const walk = (x: unknown) => {
    if (typeof x === "number" && Number.isFinite(x)) {
      values.push(Math.abs(x), Math.abs(x) / 100);
      if (perMonths && perMonths > 1) values.push(Math.abs(x) / 100 / perMonths);
    } else if (typeof x === "string") for (const m of x.matchAll(FIGURE_TOKENS)) printed.add(squash(m[0]));
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") Object.values(x).forEach(walk);
  };
  walk(proof);
  return tokens.filter((tok) => {
    if (printed.has(squash(tok))) return false;
    const r = readDrawn(tok);
    if (!r) return true;
    const v = Math.abs(r.value);
    const slack = r.tol + (r.unit === "pct" ? 1e-9 : 0.005);
    return !values.some((x) => Math.abs(x - v) <= slack);
  });
}
