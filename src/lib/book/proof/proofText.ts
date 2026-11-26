import { dateLabel } from "../../dates/display.ts";
import { EM_DASH, formatPercentRatio, formatUsdFromCents, NA } from "../../formatMoney.ts";
import type { Clearance } from "./clearance.ts";
import type { Proof, ProofBlock, ProofValue } from "./types.ts";
import { monthLabel } from "../../dates/display.ts";

/** What the proof answer adds about the last month-end (lib/restatements.ts, /api/proof). */
export type MonthEndNote = { month: string; takenAt: string; was: ProofValue | null; moved: boolean; why: { words: string; count: number }[] };

/** The month-end line, in words: unchanged, new since, or what it was and what changed. */
export function monthEndLine(m: MonthEndNote): string {
  const month = monthLabel(m.month);
  if (!m.moved) return `Unchanged since the ${month} month-end.`;
  if (!m.was) return `Not a cleared figure at the ${month} month-end.`;
  const why = m.why.map((w) => `${w.count.toLocaleString("en-US")} ${w.words}`).join(", ");
  return `At the ${month} month-end it was ${value(m.was)}${why ? `; since then: ${why}` : "; nothing in the audit log changed since, so a newer version of the app works it out differently"}.`;
}

const value = (v: ProofValue) => ("cents" in v ? formatUsdFromCents(Math.round(v.cents)) : "ratio" in v ? formatPercentRatio(v.ratio, 2) : v.text === EM_DASH ? NA : v.text);
const day = (iso: string) => dateLabel(iso);

const SOURCE_WORD: Record<string, string> = { proven: "proven", assumption: "your assumption", law: "tax law", estimate: "estimate", derived: "worked out" };
const CHECK_WORD: Record<string, string> = { passed: "passed", open: "OPEN", accepted: "accepted by you", none: "nothing in scope" };

function clearanceLine(c: Clearance): string {
  if (c.state === "cleared") return `Cleared by the proof sweep${c.basis === "estimate" ? ", resting on an estimate" : c.basis === "accepted" ? ", resting on an exception you accepted" : ""}.`;
  if (c.state === "verifying") return "Being checked: the proof sweep of this data is still running.";
  return `Withheld (${c.reason})${c.detail ? `: ${c.detail}` : "."}`;
}

function blockLines(b: ProofBlock): string[] {
  const out = [b.title.toUpperCase()];
  if (b.kind === "facts") for (const f of b.items) out.push(`  ${f.label}: ${f.text}`);
  else if (b.kind === "breakdown") for (const x of b.items) out.push(`  ${x.label}${x.sub ? ` (${x.sub})` : ""}\t${value(x.value)}`);
  else if (b.kind === "chain") for (const l of b.lines) out.push(`  ${l.op ?? " "} ${l.label} [${SOURCE_WORD[l.source] ?? l.source}]\t${value(l.value)}${l.note ? `\n      ${l.note}` : ""}`);
  else {
    out[0] += ` (${formatUsdFromCents(b.figureCents)}, ${b.groups.length} statement${b.groups.length === 1 ? "" : "s"})`;
    for (const g of b.groups) {
      out.push(`  ${g.statement.account}, statement ${day(g.statement.periodStart)} to ${day(g.statement.periodEnd)}\t${formatUsdFromCents(Math.round(g.subtotalCents))}`);
      for (const r of g.rows) out.push(`    ${day(r.date)}  ${r.payee || NA}\t${formatUsdFromCents(Math.round(r.countedCents))}`);
    }
  }
  if (b.note) out.push(`  (${b.note})`);
  return out;
}

/**
 * A proof as plain text, for the drawer's Copy: what the figure is, whether it was cleared,
 * how it adds up, the statements and checks behind it, and what's estimated. It says only
 * what the drawer shows (the same proof, the same formatting), so a pasted copy can be
 * checked against the app.
 */
export function proofText(p: Proof & { monthEnd?: MonthEndNote | null }, clearance?: Clearance | null): string {
  const lines: string[] = [p.describes, `${value(p.figure)}  (data through ${day(p.through)})`];
  if (clearance) lines.push(clearanceLine(clearance));
  if (p.selfCheck) lines.push(p.selfCheck.ok ? `${p.selfCheck.explain}: exactly the figure shown.` : `${p.selfCheck.explain}, ${formatUsdFromCents(p.selfCheck.deltaCents)} off the figure.`);
  if (p.rederived) {
    if ("none" in p.rederived) lines.push(`Not re-derived independently: ${p.rederived.none}`);
    else for (const r of p.rederived.routes) lines.push(`Re-derived by ${r.route}: ${value(r.value)}${r.ok ? "" : ` (DISAGREES with ${value(p.figure)})`}`);
  }
  if (p.withheld) lines.push("Part of this is withheld: an open finding covers it.");
  if (p.monthEnd) lines.push(monthEndLine(p.monthEnd));
  for (const b of p.blocks) lines.push("", ...blockLines(b));
  if (p.checks.length) {
    lines.push("", "CHECKS");
    for (const c of p.checks) lines.push(`  ${c.title}: ${CHECK_WORD[c.state] ?? c.state}${c.passed ? `, on ${c.passed}` : ""}${c.open.length ? `, ${c.open.length} open` : ""}`);
  }
  if (p.estimates.length) {
    lines.push("", "ESTIMATED PARTS");
    for (const e of p.estimates) lines.push(`  ${e.title}: ${e.detail}`);
  }
  return lines.join("\n");
}
