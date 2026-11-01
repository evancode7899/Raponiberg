import type { ProofValue } from "../book/proof/types.ts";
import type { TaxReport } from "./buildTaxReport.ts";
import { planW4, type W4Balance } from "./w4.ts";

/**
 * Taxes › W-4 as numbers, for each paycheck a new W-4 can first reach (the next, the one
 * after, two later): each return's walk from tax to balance, what the W-4s now and the new
 * ones leave, what no paycheck can take, and each person's lines and withholding per check.
 * Planned on the stubs on file alone: a latest stub received, which this browser keeps,
 * changes the plan and no sweep holds it. One pure function for the page and its proofs.
 */

export const W4_REACHES = ["0", "1", "2"] as const;
export type W4Reach = (typeof W4_REACHES)[number];

export type W4Cell = { row: string; col: string; describes: string; value: ProofValue };

/** The walk from the year's tax to the balance, as Reconcile lists it. */
export const W4_WALK = ["tax", "withheldStubs", "withheldSinceStub", "withheldTooSoon", "withheldReached", "withheldBonus", "withheldOther", "estimates", "otherCredits", "balanceNow", "change", "balanceAfter"] as const satisfies readonly (keyof W4Balance)[];

/** The W-4 lines the plan sets (the on-file ones are your entries, not figures). */
export const W4_LINES = ["credits", "extraPerPaycheck", "ctAdditional", "ctReduced", "federalPerCheck", "federalAfter", "ctPerCheck", "ctAfter"] as const;

export function w4Cells(r: TaxReport, reach: W4Reach): W4Cell[] {
  if (!r.isCurrentYear) return [];
  const plan = planW4(r, { tooSoonCount: Number(reach), paidThrough: {} });
  const out: W4Cell[] = [];
  for (const [col, b] of [["federal", plan.federal], ["ct", plan.ct]] as const) {
    for (const k of W4_WALK) out.push({ row: `walk:${k}`, col, describes: `W-4 plan (${col}): ${k}`, value: { cents: b[k] } });
    out.push({ row: "unreachable", col, describes: `W-4 plan (${col}): what no paycheck left can take`, value: { cents: plan.unreachable[col] } });
  }
  for (const p of plan.people) {
    const line = (row: (typeof W4_LINES)[number], cents: number) => out.push({ row: `line:${row}`, col: p.personId, describes: `${p.name}'s W-4 plan: ${row}`, value: { cents } });
    // A line the plan keeps reads "Keep": only the ones it changes are figures.
    if (p.recommended.credits !== p.onFile.credits) line("credits", p.recommended.credits);
    if (p.recommended.extraPerPaycheck !== p.onFile.extraPerPaycheck) line("extraPerPaycheck", p.recommended.extraPerPaycheck);
    if (p.recommended.ct.additional !== p.onFile.ct.additional) line("ctAdditional", p.recommended.ct.additional);
    if (p.recommended.ct.reduced !== p.onFile.ct.reduced) line("ctReduced", p.recommended.ct.reduced);
    line("federalPerCheck", p.federalPerCheck);
    line("federalAfter", p.federalPerCheck + p.federalChange);
    line("ctPerCheck", p.ctPerCheck);
    line("ctAfter", p.ctPerCheck + p.ctChange);
  }
  return out;
}
