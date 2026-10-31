import { applies, type CardProduct, type Perk } from "./catalog.ts";
import { addDays, periodKey, periodsOf, regex, type Period } from "./periods.ts";
import type { CreditKind, CreditRow, Evidence, PeriodStatus, PerkLine, PerkPeriod, PerkRow } from "./types.ts";

/**
 * Perks, found in the statements with no marking by hand.
 *
 * Every credit on a card is sorted first: the annual fee reversed, a perk's statement
 * credit (its description, or a credit from a merchant the perk pays for), rewards cashed
 * in, an issuer offer or bonus, or else a merchant's refund (which only reduces spending).
 * A perk credit counts in the period of the charge it pays back when one is found (a
 * charge on the 30th credited on the 2nd belongs to the month before); otherwise in the
 * period of its own date.
 *
 * In-app perks (Uber Cash) never reach a statement, but using one shows: a household
 * charge at its merchants in the period. Each such charge vouches for one card's perk,
 * largest perk first, so one Uber charge covers one card's Uber Cash and two cover two.
 */

const ANNUAL_FEE = /ANNUAL (MEMBERSHIP )?FEE|MEMBERSHIP FEE|ANNUAL CARD FEE|CARD ANNUAL FEE/i;
export const REDEMPTION = /POINTS ?FOR ?AMEX|PAY ?WITH ?POINTS|CASH ?REWARD|CASH ?BACK ?REWARD|REWARDS? ?REDEMPTION|REDEEMED|ULTIMATE REWARDS|MEMBERSHIP REWARDS|STATEMENT CREDIT FOR POINTS|MILES? ?REDEMPTION|BILT POINTS/i;
const textOf = (r: Pick<PerkRow, "payee" | "detail">) => `${r.payee} ${r.detail ?? ""}`;

export const isFeeRow = (r: PerkRow) => ANNUAL_FEE.test(r.payee) && (r.section === "Fees" || r.classifiedBy === "card-fee-interest" || /FEE/i.test(r.payee));
/** Spending a card earns on: purchases and merchant refunds, never fees, interest, payments or the card's own credits. */
export const isSpendRow = (r: PerkRow) => r.lane === "EXPENSE" && r.section !== "Fees" && r.section !== "Interest" && r.classifiedBy !== "card-fee-interest";

type Compiled = { perk: Perk; credit: RegExp | null; merchants: RegExp | null };
const compile = (p: CardProduct): Compiled[] => p.perks.map((perk) => ({ perk, credit: regex(perk.credit), merchants: regex(perk.merchants) }));

/** A perk's allowance in one period (the December bonus included). */
export function allowance(perk: Perk, period: Period): number {
  const b = perk.bonus && Number(period.end.slice(5, 7)) >= perk.bonus.month && Number(period.start.slice(5, 7)) <= perk.bonus.month ? perk.bonus.cents : 0;
  return perk.amountCents + b;
}

export type Sorted = {
  credits: CreditRow[];
  /** Perk credits with the date that decides their period. */
  perkCredits: { row: PerkRow; perk: Perk; on: string; kind: "CREDIT" | "MERCHANT" }[];
  feeRows: PerkRow[];
  /** Ids of rows that aren't spending (fees, perk credits, offers, redemptions, ignored). */
  notSpend: Set<string>;
};

