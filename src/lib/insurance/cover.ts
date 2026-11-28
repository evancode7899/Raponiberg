import { addDays } from "../dates/isoDate.ts";
import type { PolicyView, PremiumRow } from "./report.ts";
import type { AutoPolicy, AutoRenewal, PolicyForm, PropertyPolicy } from "./types.ts";

/**
 * Home and auto cover: each policy's latest declarations (the term in force, or the last
 * one on file), the earlier terms on file, and the premiums found in the statements, each
 * counted toward the term it paid for. As with life, the declarations are the contract and
 * the statements are the money: nothing here is estimated.
 */

/** Who a premium is paid to, as card and bank statements print it, by insurer. */
const COVER_PAYEES: { insurer: RegExp; payee: RegExp }[] = [
  { insurer: /State ?Farm/i, payee: /STATE ?FARM/i },
  { insurer: /GEICO|Government Employees/i, payee: /\bGEICO\b/i },
  // Progressive writes its home policies through its ASI group (American Strategic Insurance).
  { insurer: /Progressive|American Strategic/i, payee: /\bPROGRESSIVE\b|AMERICAN STRATEGIC/i },
];
const payeeOf = (insurer: string) => COVER_PAYEES.find((x) => x.insurer.test(insurer))?.payee ?? null;
/** Same insurer group ("GEICO" on a notice, "GEICO Secure Insurance Company" on the declarations). */
const sameInsurer = (a: string, b: string) => COVER_PAYEES.some((x) => x.insurer.test(a) && x.insurer.test(b)) || a === b;

/** A monthly installment can be drawn this many days before the term it pays for starts. */
const PAID_AHEAD_DAYS = 15;
/** A term paid in full can be charged when it's bought, this many days before it starts: only a charge of exactly its premium counts. */
const PAID_IN_FULL_AHEAD_DAYS = 60;

export type CoverStatus = "NOT_STARTED" | "IN_FORCE" | "ENDED";

/** A term of the policy on file: from its declarations, or (the one before) from a renewal letter. */
export type CoverTerm = { start: string; end: string; premiumCents: number; months: number | null; file: string; from: "DECLARATIONS" | "RENEWAL_LETTER" };

export type CoverPayment = { rowId: string; date: string; cents: number; payee: string; accountId: string; /** The term's start date, or null before every term on file. */ term: string | null };

type CoverBase = {
  file: string;
  status: CoverStatus;
  /** Every term on file, newest first; the first is the declarations shown. */
  terms: CoverTerm[];
  payments: CoverPayment[];
  /** Paid toward the term shown, per the statements. */
  paidTermCents: number;
  /** The packet's other pages (the contract, notices). */
  forms: { file: string; code: string | null; title: string }[];
  /** The premium for a year of cover at this term's rate (a six-month term counts twice). */
  annualCents: number;
  /** A later policy (another insurer's, or a new one) covers the same car or home from this date: this one ends then. */
  replacedBy: { insurer: string; policyNumber: string; date: string } | null;
  /** The day cover ends: the term's end, or the day the policy replacing it starts. */
  ends: string;
};

export type HomeView = CoverBase & { policy: PropertyPolicy };
export type AutoView = CoverBase & { policy: AutoPolicy; renewal: { file: string; renewal: AutoRenewal } | null };

export type CoverReport = { homes: HomeView[]; autos: AutoView[] };

