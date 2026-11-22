import { addDays, daysBetween } from "../dates/isoDate.ts";
import type { HealthPlan } from "./plans.ts";
import type { Coverage } from "./types.ts";

/**
 * How the EOBs tie to the rest of the household's money, pure: the card, bank or HSA row
 * that paid each claim, the HSA receipts log's expenses each claim backs, and the health
 * premiums the pay stubs took. The EOB says what you owe a provider; these are where that
 * money went and what it cost to be covered.
 *
 *  - A payment is a spending row (or an HSA card swipe) toward what a claim says you owe,
 *    from a payee that names the provider or plainly is medical care. Tried in order:
 *     1. exactly what one claim says you owe, dated from a few days before the care to well
 *        after the EOB (bills are paid months later);
 *     2. one bill for several claims that add up to it exactly: claims the payee names, and
 *        the same patient's other care within two weeks of one of them (a hospital bills
 *        for the doctors who saw you there);
 *     3. within a cent-rounding of what one claim says (a $1,250.00 bill for $1,250.40);
 *     4. paid at the desk on the day of care, before the EOB set the share (a $12.00 copay
 *        for a visit the EOB later says cost $11.60), plus a later row for the balance.
 *    The EOB names the clinician; the card names the billing office. Matches of exactly the
 *    amount teach which billing names a provider's care is paid under, and a second round
 *    counts those names as the provider's. Two equally good rows are never guessed between.
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
  /** What the versions it replaced said you owed: the bill can go out before the insurer reprocesses. */
  earlierShares?: number[];
};

/**
 * A row that could have paid a provider: card or bank spending, or the HSA paying one directly.
 * `medical`: the payee plainly is care (hsa/qualify.ts); `health`: only filed under health
 * spending, which takes in salons and insurers too, so it ties a claim only by exact amount.
 */
export type PaymentRowIn = { id: string; date: string; amountCents: number; payee: string; account: string; fromHsa: boolean; medical: boolean; health?: boolean };

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
  /**
   * NAME: the payee names the provider (or a billing name its care was paid under); MEDICAL:
   * only the amount and that it's medical care tie it; GROUP: several claims add up to it;
   * NEAR: within a cent-rounding of what the claim says; VISIT: paid at the desk on the day
   * of care, any amount; BALANCE: the rest of a claim a desk payment didn't cover;
   * INSTALLMENT: one of several rows to the same payee adding up to the claim; PARTIAL: a row
   * from the provider for less than the claim, with nothing else to pay it toward.
   */
  how: "NAME" | "MEDICAL" | "GROUP" | "NEAR" | "VISIT" | "BALANCE" | "INSTALLMENT" | "PARTIAL";
  /** What it put toward each of its claims (a bill for several splits by their shares). */
  shares: { claimId: string; cents: number }[];
};

/** What the HSA page needs of the EOBs: each claim, and the rows that paid them. */
export type HsaEobIn = { claims: ClaimLite[]; payments: ClaimPayment[] };

/** Care a few days ahead of the charge (a copay at the desk) still counts. */
const BEFORE_DAYS = 7;
/** Bills are paid long after the EOB. */
const AFTER_DAYS = 240;
const GROUP_MAX = 4;
/** A bill paid in parts: up to this many rows to one payee. */
const INSTALLMENTS_MAX = 5;
/** A hospital's bill takes in the same patient's other care this close to a claim it names. */
const GROUP_NEAR_DAYS = 14;
/** A desk payment posts from the day before the care (a pre-pay) to a few days after. */
const VISIT_BEFORE_DAYS = 1;
const VISIT_AFTER_DAYS = 3;
/** A desk payment estimates the share: never more than twice it plus $25. */
const visitCap = (owedCents: number) => owedCents * 2 + 2_500;
/** Cent-rounding: 1% of the share, from 2¢ up to $1. */
const nearCents = (owedCents: number) => Math.min(100, Math.max(2, Math.round(owedCents / 100)));