/** Sorts one card's rows (every year, oldest first). */
export function sortCredits(product: CardProduct | null, rows: PerkRow[]): Sorted {
  const perks = product ? compile(product) : [];
  const ignore = regex(product?.ignoreCredits);
  const credits: CreditRow[] = [];
  const perkCredits: Sorted["perkCredits"] = [];
  const feeRows: PerkRow[] = [];
  const notSpend = new Set<string>();
  const claimed = new Set<string>();
  const used = new Map<string, number>();
  for (const r of rows) {
    if (isFeeRow(r)) {
      feeRows.push(r);
      notSpend.add(r.id);
      if (r.amountCents > 0) credits.push({ id: r.id, date: r.date, payee: r.payee, amountCents: r.amountCents, kind: "FEE_REVERSAL", perkId: null });
      continue;
    }
    if (r.amountCents <= 0 || r.lane === "TRANSFER") continue;
    const text = textOf(r);
    if (ignore?.test(text)) {
      notSpend.add(r.id);
      continue;
    }
    const byCredit = perks.filter((x) => x.credit?.test(text));
    const byMerchant = perks.filter((x) => !x.perk.inApp && !byCredit.includes(x) && x.merchants?.test(text));
    const candidates = [...byCredit, ...byMerchant];
    if (candidates.length) {
      // The charge it pays back, to date it: the latest unclaimed one at the perk's merchants within 40 days.
      const since = addDays(r.date, -40);
      const charge = (c: Compiled) =>
        c.merchants ? rows.filter((x) => x.amountCents < 0 && !claimed.has(x.id) && x.date <= r.date && x.date >= since && c.merchants!.test(textOf(x))).at(-1) : undefined;
      const on = (c: Compiled) => charge(c)?.date ?? r.date;
      const room = (c: Compiled) => {
        const d = on(c);
        if (!applies(c.perk, d, d)) return -1;
        const p = periodsOf(c.perk.cadence, Number(d.slice(0, 4))).find((x) => x.key === periodKey(c.perk.cadence, d))!;
        return allowance(c.perk, p) - (used.get(`${c.perk.id}|${p.key}`) ?? 0);
      };
      const pick = candidates.find((c) => room(c) > 0) ?? candidates.find((c) => room(c) >= 0) ?? candidates[0]!;
      const ch = charge(pick);
      if (ch) claimed.add(ch.id);
      const date = ch?.date ?? r.date;
      const k = `${pick.perk.id}|${periodKey(pick.perk.cadence, date)}`;
      used.set(k, (used.get(k) ?? 0) + r.amountCents);
      perkCredits.push({ row: r, perk: pick.perk, on: date, kind: byCredit.includes(pick) ? "CREDIT" : "MERCHANT" });
      credits.push({ id: r.id, date: r.date, payee: r.payee, amountCents: r.amountCents, kind: "PERK", perkId: pick.perk.id });
      notSpend.add(r.id);
      continue;
    }
    let kind: CreditKind | null = null;
    if (REDEMPTION.test(text)) kind = "REDEMPTION";
    else if (r.classifiedBy === "card-perk-credit" && !/DISPUTE/i.test(text)) kind = "OFFER";
    if (kind) {
      credits.push({ id: r.id, date: r.date, payee: r.payee, amountCents: r.amountCents, kind, perkId: null });
      notSpend.add(r.id);
    }
    // Anything else is a merchant's refund: it counts against spending.
  }
  return { credits, perkCredits, feeRows, notSpend };
}

export type Holding = { from: string; through: string; open: boolean };

/** In-app perk uses for every card, by `${accountId}|${perkId}|${periodKey}`: the charges that vouch for them. */
export function inAppUses(
  cards: { accountId: string; product: CardProduct; held: Holding }[],
  householdRows: PerkRow[],
  years: number[],
): Map<string, Evidence> {
  const out = new Map<string, Evidence>();
  // Perks sharing merchant patterns share their charges.
  const groups = new Map<string, { accountId: string; perk: Perk }[]>();
  for (const c of cards)
    for (const perk of c.product.perks) {
      if (!perk.inApp || !perk.merchants) continue;
      const k = JSON.stringify([perk.merchants, perk.notMerchants ?? ""]);
      groups.set(k, [...(groups.get(k) ?? []), { accountId: c.accountId, perk }]);
    }
  const heldBy = new Map(cards.map((c) => [c.accountId, c.held]));
  for (const [k, members] of groups) {
    const [pattern, not] = JSON.parse(k) as [string, string];
    const re = regex(pattern);
    const skip = regex(not);
    if (!re) continue;
    const charges = householdRows.filter((r) => r.amountCents < 0 && re.test(textOf(r)) && !skip?.test(textOf(r))).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    for (const year of years) {
      for (const period of periodsOf("MONTHLY", year)) {
        const inPeriod = charges.filter((r) => r.date >= period.start && r.date <= period.end);
        if (!inPeriod.length) continue;
        const wants = members
          .filter(({ accountId, perk }) => {
            const h = heldBy.get(accountId)!;
            return applies(perk, period.start, period.end) && h.from <= period.end && (h.open || h.through >= period.start);
          })
          .sort((a, b) => allowance(b.perk, period) - allowance(a.perk, period) || a.accountId.localeCompare(b.accountId));
        // Prefer each card's own charge, then any other.
        const left = [...inPeriod];
        for (const w of wants) {
          const i = Math.max(0, left.findIndex((r) => r.accountId === w.accountId));
          const r = left.splice(i, 1)[0];
          if (!r) break;
          out.set(`${w.accountId}|${w.perk.id}|${periodKey(w.perk.cadence, r.date)}`, { rowId: r.id, date: r.date, payee: r.payee, amountCents: r.amountCents, kind: "SPEND", accountId: r.accountId });
        }
      }
    }
  }
  return out;
}

