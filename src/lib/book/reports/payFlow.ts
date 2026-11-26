import type { AnnualCashLine } from "../proof/annualProof.ts";
import type { YearProfile } from "../../profile/buildAnnualProfile.ts";

/**
 * Where a year's pay went, as the Annual report's statement adds it up: gross pay, other
 * income and employer money in; taxes and deductions, a partner's pay kept, living costs,
 * one-offs and what was saved out. The two sides are equal to the cent (the statement's own
 * waterfall), so a picture of it adds up. Each band is one of the statement's lines, with
 * its proof. Pure.
 */

export type FlowBand = { key: AnnualCashLine | "drawn"; label: string; cents: number };
export type PayFlow = {
  year: number;
  asOf: string;
  /** In: salary, bonus, other income, employer money (and savings drawn on, in a year that spent more than came in). */
  inflows: FlowBand[];
  /** Out: taxes and deductions, a partner's pay kept, living, one-offs, saved. */
  outflows: FlowBand[];
  /** Either side's total. */
  totalCents: number;
  /** Gross pay and other income: what "$100 of gross" is a hundredth of. */
  grossCents: number;
};

export function payFlow(y: Pick<YearProfile, "year" | "asOf" | "cash">): PayFlow | null {
  const w = y.cash?.waterfall;
  if (!w || w.grossCash <= 0) return null;
  const taxes = w.withholding + w.additionalTaxes - w.refunds + w.otherDeductions;
  const ins: FlowBand[] = [
    { key: "salary", label: "Salary", cents: w.salary },
    { key: "bonus", label: "Bonus", cents: w.bonus },
    { key: "other-income", label: "Interest & other", cents: w.otherIncome },
    { key: "employer", label: "Employer 401(k) & HSA", cents: w.employer },
  ];
  const outs: FlowBand[] = [
    { key: "taxes-deductions", label: "Taxes & deductions", cents: taxes },
    { key: "partner-kept", label: "Partner's pay kept", cents: w.partnerKept },
    { key: "living", label: "Living", cents: w.living },
    { key: "one-offs", label: "One-offs", cents: w.nonRecurring },
    { key: "saved", label: "Saved", cents: w.saved },
  ];
  // A side that went the other way (refunds above taxes, more spent than came in) moves across, so every band is positive.
  const inflows = ins.filter((b) => b.cents > 0);
  const outflows = outs.filter((b) => b.cents > 0);
  for (const b of outs) if (b.cents < 0) inflows.push(b.key === "saved" ? { key: "drawn", label: "Drawn from savings", cents: -b.cents } : { ...b, cents: -b.cents });
  for (const b of ins) if (b.cents < 0) outflows.push({ ...b, cents: -b.cents });
  const totalCents = inflows.reduce((s, b) => s + b.cents, 0);
  return { year: y.year, asOf: y.asOf, inflows, outflows, totalCents, grossCents: w.grossCash };
}

/** What a band is per $100 of gross: its share of gross pay and other income. */
export const per100 = (f: Pick<PayFlow, "grossCents">, cents: number) => cents / f.grossCents;
