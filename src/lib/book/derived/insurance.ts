import { overviewPolicies, paidInYear, type AutoView, type CoverPayment, type HomeView } from "../../insurance/cover.ts";
import type { InsurancePage } from "../../insurance/page.ts";
import type { PolicyView } from "../../insurance/report.ts";
import type { Coverage } from "../../insurance/types.ts";
import { c, ln, r, t, type DerivedFigure } from "./types.ts";

/**
 * Insurance: each policy's figures, read off the insurer's own documents and the premiums
 * found in the statements. Life (key: the policy number): face, premiums, the renewal
 * schedule. Home and auto (keys start with the policy number): the declarations' limits,
 * deductibles and premiums, and the premiums paid this term. Overview: a year of cover
 * across every policy, and the premiums paid in the year to the statements' proven date.
 */
export type InsuranceInput = Pick<InsurancePage, "policies" | "homes" | "autos" | "through">;

export function insuranceDerived(page: InsuranceInput): DerivedFigure[] {
  return [...lifeDerived(page.policies), ...page.homes.flatMap(homeDerived), ...page.autos.flatMap(autoDerived), ...overviewDerived(page)];
}

/** The figures of one coverage's limit on a declarations page, as printed. */
export const limitKey = (policyNumber: string, group: string, i: number) => `${policyNumber}|${group}${i}`;

function paidFigure(figure: string, key: string, describes: string, payments: CoverPayment[], term: string): DerivedFigure {
  const mine = payments.filter((x) => x.term === term);
  const total = mine.reduce((s, x) => s + x.cents, 0);
  return {
    figure,
    key,
    describes,
    value: c(total),
    lines: [...mine.map((x, i) => ln(x.date, c(x.cents), i ? "+" : undefined, { source: "proven", link: { label: `${x.payee}, ${x.date}`, descriptor: { report: "row", rowId: x.rowId } } })), ln("Paid this term", c(total), "=")],
  };
}

function termFigures(line: string, v: HomeView | AutoView): DerivedFigure[] {
  const pn = v.policy.policyNumber;
  return v.terms.map((x) => ({
    figure: "term-premium",
    key: `${line}|${pn}|${x.start}`,
    describes: `Policy ${pn}: premium for the term from ${x.start}`,
    value: c(x.premiumCents),
    lines: [ln(x.from === "DECLARATIONS" ? `Term premium, as the declarations print it (${x.file})` : `Prior premium, as the renewal letter prints it (${x.file})`, c(x.premiumCents), undefined, { source: "proven" })],
  }));
}

const limitFigures = (pn: string, group: string, list: Coverage[], what: string): DerivedFigure[] =>
  list.map((x, i) => ({
    figure: "limit",
    key: limitKey(pn, group, i),
    describes: `Policy ${pn}: ${what} ${x.name}${x.per ? ` (${x.per})` : ""}`,
    value: t(x.limit),
    lines: [ln(`${x.name}, as the declarations print it`, t(x.limit), undefined, { source: "proven" })],
  }));

function homeDerived(v: HomeView): DerivedFigure[] {
  const p = v.policy;
  const pn = p.policyNumber;
  return [
    { figure: "home-premium", key: pn, describes: `Policy ${pn}: premium for the term`, value: c(p.totalPremiumCents), lines: [ln("Total premium, as the declarations print it", c(p.totalPremiumCents), undefined, { source: "proven" })] },
    ...limitFigures(pn, "P", p.property, "property coverage"),
    ...limitFigures(pn, "L", p.liability, "liability coverage"),
    ...p.deductibles.map((d, i) => ({ figure: "limit", key: limitKey(pn, "D", i), describes: `Policy ${pn}: deductible, ${d.name}`, value: t(d.text), lines: [ln(`${d.name} deductible, as the declarations print it`, t(d.text), undefined, { source: "proven" })] })),
    paidFigure("paid-term", pn, `Policy ${pn}: premiums paid toward this term, found in the statements`, v.payments, p.periodStart),
    ...termFigures("HOME", v),
  ];
}

