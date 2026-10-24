import { allTaxes, computeReturn, type Dependent, type NyFiling, type PersonIncome, type ReturnResult } from "./computeReturn.ts";
import type { TaxYearParams } from "./params.ts";

/**
 * Filing scenarios built from the same per-person inputs. Pure (no database, no Node
 * APIs), so the server report and the browser's live worksheet compute identically.
 */

export type MfsResult = {
  claimant: string;
  itemize: boolean;
  returns: Record<string, ReturnResult>;
  totalTax: number;
  federalTax: number;
  ctTax: number;
  nyTax: number;
  balanceDue: { federal: number; ct: number; ny: number };
};

/**
 * Married filing separately: each spouse files alone. Tries both itemizing choices
 * (they must match) and, unless pinned, which spouse claims the dependents; keeps the
 * cheapest combination.
 */
export function bestSeparate(params: TaxYearParams, incomes: PersonIncome[], dependents: Dependent[], pinned: string, ny: NyFiling | null = null): MfsResult {
  const claimants = dependents.length === 0 ? [incomes[0]!.id] : pinned !== "AUTO" && incomes.some((i) => i.id === pinned) ? [pinned] : incomes.map((i) => i.id);
  let best: MfsResult | null = null;
  for (const claimant of claimants) {
    for (const itemize of [false, true]) {
      const returns: Record<string, ReturnResult> = {};
      for (const i of incomes) {
        returns[i.id] = computeReturn({
          params,
          filingStatus: "MFS",
          people: [i],
          dependents: i.id === claimant ? dependents : [],
          ny,
          itemizeMode: itemize ? "ITEMIZE" : "STANDARD",
        });
      }
      const rs = Object.values(returns);
      const r: MfsResult = {
        claimant,
        itemize,
        returns,
        totalTax: rs.reduce((s, x) => s + allTaxes(x), 0),
        federalTax: rs.reduce((s, x) => s + x.federal.totalTax - x.federal.refundableChildCredit, 0),
        ctTax: rs.reduce((s, x) => s + x.ct.totalTax, 0),
        nyTax: rs.reduce((s, x) => s + (x.ny?.totalTax ?? 0), 0),
        balanceDue: {
          federal: rs.reduce((s, x) => s + x.federal.balanceDue, 0),
          ct: rs.reduce((s, x) => s + x.ct.balanceDue, 0),
          ny: rs.reduce((s, x) => s + (x.ny?.balanceDue ?? 0), 0),
        },
      };
      if (!best || r.totalTax < best.totalTax) best = r;
    }
  }
  return best!;
}

/** Hypothetical changes layered on top of the statements, for the worksheet. All cents. */
export type WhatIf = {
  /** Per person: extra gross wages/bonus (withheld at supplemental rates) and extra pre-tax 401(k). */
  people: Record<string, { extraWages: number; extraPretax401k: number }>;
  extraShortTermGain: number;
  extraLongTermGain: number;
  extraCharitable: number;
};

export const NO_WHAT_IF: WhatIf = { people: {}, extraShortTermGain: 0, extraLongTermGain: 0, extraCharitable: 0 };

export function hasWhatIf(w: WhatIf): boolean {
  return (
    w.extraShortTermGain !== 0 ||
    w.extraLongTermGain !== 0 ||
    w.extraCharitable !== 0 ||
    Object.values(w.people).some((p) => p.extraWages !== 0 || p.extraPretax401k !== 0)
  );
}

/**
 * Applies a what-if to the per-person inputs. Extra wages are withheld the way a bonus
 * is (22% federal, 6.99% CT, Social Security up to the wage base, Medicare with the 0.9%
 * employer surtax over $200k); extra pre-tax 401(k) lowers box 1 but not box 5.
 * Household-level changes (gains, charity) land on the first person, which is what a
 * joint return sees; separate returns would split them by ownership.
 */
export function applyWhatIf(incomes: PersonIncome[], w: WhatIf, params: TaxYearParams): PersonIncome[] {
  const fp = params.federal;
  return incomes.map((inc, idx) => {
    const p = w.people[inc.id];
    let next: PersonIncome = { ...inc, w2s: inc.w2s.map((x) => ({ ...x })) };
    if (p && (p.extraWages || p.extraPretax401k)) {
      if (!next.w2s.length) {
        next.w2s.push({
          employer: "What-if wages",
          grossPay: 0,
          box1Wages: 0,
          box3SsWages: 0,
          box5MedicareWages: 0,
          box16StateWages: 0,
          federalWithheld: 0,
          ssWithheld: 0,
          medicareWithheld: 0,
          stateWithheld: 0,
        });
      }
      const w2 = next.w2s[0]!;
      const box5Before = next.w2s.reduce((s, x) => s + x.box5MedicareWages, 0);
      const ssRoom = Math.max(0, fp.socialSecurity.wageBase - w2.box3SsWages);
      const ssAdd = Math.min(ssRoom, Math.max(0, p.extraWages));
      const medicareOn = (wages: number) => wages * fp.medicareRate + Math.max(0, wages - 20_000_000) * fp.additionalMedicareRate;
      w2.grossPay += p.extraWages;
      w2.box5MedicareWages += p.extraWages;
      w2.box3SsWages += ssAdd;
      w2.box1Wages += p.extraWages - p.extraPretax401k;
      w2.box16StateWages += p.extraWages - p.extraPretax401k;
      w2.federalWithheld += Math.round(Math.max(0, p.extraWages) * 0.22);
      w2.stateWithheld += Math.round(Math.max(0, p.extraWages) * 0.0699);
      w2.ssWithheld += Math.round(ssAdd * fp.socialSecurity.rate);
      w2.medicareWithheld += Math.round(medicareOn(box5Before + p.extraWages) - medicareOn(box5Before));
    }
    if (idx === 0) {
      next = {
        ...next,
        shortTermGain: next.shortTermGain + w.extraShortTermGain,
        longTermGain: next.longTermGain + w.extraLongTermGain,
        charitableCash: next.charitableCash + w.extraCharitable,
      };
    }
    return next;
  });
}