/** Words that don't tell two providers apart. */
const GENERIC = new Set(
  "THE AND FOR LLC INC PLLC LLP CORP CO PC PA MD DDS DMD OD PHD NP RN GROUP GRP ASSOC ASSOCIATES ASSOCIATION CENTER CENTRE CTR HEALTH HEALTHCARE HLTH MEDICAL MED CARE PRACTICE PHYSICIAN PHYSICIANS SERVICES SERVICE SVCS CLINIC OFFICE PAYMENT PAY PMT PATIENT ONLINE BILL BILLING DR NEW YORK NYC OF AT IN WWW COM NET ORG USA CARD".split(" "),
);

/** Shops, parking and rides: a same-day charge from them is a purchase, not the visit's bill. */
const RETAIL = /\b(?:PARKING|GARAGE|UBER|LYFT|TAXI|CVS|WALGREENS?|DUANE ?READE|RITE ?AID|PHARM|DRUG|TARGET|WAL-?MART|AMAZON|AMZN|COSTCO|SHOPPERS)/i;

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
  const x = nameWords(a);
  for (const w of nameWords(b)) if (x.has(w)) return true;
  return false;
}

const inWindow = (c: ClaimLite, date: string) => date >= addDays(c.firstDate, -BEFORE_DAYS) && date <= addDays(c.statementDate > c.lastDate ? c.statementDate : c.lastDate, AFTER_DAYS);

/** Billing names a provider's care was paid under (by the provider's name), learned from rows of exactly a claim's share. */
export type BillingNames = ReadonlyMap<string, readonly (readonly string[])[]>;

const providerKey = (name: string) => name.trim().toUpperCase();

/**
 * The payee carries a billing name of the provider: shares two of its words, or its only
 * word (a payee's city alone never ties a clinician to another office in that city).
 */
function billedAs(names: BillingNames, provider: string, payee: string): boolean {
  const known = provider ? names.get(providerKey(provider)) : undefined;
  if (!known?.length) return false;
  const words = nameWords(payee);
  return known.some((ws) => ws.filter((w) => words.has(w)).length >= Math.min(2, ws.length));
}

/** What rows paid toward each claim. */
export type ClaimPayments = {
  /** The first row that paid each claim you owed something on (by claim id). */
  byClaim: Map<string, ClaimPayment>;
  /** Every row that paid toward each claim: a desk payment and its later balance are two. */
  allByClaim: Map<string, ClaimPayment[]>;
  payments: ClaimPayment[];
  /** The billing names learned from exact matches, by provider. */
  billingNames: BillingNames;
};

/** The rows that paid each claim you owed something on (by claim id), and every payment found. */
export function matchClaimPayments(claims: readonly ClaimLite[], rows: readonly PaymentRowIn[]): ClaimPayments {
  const first = matchRound(claims, rows, new Map());
  // A row of exactly a claim's share whose payee doesn't name the provider is how its care is billed.
  const byId = new Map(claims.map((c) => [c.id, c]));
  const learned = new Map<string, string[][]>();
  for (const p of first.payments) {
    if (p.how !== "MEDICAL" && p.how !== "NAME") continue;
    const ws = [...nameWords(p.payee)].sort();
    if (!ws.length) continue;
    for (const id of p.claimIds) {
      const c = byId.get(id);
      if (!c?.provider || sameProvider(c.provider, p.payee)) continue;
      const k = providerKey(c.provider);
      const have = learned.get(k) ?? [];
      if (!have.some((h) => h.join(" ") === ws.join(" "))) learned.set(k, [...have, ws]);
    }
  }
  return learned.size ? matchRound(claims, rows, learned) : first;
}

/** Every amount a claim could have been billed at: what it says now, then what the versions it replaced said. */
const billedAt = (c: ClaimLite) => [...new Set([c.yourShareCents, ...(c.earlierShares ?? [])].filter((x) => x > 0))];

/** The payee with its words that don't tell providers apart dropped: one billing office's rows share it. */
const payeeKey = (r: PaymentRowIn) => [...nameWords(r.payee)].sort().join(" ");

/** Payees filed under health spending that never bill for care: insurers, salons, cleaners. */
const NOT_CARE = /INSUR|GEICO|STATE ?FARM|PROTECTIVE|\bAGL\b|MUTUAL|PREMIUM|SALON|\bSPA\b|CLEANER|ALTERATION|BARBER|NAIL|VETERIN|\bPET\b|ANIMAL/i;