function autoDerived(v: AutoView): DerivedFigure[] {
  const p = v.policy;
  const pn = p.policyNumber;
  const r = v.renewal?.renewal;
  return [
    { figure: "auto-premium", key: pn, describes: `Policy ${pn}: premium for the ${p.termMonths}-month term`, value: c(p.termPremiumCents), lines: [ln(`Total ${p.termMonths}-month premium, as the declarations print it`, c(p.termPremiumCents), undefined, { source: "proven" })] },
    ...limitFigures(pn, "C", p.coverages, "coverage"),
    ...p.coverages.flatMap((x, i) =>
      x.premiumCents.flatMap((cents, j) =>
        cents == null ? [] : [{ figure: "coverage-premium", key: `${pn}|${i}|${j}`, describes: `Policy ${pn}: ${x.name} premium, vehicle ${j + 1}`, value: c(cents), lines: [ln(`${x.name}, vehicle ${j + 1}, as the declarations print it`, c(cents), undefined, { source: "proven" })] }],
      ),
    ),
    ...p.discounts.flatMap((d, i) => (d.cents == null ? [] : [{ figure: "discount", key: `${pn}|${i}`, describes: `Policy ${pn}: ${d.name} discount`, value: c(d.cents), lines: [ln(`${d.name}, as the declarations print it`, c(d.cents), undefined, { source: "proven" })] }])),
    {
      figure: "discount-total",
      key: pn,
      describes: `Policy ${pn}: discounts in the term premium`,
      value: p.discountTotalCents == null ? null : c(p.discountTotalCents),
      lines: p.discountTotalCents == null ? [] : [ln("Total value of the discounts, as the declarations print it", c(p.discountTotalCents), undefined, { source: "proven" })],
    },
    {
      figure: "renewal-change",
      key: pn,
      describes: `Policy ${pn}: the renewal's premium against the term it renews`,
      value: r?.priorPremiumCents != null ? c(r.newPremiumCents - r.priorPremiumCents) : null,
      lines:
        r?.priorPremiumCents != null
          ? [ln("New premium, per the renewal letter", c(r.newPremiumCents), undefined, { source: "proven" }), ln("Prior premium, per the renewal letter", c(r.priorPremiumCents), "−", { source: "proven" }), ln("Change", c(r.newPremiumCents - r.priorPremiumCents), "=")]
          : [],
    },
    paidFigure("paid-term", pn, `Policy ${pn}: premiums paid toward this term, found in the statements`, v.payments, p.periodStart),
    ...termFigures("AUTO", v),
  ];
}

function overviewDerived(page: InsuranceInput): DerivedFigure[] {
  const all = overviewPolicies(page.policies, { homes: page.homes, autos: page.autos });
  const term = (key: string) => [...page.homes, ...page.autos].find((v) => v.policy.policyNumber === key);
  const annual = all.map((p): DerivedFigure => {
    const v = p.line === "LIFE" ? null : term(p.key);
    const months = v ? ("termMonths" in v.policy ? v.policy.termMonths : null) : null;
    const premium = v ? ("termPremiumCents" in v.policy ? v.policy.termPremiumCents : v.policy.totalPremiumCents) : null;
    return {
      figure: "annual",
      key: `${p.line}|${p.key}`,
      describes: `Policy ${p.policyNumber}: a year of cover at the current rate`,
      value: p.annualCents == null ? null : c(p.annualCents),
      lines:
        p.annualCents == null
          ? []
          : v && premium != null && months && months !== 12
            ? [ln(`Premium for the ${months}-month term, as the declarations print it`, c(premium), undefined, { source: "proven" }), ln(`× 12 / ${months} months`, t(`${12 / months}`), "×"), ln("A year of cover", c(p.annualCents), "=")]
            : [ln(p.line === "LIFE" ? "This policy year's premium, as the policy's schedule prints it" : "Premium for the year's term, as the declarations print it", c(p.annualCents), undefined, { source: "proven" })],
    };
  });
  const counted = all.filter((p) => p.annualCents != null);
  const total = counted.reduce((s, p) => s + p.annualCents!, 0);
  const paid = paidInYear(all, page.through);
  const paidTotal = paid.reduce((s, x) => s + x.cents, 0);
  const lifeCover = page.policies.filter((v) => v.status === "IN_FORCE");
  const faceTotal = lifeCover.reduce((s, v) => s + (v.faceNowCents ?? v.policy.faceCents), 0);
  return [
    ...annual,
    {
      figure: "annual-total",
      describes: "A year of cover across every policy in force, at each one's current rate",
      value: counted.length ? c(total) : null,
      lines: [...counted.map((p, i) => ln(`${p.insurer} ${p.policyNumber}`, c(p.annualCents!), i ? "+" : undefined)), ln("A year of cover", c(total), "=")],
      parts: counted.map((p) => ({ label: `${p.insurer} ${p.policyNumber}`, value: c(p.annualCents!), sub: p.line.toLowerCase() })),
    },
    {
      figure: "paid-year",
      describes: `Premiums paid to the insurers in the year through ${page.through}, found in the statements`,
      // With no policy on file the Overview shows its empty state, not a zero: no figure to sweep.
      value: all.length ? c(paidTotal) : null,
      lines: [...paid.map((x, i) => ln(`${x.date} · ${x.insurer}`, c(x.cents), i ? "+" : undefined, { source: "proven", link: { label: `${x.insurer}, ${x.date}`, descriptor: { report: "row", rowId: x.rowId } } })), ln("Paid in the year", c(paidTotal), "=")],
    },
    {
      figure: "life-cover",
      describes: "Life cover in force: every policy's death benefit today",
      value: lifeCover.length ? c(faceTotal) : null,
      lines: [...lifeCover.map((v, i) => ln(`Policy ${v.policy.policyNumber}`, c(v.faceNowCents ?? v.policy.faceCents), i ? "+" : undefined, { source: "proven" })), ln("Life cover", c(faceTotal), "=")],
    },
  ];
}

