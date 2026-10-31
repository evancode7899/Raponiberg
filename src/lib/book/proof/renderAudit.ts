import { differs, showValue, type SweepProblem } from "./clearance.ts";
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
 *  - RENDER_ERROR: a page that threw, or never settled.
 * And it lists every figure the sweep cleared that no page drew (`missing`: a recipe the
 * sweep holds that nothing shows, or one only a year picker or drill-down reaches); F6d
 * drives those views and makes it fail.
 */

export type RenderProblemKind = "RENDER_NOT_CLEARED" | "RENDER_TEXT" | "RENDER_WITHHELD" | "RENDER_BYPASS" | "RENDER_ERROR";
export type RenderProblem = { kind: RenderProblemKind; view: string; key?: string; detail: string };

/** One figure as drawn: ProofValue's data attributes and its visible text (marks left out). */
export type DrawnFigure = { key: string; shown: string; shownKind: "" | "cents" | "ratio" | "text"; perMonths: number | null; clearance: string; text: string; drawn?: string };

/** How a figure says it draws its value (ProofValue's drawn): words, or the number in other units rounded to a step. */
export function drawnOf(f: DrawnFigure): "words" | { per: number; step: number } {
  if (f.drawn === "words") return "words";
  const m = /^per:([\d.e+-]+);step:([\d.e+-]+)$/.exec(f.drawn ?? "");
  return m ? { per: Number(m[1]) || 1, step: Number(m[2]) } : { per: 1, step: 0 };
}

/** What one view (a page, one tab of it) drew. */
export type DrawnView = { view: string; figures: DrawnFigure[]; strays: string[]; errors: string[] };

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
  const read = drawn && { ...drawn, value: drawn.value * how.per, tol: Math.max(drawn.tol, how.step) * how.per };
  if (!read) return { ok: false, why: `"${f.text}" isn't one number` };
  const per = f.perMonths && f.perMonths > 1 ? f.perMonths : 1;
  // Whole dollars from cents round at the cent too; ratios get a hair of float slack.
  const want = f.shownKind === "cents" ? Number(f.shown) / per : Number(f.shown);
  const slack = read.tol + (f.shownKind === "cents" ? 0.005 : 1e-9);
  if (read.value === 0 && read.tol === 0) return Math.abs(want) < 0.005 ? { ok: true, why: "zero" } : { ok: false, why: `drawn as a dash, shows ${f.shown}` };
  if (Math.abs(read.value - want) <= slack) return { ok: true, why: "same" };
  // A page may draw a negative figure's size alone when its label says which way it went (Spent, Owed).
  if (Math.abs(Math.abs(read.value) - Math.abs(want)) <= slack) return { ok: true, why: "size" };
  return { ok: false, why: `draws "${f.text}" (${read.value}), shows ${want}${per > 1 ? ` (${f.shown} ÷ ${per} months)` : ""}` };
}

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
  "/forecast": "F6b",
  "/goals": "F6b",
  "/hsa": "F6b",
  "/net-worth": "F6b",
  "/outlook": "F6b",
  "/tax-accounts": "F6b",
  "/transactions": "F6b",
  "/car": "F6c",
  "/card-perks": "F6c",
  "/cash-flow": "F6c",
  "/fire": "F6c",
  "/home-budget": "F6c",
  "/investments": "F6c",
  "/mortgage": "F6c",
  "/statements": "F6c",
  "/taxes": "F6c",
};

/** The page a view is on: "/cash-flow › Trends" → "/cash-flow". */
export const pageOf = (view: string) => view.split(" › ")[0];

export type RenderAudit = {
  /** What fails the audit. */
  problems: RenderProblem[];
  /** Bypasses on pages BYPASS_PENDING lists: shown, not failed. */
  pending: RenderProblem[];
  /** Distinct cleared figures drawn, of the sweep's `cleared`. */
  drawn: number;
  cleared: number;
  /** Cleared figures no view drew (F6d holds pages to drawing them). */
  missing: string[];
};

/** Every problem in what the pages drew, held to the sweep; and how many cleared figures were drawn. */
export function auditRender(views: DrawnView[], sweep: SweepVerdicts, pendingPages: Readonly<Record<string, string>> = BYPASS_PENDING): RenderAudit {
  const all: RenderProblem[] = [];
  const problems: RenderProblem[] = [];
  const drawn = new Set<string>();
  for (const v of views) {
    for (const e of v.errors) all.push({ kind: "RENDER_ERROR", view: v.view, detail: e });
    for (const s of v.strays) all.push({ kind: "RENDER_BYPASS", view: v.view, detail: `"${s}" is drawn outside any figure: no proof holds it.` });
    for (const f of v.figures) {
      if (f.clearance === "cleared") {
        drawn.add(f.key);
        const cleared = sweep.cleared[f.key];
        const shown = shownValue(f);
        if (!cleared) all.push({ kind: "RENDER_NOT_CLEARED", view: v.view, key: f.key, detail: `Drawn as cleared, but the sweep never cleared it.` });
        else if (shown && differs(shown, cleared))
          all.push({ kind: "RENDER_NOT_CLEARED", view: v.view, key: f.key, detail: `Drawn as cleared at ${f.shown}; the sweep cleared ${showValue(cleared)}.` });
        const t = textMatches(f);
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
  for (const [page, stage] of Object.entries(pendingPages))
    if (audited.has(page) && !pending.some((p) => pageOf(p.view) === page))
      problems.push({ kind: "RENDER_BYPASS", view: page, detail: `Draws nothing outside its figures now: take it off BYPASS_PENDING (it waited for ${stage}), so a new bypass fails.` });
  const missing = Object.keys(sweep.cleared).filter((k) => !drawn.has(k));
  return { problems, pending, drawn: drawn.size, cleared: Object.keys(sweep.cleared).length, missing };
}
