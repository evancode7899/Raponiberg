/**
 * The federal flat rate an employer may withhold on supplemental wages (bonuses) up to
 * $1 million in a year: IRS Publication 15 (Circular E), section 7, "Supplemental Wages".
 * Over $1 million the rate is mandatory at the top rate; no household bonus here comes near.
 */
export const SUPPLEMENTAL_FEDERAL_RATE = 0.22;

export type BonusGapRow = BonusCheck & {
  /** What was (or will be) withheld: the stub's federal tax on an all-bonus check, else the supplemental rate. */
  withheldCents: number;
  withheldFrom: "STUB" | "SUPPLEMENTAL_RATE";
  /** The bonus at the year's federal rate on the next dollar. */
  atRateCents: number;
  /** At that rate less withheld: positive means the check leaves tax to pay at filing. */
  gapCents: number;
};

/** Each bonus check against the year's federal marginal rate (TaxReport.marginal.federal). */
export function bonusGaps(checks: readonly BonusCheck[], marginalFederal: number): BonusGapRow[] {
  return checks.map((b) => {
    const withheldCents = b.federalWithheldCents ?? Math.round(b.grossCents * SUPPLEMENTAL_FEDERAL_RATE);
    const atRateCents = Math.round(b.grossCents * marginalFederal);
    return { ...b, withheldCents, withheldFrom: b.federalWithheldCents != null ? "STUB" : "SUPPLEMENTAL_RATE", atRateCents, gapCents: atRateCents - withheldCents };
  });
}

/**
 * A bonus paycheck: its bonus pay, and the federal tax a stub withheld on it where the check
 * was all bonus (a combined check doesn't say how much of its withholding was the bonus's).
 * Bonuses still to come are the forecast's, withheld at the supplemental rate.
 */
export type BonusCheck = { payDate: string | null; label: string; grossCents: number; federalWithheldCents: number | null; source: "STUB" | "FORECAST" };

export function bonusChecksOf(stubs: readonly { payDate: string; lines: readonly { kind: string; current: number | null }[] }[], forecast: readonly { label: string; gross: number; date?: string | null }[]): BonusCheck[] {
  const paid = stubs.flatMap((s): BonusCheck[] => {
    const sum = (k: string) => s.lines.reduce((t, l) => t + (l.kind === k ? (l.current ?? 0) : 0), 0);
    const bonus = sum("BONUS");
    if (bonus <= 0) return [];
    const allBonus = s.lines.every((l) => l.kind !== "REGULAR" || !l.current);
    return [{ payDate: s.payDate, label: "Bonus on the stub", grossCents: bonus, federalWithheldCents: allBonus ? sum("FEDERAL_TAX") : null, source: "STUB" }];
  });
  paid.sort((a, b) => (a.payDate! < b.payDate! ? -1 : 1));
  return [...paid, ...forecast.filter((b) => b.gross > 0).map((b): BonusCheck => ({ payDate: b.date ?? null, label: b.label, grossCents: b.gross, federalWithheldCents: null, source: "FORECAST" }))];
}