function matchRound(claims: readonly ClaimLite[], rows: readonly PaymentRowIn[], billingNames: BillingNames): ClaimPayments {
  const used = new Set<string>();
  const byClaim = new Map<string, ClaimPayment>();
  const allByClaim = new Map<string, ClaimPayment[]>();
  const paidOn = new Map<string, number>();
  const payments: ClaimPayment[] = [];
  const out = rows.filter((r) => r.amountCents < 0);
  /** 2: the payee names the provider; 1: it carries a billing name the provider's care was paid under; 0: neither. */
  const named = (c: ClaimLite, r: PaymentRowIn) => (sameProvider(c.provider, r.payee) ? 2 : billedAs(billingNames, c.provider, r.payee) ? 1 : 0);
  const medicalRow = (r: PaymentRowIn) => r.medical || r.fromHsa;
  const careRow = (r: PaymentRowIn) => medicalRow(r) && !RETAIL.test(r.payee);
  /** Exactly a claim's share: medical care, or anything filed under health that isn't an insurer or a salon. */
  const exactRow = (r: PaymentRowIn) => medicalRow(r) || (!!r.health && !NOT_CARE.test(r.payee));
  const record = (r: PaymentRowIn, parts: { c: ClaimLite; cents: number }[], how: ClaimPayment["how"]) => {
    const p: ClaimPayment = {
      rowId: r.id,
      claimIds: parts.map((x) => x.c.id),
      date: r.date,
      amountCents: -r.amountCents,
      payee: r.payee,
      account: r.account,
      fromHsa: r.fromHsa,
      how,
      shares: parts.map((x) => ({ claimId: x.c.id, cents: x.cents })),
    };
    used.add(r.id);
    payments.push(p);
    for (const { c, cents } of parts) {
      if (!byClaim.has(c.id)) byClaim.set(c.id, p);
      allByClaim.set(c.id, [...(allByClaim.get(c.id) ?? []), p]);
      paidOn.set(c.id, (paidOn.get(c.id) ?? 0) + cents);
    }
  };
  const billable = claims.filter((c) => billedAt(c).length).sort((a, b) => a.firstDate.localeCompare(b.firstDate) || a.id.localeCompare(b.id));
  const owed = billable.filter((c) => c.yourShareCents > 0);
  const open = (cs: readonly ClaimLite[] = billable) => cs.filter((c) => !byClaim.has(c.id));
  const days = (a: string, b: string) => Math.abs(daysBetween(a, b));
  const off = (r: PaymentRowIn, cents: number) => Math.abs(-r.amountCents - cents);
  const free = (c: ClaimLite) => (r: PaymentRowIn) => !used.has(r.id) && inWindow(c, r.date);
  /** Care that day by another claim still unpaid names this row: it's that visit's. */
  const namesOther = (c: ClaimLite, r: PaymentRowIn) => open().some((o) => o.id !== c.id && r.date >= addDays(o.firstDate, -1) && r.date <= addDays(o.lastDate, 1) && named(o, r) > 0);
  const onVisitDay = (c: ClaimLite, r: PaymentRowIn) => r.date >= addDays(c.firstDate, -VISIT_BEFORE_DAYS) && r.date <= addDays(c.lastDate, VISIT_AFTER_DAYS);

  /**
   * The one row for a claim among those that `fit`: one naming the provider first, then the
   * smallest `dist`. Without the name, a second candidate makes it a guess; so do two named
   * rows of different amounts equally close.
   */
  const pick = (c: ClaimLite, fit: (r: PaymentRowIn) => boolean, unnamedOk: (r: PaymentRowIn) => boolean, dist: (r: PaymentRowIn) => number) => {
    const near = out
      .filter((r) => free(c)(r) && fit(r))
      .map((r) => ({ r, named: named(c, r) > 0, direct: named(c, r) === 2, dist: dist(r) }))
      .filter((x) => x.named || unnamedOk(x.r))
      .sort((a, b) => Number(b.named) - Number(a.named) || a.dist - b.dist);
    const [best, next] = near;
    if (!best) return null;
    if (!best.named && next) return null;
    if (next?.named && next.dist === best.dist && next.r.amountCents !== best.r.amountCents) return null;
    return best;
  };

  // 1. One claim, one row of exactly what it says you owe; never a row the provider's office
  // took on the day of another visit of its own (that's the other visit's desk payment).
  const otherVisits = (c: ClaimLite, r: PaymentRowIn) => !onVisitDay(c, r) && owed.some((o) => o.id !== c.id && r.date >= addDays(o.firstDate, -1) && r.date <= addDays(o.lastDate, 1) && named(o, r) > 0);
  for (const c of owed) {
    const best = pick(c, (r) => off(r, c.yourShareCents) === 0 && !otherVisits(c, r), exactRow, (r) => days(c.firstDate, r.date));
    if (best) record(best.r, [{ c, cents: c.yourShareCents }], best.direct ? "NAME" : "MEDICAL");
  }

  // 2. One bill for several claims: claims the payee names, and the same patient's care close
  // to one of them, adding up to it exactly (each at what it says now or said before a reprocess).
  for (const r of out) {
    if (used.has(r.id)) continue;
    const left = open().filter((c) => inWindow(c, r.date));
    const anchors = new Set(left.filter((c) => named(c, r) > 0));
    if (!anchors.size) continue;
    const pool = left.filter((c) => anchors.has(c) || [...anchors].some((a) => samePatient(a.patient, c.patient) && days(a.firstDate, c.firstDate) <= GROUP_NEAR_DAYS));
    if (pool.length < 2) continue;
    const options = pool.flatMap((c) => billedAt(c).map((cents) => ({ c, cents })));
    const set = sumTo(options, (o) => o.cents, -r.amountCents, { min: 2, max: GROUP_MAX, must: (o) => anchors.has(o.c), key: (o) => o.c.id });
    // Care the payee doesn't name joins only a bill that plainly is medical (not a shop in the hospital's town).
    if (set && (set.every((o) => anchors.has(o.c)) || careRow(r))) record(r, set, "GROUP");
  }

  // 3. One row of exactly what an earlier version said, billed before the insurer reprocessed.
  for (const c of open()) {
    for (const cents of (c.earlierShares ?? []).filter((x) => x > 0)) {
      const best = pick(c, (r) => off(r, cents) === 0, exactRow, (r) => days(c.firstDate, r.date));
      if (best) {
        record(best.r, [{ c, cents }], best.direct ? "NAME" : "MEDICAL");
        break;
      }
    }
  }

  // 4. Installments: several rows to one payee adding up exactly to the claim, from a payee
  // naming the provider, or one paid at the visit that no other visit that day names.
  for (const c of open()) {
    const rowsOf = new Map<string, PaymentRowIn[]>();
    for (const r of out) if (free(c)(r) && careRow(r) && r.date >= addDays(c.firstDate, -VISIT_BEFORE_DAYS)) rowsOf.set(payeeKey(r), [...(rowsOf.get(payeeKey(r)) ?? []), r]);
    const found: PaymentRowIn[][] = [];
    for (const rs of rowsOf.values()) {
      if (rs.length < 2) continue;
      const tied = rs.some((r) => named(c, r) > 0) || rs.some((r) => onVisitDay(c, r) && !namesOther(c, r));
      if (!tied || rs.some((r) => namesOther(c, r) && named(c, r) === 0)) continue;
      for (const cents of billedAt(c)) {
        const set = sumTo(rs, (r) => -r.amountCents, cents, { min: 2, max: INSTALLMENTS_MAX, key: (r) => r.id });
        if (set) {
          found.push(set);
          break;
        }
      }
    }
    if (found.length === 1) for (const r of found[0]!) record(r, [{ c, cents: -r.amountCents }], "INSTALLMENT");
  }

  // 5. Within a cent-rounding of what one claim says: from a payee naming the provider, or a
  // couple of cents off when it's the only care row that close.
  for (const c of open(owed)) {
    const best = pick(c, (r) => careRow(r) && !otherVisits(c, r) && off(r, c.yourShareCents) <= nearCents(c.yourShareCents), (r) => off(r, c.yourShareCents) <= 2, (r) => off(r, c.yourShareCents) * 1_000 + days(c.firstDate, r.date));
    if (best) record(best.r, [{ c, cents: -best.r.amountCents }], "NEAR");
  }

  // 6. Paid at the desk on the day of care (any amount up to the cap: every row that office
  // took that day), then the balance later. Only medical care (a pharmacy run that day is
  // another purchase); a row naming the provider first, for every claim, then unnamed ones.
  for (const unnamed of [false, true]) {
    for (const c of open(owed)) {
      const fit = (r: PaymentRowIn) => careRow(r) && onVisitDay(c, r) && -r.amountCents <= visitCap(c.yourShareCents);
      const dist = (r: PaymentRowIn) => days(c.firstDate, r.date) * 1_000_000 + off(r, c.yourShareCents);
      let desk = pick(c, fit, () => false, dist);
      if (!desk && unnamed) {
        // Unnamed: the only office that took care money that day (its several charges are one visit).
        const cands = out.filter((r) => free(c)(r) && fit(r) && !namesOther(c, r)).sort((a, b) => dist(a) - dist(b));
        const one = cands.length && cands.every((r) => r.date === cands[0]!.date && payeeKey(r) === payeeKey(cands[0]!));
        if (one) desk = { r: cands[0]!, named: false, direct: false, dist: 0 };
      }
      if (!desk) continue;
      // The office's other charges that day are the same visit's, up to the cap.
      const sameDay = out.filter((r) => r !== desk.r && free(c)(r) && fit(r) && r.date === desk.r.date && payeeKey(r) === payeeKey(desk.r));
      const takes = [desk.r];
      for (const r of sameDay) if (takes.reduce((s, x) => s - x.amountCents, 0) - r.amountCents <= visitCap(c.yourShareCents)) takes.push(r);
      for (const r of takes) record(r, [{ c, cents: -r.amountCents }], "VISIT");
      const rest = c.yourShareCents - (paidOn.get(c.id) ?? 0);
      if (rest <= 0) continue;
      const balance = pick(c, (r) => careRow(r) && r.date >= desk.r.date && off(r, rest) <= nearCents(rest), (r) => !namesOther(c, r), (r) => off(r, rest) * 1_000 + days(desk.r.date, r.date));
      if (balance) record(balance.r, [{ c, cents: -balance.r.amountCents }], "BALANCE");
    }
  }

  // 7. Part of a claim: a row from a payee naming the provider, for less than is still owed,
  // after the EOB that billed it (the latest such EOB of that provider's, when several are open).
  for (const r of [...out].sort((a, b) => a.date.localeCompare(b.date))) {
    if (used.has(r.id) || !careRow(r)) continue;
    const due = owed.filter((c) => free(c)(r) && named(c, r) > 0 && !otherVisits(c, r) && c.statementDate <= r.date && -r.amountCents < c.yourShareCents - (paidOn.get(c.id) ?? 0));
    if (!due.length) continue;
    const latest = due.reduce((m, c) => (c.statementDate > m.statementDate ? c : m));
    if (due.filter((c) => c.statementDate === latest.statementDate).length > 1) continue;
    record(r, [{ c: latest, cents: -r.amountCents }], "PARTIAL");
  }
  return { byClaim, allByClaim, payments: payments.sort((a, b) => a.date.localeCompare(b.date)), billingNames };
}

/** `min` to `max` of `items` (distinct by `key`) whose amounts add to exactly `target`, at least one of them `must`; the first found, or null. */
function sumTo<T>(items: readonly T[], cents: (x: T) => number, target: number, o: { min: number; max: number; must?: (x: T) => boolean; key: (x: T) => string }): T[] | null {
  const xs = [...items].sort((a, b) => cents(b) - cents(a));
  const pick: T[] = [];
  let budget = 50_000;
  const go = (start: number, left: number): boolean => {
    if (left === 0) return pick.length >= o.min && (!o.must || pick.some(o.must));
    if (pick.length >= o.max || --budget <= 0) return false;
    for (let i = start; i < xs.length; i++) {
      const x = xs[i]!;
      if (cents(x) > left || pick.some((p) => o.key(p) === o.key(x))) continue;
      pick.push(x);
      if (go(i + 1, left - cents(x))) return true;
      pick.pop();
    }
    return false;
  };
  return go(0, target) ? [...pick] : null;
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
