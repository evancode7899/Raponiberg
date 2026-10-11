import { categorizeMerchant, MERCHANT_RULES, type MerchantRule } from "../classifier/merchants.ts";
import { daysBetween, startOfMonth } from "../dates/isoDate.ts";
import type { BookAccount, BookRow } from "./load.ts";

/**
 * Which month each rent payment pays for. Rent is due on the 1st and gets paid a few
 * days either side of it, so by posting date one month can hold two rents and the next
 * none, and housing looks wildly lumpy. Spending figures count a rent payment in the
 * month it covers instead (see `countsOn`); net worth and the annual profile still book
 * it on its posting date, so balances and the year's bridge to net worth never move.
 *
 * Rent is read as a household timeline, not a payee or a dollar amount, so rent
 * increases, moves, new ways of paying and small housing charges all fit:
 *
 * - What can be rent: housing payments out of a bank account — a landlord's ACH, a
 *   cheque, a wire, a cashier's-cheque withdrawal, Bilt's bank side. Card purchases
 *   (furniture, a building's card portal) and utility or phone bills never are.
 * - The rent level is the household's own recent rent: the typical largest housing
 *   payment over the three months either side. It follows every increase and resets
 *   after a move, with nothing compared to a fixed amount or an all-time average.
 * - A payment of at least half the rent level is a rent payment. Anything smaller to a
 *   payee that is paid rent (a fee, a top-up, parking) is an extra: it is filed with the
 *   month it covers but never moved.
 * - Only payments inside a rent rhythm count: rent paid in three or more months within
 *   the three either side. So a new landlord's first wire or cashier's cheque counts
 *   straight away, and a one-off with no rent around it doesn't.
 * - A lump of more than one and a half times the rent level (a deposit plus the first
 *   month) pays for its month when that month has no other rent; otherwise it is a
 *   deposit, not rent, and stays on its posting date.
 *
 * Which month: a payment pays for the month whose 1st is nearest — one in the first
 * half of a month (on time or a little late) pays for that month, one in the second half
 * pays early for the next. Then, where a month still ends up with two rents and the
 * month next to it with none, the payment nearer that empty month moves into it (paid
 * unusually early or late). A month with two rents beside no empty month keeps both (a
 * real double, e.g. the overlap month of a move).
 *
 * Card charges cancelled by their own credit (Bilt's card-side charge and adjustment)
 * net to nothing and stay where they are.
 */

export type RentPayment = {
  rowId: string;
  date: string;
  cents: number;
  payee: string;
  /** First day of the month the payment covers. */
  covers: string;
  /** A rent payment (vs an extra — a fee or top-up — to a payee that's paid rent). */
  full: boolean;
};

const HOUSING = "Housing & utilities";
/** From this day of a month on, a payment is early rent for the next month (the nearer 1st). */
const EARLY_FROM_DAY = 16;
/** How far either side the rent level and the rent rhythm look, in months. */
const WINDOW_MONTHS = 3;
/** Rent months the rhythm needs inside that window. */
const RHYTHM_MONTHS = 3;
/** A rent payment is at least this share of the rent level; less is an extra. */
const RENT_SHARE = 0.5;
/** More than this many months' rent in one payment is a lump (deposit and/or prepaid rent). */
const LUMP_SHARE = 1.5;
/** Bills the classifier knows as utilities or phone/internet are never rent. */
const NOT_RENT = new Set(["Utilities", "Phone & internet"]);

const keyOf = (r: BookRow) => r.merchantKey ?? r.payee;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const shiftMonth = (monthStart: string, n: number) => {
  const d = new Date(Date.UTC(Number(monthStart.slice(0, 4)), Number(monthStart.slice(5, 7)) - 1 + n, 1));
  return d.toISOString().slice(0, 10);
};
/** The month a payment pays for by the date rule alone. */
const dueMonth = (date: string) => shiftMonth(startOfMonth(date), Number(date.slice(8, 10)) >= EARLY_FROM_DAY ? 1 : 0);
/** Months around (and including) one, within the window. */
const around = (month: string) => Array.from({ length: 2 * WINDOW_MONTHS + 1 }, (_, i) => shiftMonth(month, i - WINDOW_MONTHS));

/**
 * @param accounts the household's accounts, so card purchases can be told apart from bank
 *   payments. Without it every row is treated as a bank payment.
 */