/** Life: each term policy's figures (key: the policy number), from its packet and the premiums in the statements. */
function lifeDerived(views: PolicyView[]): DerivedFigure[] {
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
      add("per1000", "annual premium per $1,000 of cover", c(Math.round(v.per1000Cents)), [ln("Annual premium", c(p.annualPremiumCents), undefined, { source: "proven" }), ln("÷ face amount, in thousands", t(String(p.faceCents / 100_000)), "÷"), ln("Per $1,000", c(Math.round(v.per1000Cents)), "=")]),
      add("policy-fee", "policy fee in the premium", p.policyFeeCents ? c(p.policyFeeCents) : null, p.policyFeeCents ? [ln("Policy fee, as the policy prints it", c(p.policyFeeCents), undefined, { source: "proven" })] : []),
      ...lifeTables(v),
    ];
  });
}

/** Life tables, row by row (key: the policy number, then the row): the schedule's years, the payment modes, the insurer's notices and receipts. */
function lifeTables(v: PolicyView): DerivedFigure[] {
  const pn = v.policy.policyNumber;
  const row = (figure: string, k: string, describes: string, value: DerivedFigure["value"], lines: DerivedFigure["lines"]): DerivedFigure => ({ figure, key: `${pn}|${k}`, describes: `Policy ${pn}: ${describes}`, value, lines });
  const printed = (label: string, cents: number) => [ln(label, c(cents), undefined, { source: "proven" })];
  return [
    ...v.years.flatMap((y) => {
      const per = Math.round((y.maxPremiumCents * 100_000) / y.faceCents);
      return [
        row("year-premium", String(y.year), `${y.level ? "premium" : "maximum premium"}, policy year ${y.year}`, c(y.maxPremiumCents), printed(`Year ${y.year}, as the table of premiums prints it`, y.maxPremiumCents)),
        row("year-face", String(y.year), `face amount, policy year ${y.year}`, c(y.faceCents), printed(`Year ${y.year}, as the schedule prints it`, y.faceCents)),
        row("year-per1000", String(y.year), `premium per $1,000 of cover, policy year ${y.year}`, c(per), [
          ln(`Year ${y.year} premium`, c(y.maxPremiumCents), undefined, { source: "proven" }),
          ln("÷ face amount, in thousands", t(String(y.faceCents / 100_000)), "÷"),
          ln("Per $1,000", c(per), "="),
        ]),
      ];
    }),
    ...v.modes.flatMap((m) => [
      row("mode-each", m.mode, `each ${m.mode.toLowerCase()} payment`, c(m.perPaymentCents), printed(`${m.mode} payment, as the contract's modal factors give it`, m.perPaymentCents)),
      row("mode-year", m.mode, `a year paid ${m.mode.toLowerCase()}`, c(m.yearCents), [ln(`${m.mode} payment`, c(m.perPaymentCents), undefined, { source: "proven" }), ln("× payments a year", t(String(m.payments)), "×"), ln("A year", c(m.yearCents), "=")]),
      ...(m.extraCents
        ? [
            row("mode-extra", m.mode, `extra a year paid ${m.mode.toLowerCase()}`, c(m.extraCents), [ln("A year", c(m.yearCents)), ln("− annual premium", c(v.policy.annualPremiumCents), "−", { source: "proven" }), ln("Extra", c(m.extraCents), "=")]),
            row("mode-extra-share", m.mode, `extra paid ${m.mode.toLowerCase()}, as a share of the annual premium`, r(m.extraCents / v.policy.annualPremiumCents), [ln("Extra", c(m.extraCents)), ln("÷ annual premium", c(v.policy.annualPremiumCents), "÷", { source: "proven" }), ln("Share", r(m.extraCents / v.policy.annualPremiumCents), "=")]),
          ]
        : []),
    ]),
    ...v.bills.map((b) => row("bill", b.file, `premium notice due ${b.dueDate}`, c(b.premiumCents), printed(`Due ${b.dueDate}, as the notice prints it`, b.premiumCents))),
    ...v.receipts.map((x) => row("receipt", x.file, `payment confirmed ${x.date}`, c(x.cents), printed(`Paid ${x.date}, as the confirmation prints it`, x.cents))),
  ];
}
