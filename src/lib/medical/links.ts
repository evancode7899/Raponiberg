import { addDays, daysBetween } from "../dates/isoDate.ts";
import type { HealthPlan } from "./plans.ts";
import type { Coverage } from "./types.ts";

/**
 * How the EOBs tie to the rest of the household's money, pure: the card, bank or HSA row
 * that paid each claim, the HSA receipts log's expenses each claim backs, and the health
 * premiums the pay stubs took. The EOB says what you owe a provider; these are where that
 * money went and what it cost to be covered.
 *
 *  - A payment is a spending row (or an HSA card swipe) of exactly what one claim says you
 *    owe, dated from a few days before the care to well after the EOB (bills are paid
 *    months later), from a payee that names the provider or plainly is medical care. A
 *    bill for several visits is a row that one provider's open claims add up to exactly.
 *    Two equally good rows of a common amount (a $40 copay) are never guessed between.
 *  - A logged HSA expense is backed by a claim when it was paid by that claim's payment,
 *    or is exactly what an EOB says the same patient owed around that date. An expense
 *    logged for a visit the EOB says cost you less is flagged: only what you owed can be
 *    reimbursed, never what the plan paid.
 *  - A premium is a pre-tax pay stub deduction named for medical, dental or vision cover.
 */

/** What matching needs of a claim (lib/medical/report.ts ClaimView). */
export type ClaimLite = {
  id: string;
  coverage: Coverage;
  patient: string;
  provider: string;
  firstDate: string;
  lastDate: string;
  statementDate: string;
  file: string;
  yourShareCents: number;
  planCents: number;
};

/** A row that could have paid a provider: card or bank spending, or the HSA paying one directly. */
export type PaymentRowIn = { id: string; date: string; amountCents: number; payee: string; account: string; fromHsa: boolean; medical: boolean };

/** A row that paid one or more claims. */
export type ClaimPayment = {
  rowId: string;
  claimIds: string[];
  date: string;
  /** Positive cents. */
  amountCents: number;
  payee: string;
  account: string;
  fromHsa: boolean;
  /** NAME: the payee names the provider; MEDICAL: only the amount and that it's medical care tie it; GROUP: several claims add up to it. */
  how: "NAME" | "MEDICAL" | "GROUP";
};

/** What the HSA page needs of the EOBs: each claim, and the rows that paid them. */
export type HsaEobIn = { claims: ClaimLite[]; payments: ClaimPayment[] };

/** Care a few days ahead of the charge (a copay at the desk) still counts. */
const BEFORE_DAYS = 7;
/** Bills are paid long after the EOB. */
const AFTER_DAYS = 240;
const GROUP_MAX = 4;

/** Words that don't tell two providers apart. */
const GENERIC = new Set(
  "THE AND FOR LLC INC PLLC LLP CORP CO PC PA MD DDS DMD OD PHD NP RN GROUP GRP ASSOC ASSOCIATES ASSOCIATION CENTER CENTRE CTR HEALTH HEALTHCARE HLTH MEDICAL MED CARE PRACTICE PHYSICIAN PHYSICIANS SERVICES SERVICE SVCS CLINIC OFFICE PAYMENT PAY PMT PATIENT ONLINE BILL BILLING DR NEW YORK NYC OF AT IN".split(" "),
);