const statusOf = (start: string, end: string, today: string): CoverStatus => (today < start ? "NOT_STARTED" : today >= end ? "ENDED" : "IN_FORCE");
const perYear = (cents: number, months: number | null) => (months ? Math.round((cents * 12) / months) : cents);
/** The same day `n` months earlier. */
function monthsBefore(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

/** The latest declarations per policy number; the older ones become its earlier terms. */
function latest<P extends { policyNumber: string; periodStart: string }>(docs: { file: string; policy: P }[]) {
  const byNumber = new Map<string, { file: string; policy: P }[]>();
  for (const d of docs) byNumber.set(d.policy.policyNumber, [...(byNumber.get(d.policy.policyNumber) ?? []), d]);
  return [...byNumber.values()].map((all) => {
    const sorted = all.filter((d, i) => all.findIndex((x) => x.policy.periodStart === d.policy.periodStart) === i).sort((a, b) => b.policy.periodStart.localeCompare(a.policy.periodStart));
    return { head: sorted[0]!, all: sorted };
  });
}

export function buildCoverReport(input: {
  homes: { file: string; policy: PropertyPolicy }[];
  autos: { file: string; policy: AutoPolicy }[];
  renewals: { file: string; renewal: AutoRenewal }[];
  forms: { file: string; form: PolicyForm }[];
  rows: PremiumRow[];
  today: string;
}): CoverReport {
  const { today } = input;
  const charges = input.rows.filter((r) => r.amountCents < 0).sort((a, b) => a.date.localeCompare(b.date));

  type Draft = { insurer: string; policyNumber: string; line: "HOME" | "AUTO"; terms: CoverTerm[] };
  const homeDrafts = latest(input.homes).map(({ head, all }) => ({
    head,
    draft: {
      insurer: head.policy.insurer,
      policyNumber: head.policy.policyNumber,
      line: "HOME" as const,
      terms: all.map(({ file, policy: p }): CoverTerm => ({ start: p.periodStart, end: p.periodEnd, premiumCents: p.totalPremiumCents, months: p.termMonths, file, from: "DECLARATIONS" })),
    },
  }));
  const autoDrafts = latest(input.autos).map(({ head, all }) => {
    const terms = all.map(({ file, policy: p }): CoverTerm => ({ start: p.periodStart, end: p.periodEnd, premiumCents: p.termPremiumCents, months: p.termMonths, file, from: "DECLARATIONS" }));
    const renewal = input.renewals.filter((r) => r.renewal.policyNumber === head.policy.policyNumber).sort((a, b) => b.renewal.periodStart.localeCompare(a.renewal.periodStart))[0] ?? null;
    // The renewal letter names the premium of the term it renews: the term before it, when no declarations for that one are on file.
    const renewed = renewal?.renewal.priorPremiumCents != null ? terms.find((t) => t.start === renewal.renewal.periodStart) : undefined;
    if (renewal && renewed && !terms.some((t) => t.end === renewed.start)) {
      const months = renewed.months ?? head.policy.termMonths;
      terms.push({ start: monthsBefore(renewed.start, months), end: renewed.start, premiumCents: renewal.renewal.priorPremiumCents!, months, file: renewal.file, from: "RENEWAL_LETTER" });
    }
    return { head, renewal, draft: { insurer: head.policy.insurer, policyNumber: head.policy.policyNumber, line: "AUTO" as const, terms } };
  });

  // Each statement premium goes to the one policy of its insurer whose term on file it pays for,
  // or, before every term on file, to the insurer's only policy; with several and no term, to none.
  const drafts: Draft[] = [...homeDrafts.map((h) => h.draft), ...autoDrafts.map((a) => a.draft)];
  const paid = new Map<Draft, CoverPayment[]>(drafts.map((d) => [d, []]));
  for (const r of charges) {
    const mine = drafts.filter((d) => payeeOf(d.insurer)?.test(r.payee));
    if (!mine.length) continue;
    const termOf = (d: Draft) =>
      d.terms.find((t) => r.date >= addDays(t.start, -PAID_AHEAD_DAYS) && r.date < t.end) ??
      d.terms.find((t) => -r.amountCents === t.premiumCents && r.date >= addDays(t.start, -PAID_IN_FULL_AHEAD_DAYS) && r.date < t.end) ??
      null;
    const inTerm = mine.filter((d) => termOf(d));
    const owner = inTerm.length === 1 ? inTerm[0]! : inTerm.length === 0 && mine.length === 1 ? mine[0]! : null;
    if (!owner) continue;
    paid.get(owner)!.push({ rowId: r.id, date: r.date, cents: -r.amountCents, payee: r.payee, accountId: r.accountId, term: termOf(owner)?.start ?? null });
  }

  const formsOf = (d: Draft, codes: string[]) => {
    const norm = (s: string) => s.replace(/[^A-Z0-9]/gi, "").toUpperCase();
    // A code as printed whole ("9611D CT (06/14)"), and each word of a list of them ("A30CT M-308").
    const listed = new Set([...codes, ...codes.flatMap((c) => c.split(/\s+/))].map(norm).filter(Boolean));
    const same = drafts.filter((x) => x.line === d.line && sameInsurer(x.insurer, d.insurer));
    return input.forms
      .filter(({ form: f }) => f.line === d.line && sameInsurer(f.insurer, d.insurer) && (f.policyNumber === d.policyNumber || (f.policyNumber == null && ((f.code != null && listed.has(norm(f.code))) || same.length === 1))))
      .map(({ file, form: f }) => ({ file, code: f.code, title: f.title }))
      .sort((a, b) => a.title.localeCompare(b.title));
  };

  const base = (d: Draft, file: string, start: string, end: string, annualCents: number, codes: string[], replacedBy: CoverBase["replacedBy"]): CoverBase => {
    const payments = paid.get(d)!;
    const terms = [...d.terms].sort((a, b) => b.start.localeCompare(a.start));
    const ends = replacedBy?.date ?? end;
    return {
      file,
      status: statusOf(start, ends, today),
      terms,
      payments,
      paidTermCents: payments.filter((x) => x.term === start).reduce((s, x) => s + x.cents, 0),
      forms: formsOf(d, codes),
      annualCents,
      replacedBy,
      ends,
    };
  };

  // A policy is replaced when a later one starts during its term on the same car (a VIN in common) or the same home (first premises line).
  const homeKey = (p: PropertyPolicy) => (p.premises[0] ?? "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
  const sameHome = (a: PropertyPolicy, b: PropertyPolicy) => homeKey(a) !== "" && homeKey(a) === homeKey(b);
  const sameCar = (a: AutoPolicy, b: AutoPolicy) => a.vehicles.some((v) => v.vin != null && b.vehicles.some((w) => w.vin === v.vin));
  function replacement<P extends { policyNumber: string; periodStart: string; periodEnd: string; insurer: string }>(p: P, all: P[], same: (a: P, b: P) => boolean): CoverBase["replacedBy"] {
    const later = all.filter((q) => q.policyNumber !== p.policyNumber && q.periodStart > p.periodStart && q.periodStart < p.periodEnd && same(p, q)).sort((a, b) => a.periodStart.localeCompare(b.periodStart))[0];
    return later ? { insurer: later.insurer, policyNumber: later.policyNumber, date: later.periodStart } : null;
  }
  const homeHeads = homeDrafts.map((h) => h.head.policy);
  const autoHeads = autoDrafts.map((a) => a.head.policy);
  // The policies in force or about to be come first (newest first), so each tab opens on the current one.
  const current = <V extends CoverBase & { policy: { periodStart: string } }>(list: V[]) =>
    list.sort((a, b) => Number(a.status === "ENDED") - Number(b.status === "ENDED") || Number(!!a.replacedBy) - Number(!!b.replacedBy) || b.policy.periodStart.localeCompare(a.policy.periodStart));

  return {
    homes: current(
      homeDrafts.map(({ head, draft }) => ({
        ...base(draft, head.file, head.policy.periodStart, head.policy.periodEnd, perYear(head.policy.totalPremiumCents, head.policy.termMonths), head.policy.forms.map((f) => f.code), replacement(head.policy, homeHeads, sameHome)),
        policy: head.policy,
      })),
    ),
    autos: current(
      autoDrafts.map(({ head, draft, renewal }) => ({
        ...base(draft, head.file, head.policy.periodStart, head.policy.periodEnd, perYear(head.policy.termPremiumCents, head.policy.termMonths), [head.policy.contractType ?? "", head.policy.amendments ?? ""], replacement(head.policy, autoHeads, sameCar)),
        policy: head.policy,
        renewal,
      })),
    ),
  };
}

// ---------------------------------------------------------------------------- every line together

export type CoverLine = "LIFE" | "HOME" | "AUTO";

/** One policy as the Overview lists it. */
export type OverviewPolicy = {
  line: CoverLine;
  key: string;
  insurer: string;
  policyNumber: string;
  /** What it covers, in a few words, with no amounts in them ("15-year term on Pat Example", "Renters Policy, 12 Elm St", "2021 Example Sedan"). */
  covers: string;
  status: CoverStatus;
  /** A year of cover at the current rate. */
  annualCents: number | null;
  /** The next date something happens: a premium due, a renewal. */
  next: { date: string; label: string } | null;
  /** Premiums found in the statements. */
  payments: { rowId: string; date: string; cents: number }[];
};

/** What's coming up across the policies, soonest first: premiums due, renewals, and a life policy's own dates. */
export function upcomingDates(data: CoverReport & { policies: PolicyView[]; today: string }, all: OverviewPolicy[] = overviewPolicies(data.policies, data)) {
  const out: { line: CoverLine; key: string; insurer: string; date: string; label: string }[] = [];
  for (const p of all) if (p.next && p.next.date >= data.today) out.push({ line: p.line, key: p.key, insurer: p.insurer, date: p.next.date, label: p.next.label });
  for (const v of data.policies) for (const d of v.dates) if (!d.past) out.push({ line: "LIFE", key: v.policy.policyNumber, insurer: v.policy.insurer, date: d.date, label: d.label });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** The year of cover a life policy costs now: the level premium, or the year's guaranteed maximum after it. */
function lifeAnnual(v: PolicyView): number | null {
  if (v.status === "ENDED") return null;
  const year = v.years.find((y) => y.year === (v.currentYear ?? 1));
  return year && !year.level ? year.maxPremiumCents : v.policy.annualPremiumCents;
}

/** A home or auto policy's next date: its start, the day another policy replaces it, or its term's end. */
function nextDate(v: CoverBase & { policy: { periodStart: string; periodEnd: string } }, endLabel: string): OverviewPolicy["next"] {
  if (v.status === "ENDED") return null;
  if (v.status === "NOT_STARTED") return { date: v.policy.periodStart, label: "Term starts" };
  if (v.replacedBy) return { date: v.ends, label: `Replaced by ${v.replacedBy.insurer}` };
  return { date: v.policy.periodEnd, label: endLabel };
}

export function overviewPolicies(life: PolicyView[], cover: CoverReport): OverviewPolicy[] {
  return [
    ...life.map((v): OverviewPolicy => ({
      line: "LIFE",
      key: v.policy.policyNumber,
      insurer: v.policy.insurer,
      policyNumber: v.policy.policyNumber,
      covers: `${v.policy.levelYears ? `${v.policy.levelYears}-year term` : "Term life"} on ${v.policy.insured}`,
      status: v.status,
      annualCents: lifeAnnual(v),
      next: v.nextDue ? { date: v.nextDue.date, label: `Premium due (year ${v.nextDue.year})` } : null,
      payments: v.payments.map((x) => ({ rowId: x.rowId, date: x.date, cents: x.cents })),
    })),
    ...cover.homes.map((v): OverviewPolicy => ({
      line: "HOME",
      key: v.policy.policyNumber,
      insurer: v.policy.insurer,
      policyNumber: v.policy.policyNumber,
      covers: [v.policy.form, v.policy.premises[0]].filter(Boolean).join(", "),
      status: v.status,
      annualCents: v.status === "ENDED" ? null : v.annualCents,
      next: nextDate(v, v.policy.autoRenews ? "Renews" : "Term ends"),
      payments: v.payments.map((x) => ({ rowId: x.rowId, date: x.date, cents: x.cents })),
    })),
    ...cover.autos.map((v): OverviewPolicy => ({
      line: "AUTO",
      key: v.policy.policyNumber,
      insurer: v.policy.insurer,
      policyNumber: v.policy.policyNumber,
      covers: v.policy.vehicles.map((x) => [x.year, x.make].filter(Boolean).join(" ")).join(", ") || "Auto",
      status: v.status,
      annualCents: v.status === "ENDED" ? null : v.annualCents,
      next: nextDate(v, "Term ends"),
      payments: v.payments.map((x) => ({ rowId: x.rowId, date: x.date, cents: x.cents })),
    })),
  ];
}

/** The premiums paid in the year ending on `through` (the day the statements are complete through), every line together. */
export function paidInYear(policies: readonly OverviewPolicy[], through: string) {
  const from = addDays(through, -364);
  return policies.flatMap((p) => p.payments.filter((x) => x.date >= from && x.date <= through).map((x) => ({ ...x, line: p.line, key: p.key, insurer: p.insurer })));
}