/** Days after a period's end its credits can still post: a period isn't final until the statements cover them. */
const CREDIT_GRACE_DAYS = 10;

/** One card's perks for one year, period by period. */
export function perkLines(input: {
  accountId: string;
  product: CardProduct;
  held: Holding;
  rows: PerkRow[];
  sorted: Sorted;
  inApp: Map<string, Evidence>;
  year: number;
  today: string;
}): PerkLine[] {
  const { accountId, product, held, sorted, inApp, year, today } = input;
  const perks = compile(product);
  const charges = input.rows.filter((r) => r.amountCents < 0);
  return perks
    .filter(({ perk }) => applies(perk, `${year}-01-01`, `${year}-12-31`))
    .map(({ perk, merchants }): PerkLine => {
      const periods = periodsOf(perk.cadence, year).map((p): PerkPeriod => {
        const allow = allowance(perk, p);
        const evidence: Evidence[] = [];
        if (perk.inApp) {
          // A monthly in-app perk has one use a month; a longer one any month in it.
          for (const [k, e] of inApp) {
            const [acct, id, key] = k.split("|");
            if (acct === accountId && id === perk.id && key === p.key) evidence.push(e);
          }
        } else {
          for (const c of sorted.perkCredits)
            if (c.perk.id === perk.id && c.on >= p.start && c.on <= p.end) evidence.push({ rowId: c.row.id, date: c.row.date, payee: c.row.payee, amountCents: c.row.amountCents, kind: c.kind, accountId });
        }
        // A perk pays at most its allowance: anything past it is a refund it can't be.
        const usedCents = perk.inApp ? (evidence.length ? allow : 0) : Math.min(allow, evidence.reduce((t, e) => t + e.amountCents, 0));
        const unmatchedSpend =
          !perk.inApp && merchants && usedCents === 0 ? charges.filter((r) => r.date >= p.start && r.date <= p.end && merchants.test(`${r.payee} ${r.detail ?? ""}`)).length : 0;
        // Offered while the card was held: a credit added after it closed was never the owner's to miss.
        const heldStart = held.from > p.start ? held.from : p.start;
        const heldEnd = !held.open && held.through < p.end ? held.through : p.end;
        const offered = applies(perk, heldStart <= heldEnd ? heldStart : p.start, heldStart <= heldEnd ? heldEnd : p.end);
        const notHeld = p.end < held.from || (!held.open && p.start > held.through);
        const over = p.end < today;
        const final = held.through >= (perk.inApp ? p.end : addDays(p.end, CREDIT_GRACE_DAYS)) || (!held.open && held.through < p.end);
        const status: PeriodStatus = !offered
          ? "NOT_OFFERED"
          : notHeld && !usedCents
            ? "NOT_HELD"
            : usedCents >= allow
              ? "USED"
              : p.start > today
                ? "FUTURE"
                : !over
                  ? "OPEN"
                  : final
                    ? usedCents > 0
                      ? "PARTIAL"
                      : "MISSED"
                    : "AWAITING";
        return { ...p, allowanceCents: allow, usedCents, status, evidence, unmatchedSpend };
      });
      const counted = periods.filter((p) => p.status !== "NOT_HELD" && p.status !== "NOT_OFFERED");
      const short = (p: PerkPeriod) => Math.max(0, p.allowanceCents - p.usedCents);
      const decided = counted.filter((p) => p.status === "USED" || p.status === "PARTIAL" || p.status === "MISSED");
      return {
        id: perk.id,
        name: perk.name,
        cadence: perk.cadence,
        amountCents: perk.amountCents,
        how: perk.how,
        detection: perk.inApp ? "IN_APP" : "CREDIT",
        periods,
        allowanceCents: counted.reduce((t, p) => t + p.allowanceCents, 0),
        usedCents: counted.reduce((t, p) => t + p.usedCents, 0),
        missedCents: counted.filter((p) => p.status === "MISSED" || p.status === "PARTIAL").reduce((t, p) => t + short(p), 0),
        remainingCents: counted.filter((p) => p.status === "OPEN" || p.status === "AWAITING" || p.status === "FUTURE").reduce((t, p) => t + short(p), 0),
        neverUsed: decided.length >= 2 && decided.every((p) => p.usedCents === 0),
      };
    })
    .filter((l) => l.periods.some((p) => p.status !== "NOT_HELD" && p.status !== "NOT_OFFERED"));
}