export function rentPayments(
  rows: BookRow[],
  accounts: Pick<BookAccount, "id" | "type" | "subtype">[] = [],
  merchantRules: MerchantRule[] = MERCHANT_RULES,
): RentPayment[] {
  const cards = new Set(accounts.filter((a) => (a.subtype ?? a.type) === "CREDIT_CARD").map((a) => a.id));
  const housing = rows.filter((r) => r.lane === "EXPENSE" && r.category === HOUSING && r.precision === "EXACT");
  // A charge and its exact credit on one account within a week cancel: not a payment.
  const cancelled = new Set<string>();
  for (const c of housing) {
    if (c.amountCents <= 0) continue;
    const charge = housing.find((r) => !cancelled.has(r.id) && r.accountId === c.accountId && r.amountCents === -c.amountCents && Math.abs(daysBetween(r.date, c.date)) <= 7);
    if (!charge) continue;
    cancelled.add(charge.id);
    cancelled.add(c.id);
  }
  const paid = housing.filter(
    (r) => r.amountCents < 0 && !cancelled.has(r.id) && !cards.has(r.accountId) && !NOT_RENT.has(categorizeMerchant(r.payee, undefined, merchantRules) ?? ""),
  );
  if (!paid.length) return [];

  // The rent level around a month: the typical largest housing payment in the window.
  const largest = new Map<string, number>();
  for (const r of paid) {
    const m = startOfMonth(r.date);
    largest.set(m, Math.max(largest.get(m) ?? 0, -r.amountCents));
  }
  const levelCache = new Map<string, number>();
  const level = (month: string) => {
    let v = levelCache.get(month);
    if (v === undefined) {
      const xs = around(month).flatMap((m) => (largest.has(m) ? [largest.get(m)!] : []));
      v = xs.length ? median(xs) : 0;
      levelCache.set(month, v);
    }
    return v;
  };
  const sized = paid.filter((r) => -r.amountCents >= level(startOfMonth(r.date)) * RENT_SHARE);

  // Only rent inside a rhythm: rent-sized payments in enough months around it.
  const rentMonths = new Set(sized.map((r) => startOfMonth(r.date)));
  const inRhythm = (r: BookRow) => around(startOfMonth(r.date)).filter((m) => rentMonths.has(m)).length >= RHYTHM_MONTHS;
  const rent = sized.filter(inRhythm);

  // A lump pays for its month only when nothing else does; otherwise it's a deposit.
  const isLump = (r: BookRow) => -r.amountCents > level(startOfMonth(r.date)) * LUMP_SHARE;
  const regular = rent.filter((r) => !isLump(r));
  const coveredByRegular = new Set(regular.map((r) => dueMonth(r.date)));
  const lumps = rent.filter((r) => isLump(r) && !coveredByRegular.has(dueMonth(r.date)));
  const full = new Set([...regular, ...lumps].map((r) => r.id));

  // Extras: smaller payments to a payee that's paid rent, around rent months.
  const rentPayees = new Set([...regular, ...lumps].map(keyOf));
  const sizedIds = new Set(sized.map((r) => r.id));
  const extras = paid.filter((r) => !sizedIds.has(r.id) && rentPayees.has(keyOf(r)) && inRhythm(r));

  const out: RentPayment[] = [...regular, ...lumps, ...extras].map((r) => ({
    rowId: r.id,
    date: r.date,
    cents: -r.amountCents,
    payee: r.payee,
    covers: dueMonth(r.date),
    full: full.has(r.id),
  }));
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  rebalance(out.filter((p) => p.full));
  return out;
}

/** A month with two rents next to one with none: the payment nearer it moves over. */
function rebalance(full: RentPayment[]): void {
  if (!full.length) return;
  const first = full[0]!.covers;
  const last = full.at(-1)!.covers;
  for (let pass = 0; pass < full.length; pass++) {
    const count = new Map<string, number>();
    for (const p of full) count.set(p.covers, (count.get(p.covers) ?? 0) + 1);
    const empty = (m: string) => m >= first && m <= last && !count.has(m);
    let moved = false;
    for (const [month, n] of count) {
      if (n < 2) continue;
      const here = full.filter((p) => p.covers === month);
      const prev = shiftMonth(month, -1);
      const next = shiftMonth(month, 1);
      if (empty(prev)) here[0]!.covers = prev;
      else if (empty(next)) here.at(-1)!.covers = next;
      else continue;
      moved = true;
      break;
    }
    if (!moved) break;
  }
}

const cache = new WeakMap<BookRow[], Map<string, string>>();

/**
 * The day spending figures count a row on: the first of the month a rent payment covers,
 * otherwise the day the ledger books it (booking.ts).
 */
export function countsOn(
  rows: BookRow[],
  accounts: Pick<BookAccount, "id" | "type" | "subtype">[] = [],
  merchantRules: MerchantRule[] = MERCHANT_RULES,
): (r: BookRow) => string {
  let covers = cache.get(rows);
  if (!covers) {
    covers = new Map(rentPayments(rows, accounts, merchantRules).map((p) => [p.rowId, p.covers]));
    cache.set(rows, covers);
  }
  const m = covers;
  return (r) => m.get(r.id) ?? r.bookedOn;
}
