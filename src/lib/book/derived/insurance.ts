import type { PolicyView } from "../../insurance/report.ts";
import { c, ln, t, type DerivedFigure } from "./types.ts";

/**
 * Insurance: each term policy's figures (key: the policy number), read off the insurer's own
 * packet (face, premiums, the renewal schedule) and the premiums found in the statements.
 */
export function insuranceDerived(views: PolicyView[]): DerivedFigure[] {
  return views.flatMap((v) => {
    const p = v.policy;
    const key = p.policyNumber;
    const add = (figure: string, describes: string, value: DerivedFigure["value"], lines: DerivedFigure["lines"], parts?: DerivedFigure["parts"]): DerivedFigure => ({ figure, key, describes: `Policy ${key}: ${describes}`, value, lines, ...(parts ? { parts } : {}) });
    const renewal = v.years.filter((y) => !y.level);
    const first = renewal[0];
    const last = renewal.at(-1);
    const paidYears = new Set(v.payments.map((x) => x.year));
    const dueSoFar = v.years.filter((y) => v.currentYear != null && y.year <= v.currentYear);
    return [
      add("death-benefit", "death benefit today", c(v.faceNowCents ?? p.faceCents), [ln(v.faceNowCents != null ? `Face amount in policy year ${v.currentYear}` : "Face amount", c(v.faceNowCents ?? p.faceCents), undefined, { source: "proven", note: "As the policy's schedule prints it." })]),
      add("premium", "annual premium", c(p.annualPremiumCents), [ln("Annual premium, as the policy prints it", c(p.annualPremiumCents), undefined, { source: "proven" })]),
      add("level-end", "level term ends", p.levelEndDate ? t(p.levelEndDate) : null, [ln("Level term ends", t(p.levelEndDate ?? "—"), undefined, { source: "proven" })]),
      add("level-total", "total premiums over the level term", v.levelTotalCents == null ? null : c(v.levelTotalCents), v.levelTotalCents == null ? [] : [ln("Annual premium", c(p.annualPremiumCents), undefined, { source: "proven" }), ln("× level years", t(String(p.levelYears)), "×"), ln("Total premiums", c(v.levelTotalCents), "=")]),
      add("face", "coverage over the level term", c(p.faceCents), [ln("Face amount", c(p.faceCents), undefined, { source: "proven" })]),
      add("face-after", "coverage once it renews yearly", first ? c(first.faceCents) : null, first ? [ln(`Face amount from year ${first.year}`, c(first.faceCents), undefined, { source: "proven" })] : []),
      add("max-premium-last", "maximum premium in the schedule's last year", last ? c(last.maxPremiumCents) : null, last ? [ln(`Guaranteed maximum, year ${last.year}`, c(last.maxPremiumCents), undefined, { source: "proven" })] : []),
      add(
        "paid",
        "premiums paid so far, found in the statements",
        c(v.paidCents),
        [...v.payments.map((x, i) => ln(`${x.date} (year ${x.year})`, c(x.cents), i ? "+" : undefined, { source: "proven", link: { label: `${x.payee}, ${x.date}`, descriptor: { report: "row", rowId: x.rowId } } })), ln("Paid so far", c(v.paidCents), "=")],
      ),
      add("years-paid", "policy years paid of those started", t(`${dueSoFar.filter((y) => paidYears.has(y.year)).length} of ${dueSoFar.length}`), [ln("Years with a premium found", t(String(dueSoFar.filter((y) => paidYears.has(y.year)).length))), ln("Policy years started", t(String(dueSoFar.length)))]),
      add("next-due", "next premium", v.nextDue ? c(v.nextDue.cents) : null, v.nextDue ? [ln(`Due ${v.nextDue.date} (year ${v.nextDue.year})`, c(v.nextDue.cents), undefined, { source: "proven" })] : []),
      add("paid-to", "paid to, per the insurer", v.paidTo ? t(v.paidTo.date) : null, v.paidTo ? [ln(`Policy summary of ${v.paidTo.asOf}`, t(v.paidTo.date), undefined, { source: "proven" })] : []),
    ];
  });
}