/** The words of a name that could tell its provider apart ("RIVERSIDE PEDIATRICS PC" → RIVERSIDE, PEDIATRICS). */
export function nameWords(name: string): Set<string> {
  return new Set(
    name
      .toUpperCase()
      .replace(/^(?:CARD:|APLPAY|SQ ?\*|TST ?\*|SP |PY ?\*|PAYPAL ?\*)\s*/, "")
      .replace(/[^A-Z ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !GENERIC.has(w)),
  );
}

/** Two names share a word that tells a provider apart. */
export function sameProvider(a: string, b: string): boolean {
  if (!a || !b) return false;
  return sharesWord(nameWords(a), nameWords(b));
}

function sharesWord(x: ReadonlySet<string>, y: ReadonlySet<string>): boolean {
  const [small, big] = x.size <= y.size ? [x, y] : [y, x];
  for (const w of small) if (big.has(w)) return true;
  return false;
}

/** sameProvider with each name's words read once: matching compares thousands of rows to every claim. */
function providerMatcher(): (a: string, b: string) => boolean {
  const memo = new Map<string, Set<string>>();
  const words = (s: string) => {
    let w = memo.get(s);
    if (!w) memo.set(s, (w = nameWords(s)));
    return w;
  };
  return (a, b) => !!a && !!b && sharesWord(words(a), words(b));
}

/** The days a payment for a claim can fall on, from a few days before the care to well after the EOB. */
const claimWindow = (c: ClaimLite) => ({ from: addDays(c.firstDate, -BEFORE_DAYS), to: addDays(c.statementDate > c.lastDate ? c.statementDate : c.lastDate, AFTER_DAYS) });

const inWindow = (c: ClaimLite, date: string) => {
  const w = claimWindow(c);
  return date >= w.from && date <= w.to;
};

/** Up to GROUP_MAX of `items` adding to exactly `target`, or null. */
function subsetTo<T extends { yourShareCents: number }>(items: readonly T[], target: number): T[] | null {
  const xs = [...items].sort((a, b) => b.yourShareCents - a.yourShareCents);
  const pick: T[] = [];
  let budget = 50_000;
  const go = (start: number, left: number): boolean => {
    if (left === 0) return pick.length > 1;
    if (pick.length >= GROUP_MAX || --budget <= 0) return false;
    for (let i = start; i < xs.length; i++) {
      if (xs[i]!.yourShareCents > left) continue;
      pick.push(xs[i]!);
      if (go(i + 1, left - xs[i]!.yourShareCents)) return true;
      pick.pop();
    }
    return false;
  };
  return go(0, target) ? [...pick] : null;
}

/** The row that paid each claim you owed something on (by claim id), and every payment found. */
export function matchClaimPayments(claims: readonly ClaimLite[], rows: readonly PaymentRowIn[]): { byClaim: Map<string, ClaimPayment>; payments: ClaimPayment[] } {
  const used = new Set<string>();
  const byClaim = new Map<string, ClaimPayment>();
  const payments: ClaimPayment[] = [];
  const out = rows.filter((r) => r.amountCents < 0);
  const record = (r: PaymentRowIn, cs: ClaimLite[], how: ClaimPayment["how"]) => {
    const p: ClaimPayment = { rowId: r.id, claimIds: cs.map((c) => c.id), date: r.date, amountCents: -r.amountCents, payee: r.payee, account: r.account, fromHsa: r.fromHsa, how };
    used.add(r.id);
    payments.push(p);
    for (const c of cs) byClaim.set(c.id, p);
  };

  // Each name's words and each claim's window, worked out once (rows × claims comparisons below).
  const same = providerMatcher();
  const windows = new Map(claims.map((c) => [c.id, claimWindow(c)]));
  const within = (c: ClaimLite, date: string) => {
    const w = windows.get(c.id)!;
    return date >= w.from && date <= w.to;
  };
  // Rows by what they paid, so a claim looks only at rows of its amount.
  const byAmount = new Map<number, PaymentRowIn[]>();
  for (const r of out) {
    const list = byAmount.get(-r.amountCents);
    if (list) list.push(r);
    else byAmount.set(-r.amountCents, [r]);
  }

  // One claim, one row of exactly what it says you owe.
  const owed = claims.filter((c) => c.yourShareCents > 0).sort((a, b) => a.firstDate.localeCompare(b.firstDate) || a.id.localeCompare(b.id));
  for (const c of owed) {
    const near = (byAmount.get(c.yourShareCents) ?? [])
      .filter((r) => !used.has(r.id) && within(c, r.date))
      .map((r) => ({ r, named: same(c.provider, r.payee), dist: Math.abs(daysBetween(c.firstDate, r.date)) }))
      .filter((x) => x.named || x.r.medical || x.r.fromHsa)
      .sort((a, b) => Number(b.named) - Number(a.named) || a.dist - b.dist);
    const best = near[0];
    if (!best) continue;
    // Without the provider's name, a second row of the same amount makes it a guess.
    if (!best.named && near.length > 1) continue;
    record(best.r, [c], best.named ? "NAME" : "MEDICAL");
  }

  // A bill for several visits: a row naming the provider that its open claims add up to.
  for (const r of out) {
    if (used.has(r.id)) continue;
    const open = owed.filter((c) => !byClaim.has(c.id) && within(c, r.date) && same(c.provider, r.payee));
    if (open.length < 2) continue;
    const set = subsetTo(open, -r.amountCents);
    if (set) record(r, set, "GROUP");
  }
  return { byClaim, payments: payments.sort((a, b) => a.date.localeCompare(b.date)) };
}

// ---------------------------------------------------------------------------- HSA log

/** What linking needs of a logged HSA expense (lib/hsa/store.ts HsaExpense). */
export type ExpenseIn = { id: string; date: string; amountCents: number; patient: string; provider: string; paidRowId: string | null };

export type ExpenseClaims = {
  claimIds: string[];
  /** What the EOBs say you owed on them. */
  owedCents: number;
  planCents: number;
  /** PAYMENT: the row that paid it paid these claims; AMOUNT: exactly what an EOB says the patient owed then; VISIT: the same patient, provider and day. */
  how: "PAYMENT" | "AMOUNT" | "VISIT";
  /** The expense asks for more than the EOBs say was owed. */
  over: boolean;
};

const samePatient = (a: string, b: string) => !a || !b || a.trim().split(/\s+/)[0]!.toUpperCase() === b.trim().split(/\s+/)[0]!.toUpperCase();

/** The claims behind each logged expense that has any, by expense id. */
export function linkExpenses(expenses: readonly ExpenseIn[], claims: readonly ClaimLite[], payments: readonly ClaimPayment[]): Map<string, ExpenseClaims> {
  const byId = new Map(claims.map((c) => [c.id, c]));
  const byRow = new Map(payments.map((p) => [p.rowId, p]));
  const taken = new Set<string>();
  const out = new Map<string, ExpenseClaims>();
  const link = (e: ExpenseIn, cs: ClaimLite[], how: ExpenseClaims["how"]) => {
    const owedCents = cs.reduce((s, c) => s + c.yourShareCents, 0);
    out.set(e.id, { claimIds: cs.map((c) => c.id), owedCents, planCents: cs.reduce((s, c) => s + c.planCents, 0), how, over: e.amountCents > owedCents });
    for (const c of cs) taken.add(c.id);
  };
  const sorted = [...expenses].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  // Paid by a claim's payment: that's the claim, whatever the amounts say.
  for (const e of sorted) {
    const p = e.paidRowId ? byRow.get(e.paidRowId) : undefined;
    if (p) link(e, p.claimIds.map((id) => byId.get(id)!).filter(Boolean), "PAYMENT");
  }
  // Exactly what an EOB says this patient owed, around this date.
  for (const e of sorted) {
    if (out.has(e.id)) continue;
    const near = claims
      .filter((c) => !taken.has(c.id) && c.yourShareCents === e.amountCents && samePatient(e.patient, c.patient) && inWindow(c, e.date) && e.date >= addDays(c.firstDate, -BEFORE_DAYS))
      .sort((a, b) => Number(sameProvider(b.provider, e.provider)) - Number(sameProvider(a.provider, e.provider)) || Math.abs(daysBetween(a.firstDate, e.date)) - Math.abs(daysBetween(b.firstDate, e.date)));
    if (near[0] && (near.length === 1 || sameProvider(near[0].provider, e.provider))) link(e, [near[0]], "AMOUNT");
  }
  // The same patient and provider on the day of care, owing less than logged: the EOB says what's reimbursable.
  for (const e of sorted) {
    if (out.has(e.id) || !e.patient) continue;
    const visit = claims.filter((c) => !taken.has(c.id) && samePatient(e.patient, c.patient) && sameProvider(c.provider, e.provider) && e.date >= addDays(c.firstDate, -3) && e.date <= addDays(c.lastDate, 3));
    if (visit.length && visit.reduce((s, c) => s + c.yourShareCents, 0) < e.amountCents) link(e, visit, "VISIT");
  }
  return out;
}

// ---------------------------------------------------------------------------- premiums

/** A pre-tax pay stub deduction for health cover. */
export type PremiumLine = { payDate: string; personId: string | null; employer: string; coverage: Coverage; line: string; cents: number; stub: string };

/** Which cover a pre-tax deduction pays for, by its name; null for an FSA, commuter or anything else. */
export function premiumCoverage(name: string): Coverage | null {
  const n = name.toUpperCase();
  if (/\bFSA\b|FLEX|\bHSA\b|SAVINGS|COMMUT|TRANSIT|PARKING|\bLIFE\b|DISAB|\bLTD\b|\bSTD\b|ACCIDENT|LEGAL|PET\b/.test(n)) return null;
  if (/DENT/.test(n)) return "DENTAL";
  if (/VISION|\bVSP\b|\bEYE/.test(n)) return "VISION";
  if (/\bMED|HDHP|HEALTH|\bPPO\b|\bHMO\b|\bEPO\b|\bPOS\b|AETNA|CIGNA|\bUHC\b|UNITED ?HEALTH|BLUE ?CROSS|BCBS|ANTHEM|OXFORD|EMBLEM/.test(n)) return "MEDICAL";
  return null;
}

/** Every health premium on the stubs (pre-tax lines named for medical, dental or vision cover). */
export function premiumLines(stubs: readonly { payDate: string; personId: string | null; employer: string; documentTitle: string; lines: readonly { name: string; kind: string; current: number | null }[] }[]): PremiumLine[] {
  return stubs
    .flatMap((s) =>
      s.lines.flatMap((l) => {
        const coverage = l.kind === "SECTION125" ? premiumCoverage(l.name) : null;
        return coverage && l.current ? [{ payDate: s.payDate, personId: s.personId, employer: s.employer, coverage, line: l.name, cents: Math.abs(l.current), stub: s.documentTitle }] : [];
      }),
    )
    .sort((a, b) => a.payDate.localeCompare(b.payDate) || a.line.localeCompare(b.line));
}

// ---------------------------------------------------------------------------- HSA eligibility

/** The medical plans on file in force on a day. */
export const medicalPlansOn = (plans: readonly HealthPlan[], date: string) => plans.filter((p) => p.coverage === "MEDICAL" && p.coverageFrom <= date && date <= p.coverageTo);

/**
 * What the plans on file say about a year's HSA eligibility. Eligibility is month by month,
 * on the first of the month (IRS Publication 969): a month is eligible when an HSA-eligible
 * medical plan on file covers its first day, ineligible when only plans that aren't do, and
 * unknown when no medical plan on file covers it. Null when no plan on file reaches the year.
 */
export type HsaPlanYear = {
  /** Family when the eligible plan covers more than its member, else self-only. Null when the plan file doesn't say who it covers. */
  coverage: "FAMILY" | "SELF" | null;
  plan: HealthPlan;
  eligibleMonths: number;
  ineligibleMonths: number;
  /** Covered by an HSA-eligible plan on December 1: the last-month rule allows the full year's limit (with a testing period). */
  december: boolean;
};

const FAMILY_COVER = /FAMILY|SPOUSE|PARTNER|CHILD|DEPENDENT|\+/i;
const SELF_COVER = /\b(?:EMPLOYEE|INDIVIDUAL|MEMBER|SELF)(?: ONLY)?\b/i;

/** Who a plan covers, by its `covers` words (or the patients on its EOBs). */
export function planCoverTier(p: HealthPlan, patients: readonly string[]): "FAMILY" | "SELF" | null {
  if (p.covers && FAMILY_COVER.test(p.covers)) return "FAMILY";
  if (p.covers && SELF_COVER.test(p.covers)) return "SELF";
  return new Set(patients.map((x) => x.toUpperCase())).size > 1 ? "FAMILY" : null;
}

export function hsaPlanYear(plans: readonly HealthPlan[], year: number, patientsOf: (p: HealthPlan) => readonly string[]): HsaPlanYear | null {
  let eligible = 0;
  let ineligible = 0;
  let last: HealthPlan | null = null;
  for (let m = 1; m <= 12; m++) {
    const on = medicalPlansOn(plans, `${year}-${String(m).padStart(2, "0")}-01`);
    const ok = on.filter((p) => p.hsaEligible);
    if (ok.length) {
      eligible++;
      last = ok[0]!;
    } else if (on.length) ineligible++;
  }
  if (!last) return eligible || ineligible ? { coverage: null, plan: medicalPlansOn(plans, `${year}-12-01`)[0] ?? plans.find((p) => p.coverage === "MEDICAL")!, eligibleMonths: 0, ineligibleMonths: ineligible, december: false } : null;
  return { coverage: planCoverTier(last, patientsOf(last)), plan: last, eligibleMonths: eligible, ineligibleMonths: ineligible, december: medicalPlansOn(plans, `${year}-12-01`).some((p) => p.hsaEligible) };
}
