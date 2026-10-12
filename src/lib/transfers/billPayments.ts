import type { Prisma, PrismaClient } from "@prisma/client";
import { categorizeMerchant, type MerchantRule } from "../classifier/merchants.ts";
import { addDays, daysBetween } from "../dates/isoDate.ts";
import { legKey, type MatchMethod } from "./matchTransfers.ts";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Pays a landlord's bill (ingest/parsers/rentBill.ts) the way a bank payment pays a card.
 * The bill account holds the charges; what was paid shows on it as "Payments and credits"
 * for the bill's cycle (worked out from the previous bill), or as a "Payment" line the bill
 * still prints. The bank side is the household's rent payments: housing payments out of a
 * bank account, whoever the payee (the landlord's portal, Bilt, a cheque).
 *
 * The bill row pairs with the bank rows inside its cycle that add up to it exactly, when
 * exactly one set of them does; a printed payment with the one bank row of its amount
 * within a few days. Those bank rows then count as transfers, not spending: the spending
 * is the bill's charges. Anything else (more than one way to add up, or none) is left for
 * the owner, with the cycle's rent payments offered on Review; a difference they confirm
 * is the landlord changing the bill without itemizing it, and is booked as housing.
 * Housing payments outside every bill's cycle are untouched: rent before the first bill
 * on file stays spending.
 */

export type BillLeg = {
  id: string;
  accountId: string;
  date: string;
  precision: "EXACT" | "PERIOD";
  /** The bill's cycle. */
  periodStart: string;
  periodEnd: string;
  amountCents: number;
  /** On the account's first bill on file, whose opening (owing nothing) is assumed. */
  firstBill?: boolean;
};

export type BankRentRow = { id: string; date: string; amountCents: number };

export type BillPlan = {
  matches: { legIds: string[]; method: MatchMethod }[];
  /** Bill payments nothing adds up to: the cycle's rent payments, for the owner to confirm. */
  suggestions: { legIds: string[]; differenceCents: number }[];
  /**
   * Payment lines on an account's first bill that no bank payment made: credit for money
   * paid before the bills on file (a move-in payment, already counted as housing when it
   * left the bank), so it's a housing credit rather than a payment.
   */
  carriedIn: string[];
};

/** A printed payment line posts within a few days of the bank's date. */
const WINDOW_DAYS = 6;
/** More rent payments than this in one cycle isn't searched for a sum. */
const MAX_SUBSET = 14;

export function planBillPayments(bills: BillLeg[], bank: BankRentRow[], rejected: ReadonlySet<string> = new Set()): BillPlan {
  const used = new Set<string>();
  const plan: BillPlan = { matches: [], suggestions: [], carriedIn: [] };
  const order = [...bills].sort((a, b) => (a.precision === b.precision ? (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) : a.precision === "EXACT" ? -1 : 1));
  for (const b of order) {
    if (b.precision === "EXACT") {
      const near = bank.filter((r) => !used.has(r.id) && r.amountCents === -b.amountCents && Math.abs(daysBetween(r.date, b.date)) <= WINDOW_DAYS && !rejected.has(legKey([b.id, r.id])));
      if (near.length === 0 && b.firstBill) plan.carriedIn.push(b.id);
      if (near.length !== 1) continue;
      used.add(near[0]!.id);
      plan.matches.push({ legIds: [b.id, near[0]!.id], method: "EXACT_PAIR" });
      continue;
    }
    const inCycle = bank.filter((r) => !used.has(r.id) && r.date >= b.periodStart && r.date <= b.periodEnd);
    const sets = inCycle.length <= MAX_SUBSET ? subsetsSummingTo(inCycle, -b.amountCents).filter((s) => !rejected.has(legKey([b.id, ...s.map((r) => r.id)]))) : [];
    if (sets.length === 1) {
      for (const r of sets[0]!) used.add(r.id);
      plan.matches.push({ legIds: [b.id, ...sets[0]!.map((r) => r.id)], method: sets[0]!.length === 1 ? "EXACT_PAIR" : "AGGREGATE" });
    } else if (sets.length === 0 && inCycle.length > 0) {
      plan.suggestions.push({ legIds: [b.id, ...inCycle.map((r) => r.id)], differenceCents: b.amountCents + inCycle.reduce((s, r) => s + r.amountCents, 0) });
    }
  }
  return plan;
}

function subsetsSummingTo(rows: BankRentRow[], cents: number): BankRentRow[][] {
  const out: BankRentRow[][] = [];
  for (let mask = 1; mask < 1 << rows.length; mask++) {
    let sum = 0;
    const pick: BankRentRow[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (!(mask & (1 << i))) continue;
      sum += rows[i]!.amountCents;
      pick.push(rows[i]!);
    }
    if (sum === cents) out.push(pick);
  }
  return out;
}

/** Bills classified as utilities or phone are paid to the utility, never the landlord. */
const NOT_RENT = new Set(["Utilities", "Phone & internet"]);

/** The unpaired bill payment rows and the bank rent payments that could pay them. */
export async function loadBillPaymentInputs(db: Db, merchantRules: MerchantRule[]): Promise<{ bills: BillLeg[]; bank: BankRentRow[] }> {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const billRows = await db.transaction.findMany({
    where: { lane: "TRANSFER", amountCents: { gt: 0 }, transferLeg: null, account: { subtype: "BILL" }, statementImport: { isSummary: false, status: "COMMITTED" } },
    select: { id: true, accountId: true, date: true, datePrecision: true, amountCents: true, statementImport: { select: { periodStart: true, periodEnd: true } } },
  });
  const firsts = await db.statementImport.groupBy({ by: ["accountId"], where: { isSummary: false, account: { subtype: "BILL" } }, _min: { periodStart: true } });
  const firstStart = new Map(firsts.map((f) => [f.accountId, f._min.periodStart?.getTime()]));
  const bills: BillLeg[] = billRows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    date: iso(r.date),
    precision: r.datePrecision === "PERIOD" ? "PERIOD" : "EXACT",
    periodStart: iso(r.statementImport!.periodStart),
    periodEnd: iso(r.statementImport!.periodEnd),
    amountCents: r.amountCents,
    firstBill: firstStart.get(r.accountId) === r.statementImport!.periodStart.getTime(),
  }));
  if (bills.length === 0) return { bills, bank: [] };
  const from = addDays(bills.map((b) => (b.precision === "PERIOD" ? b.periodStart : b.date)).sort()[0]!, -WINDOW_DAYS);
  const to = addDays(bills.map((b) => (b.precision === "PERIOD" ? b.periodEnd : b.date)).sort().at(-1)!, WINDOW_DAYS);
  const bankRows = await db.transaction.findMany({
    where: {
      lane: "EXPENSE",
      amountCents: { lt: 0 },
      userLocked: false,
      transferLeg: null,
      datePrecision: "EXACT",
      date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
      category: { name: "Housing & utilities" },
      account: { type: { in: ["CHECKING", "SAVINGS"] } },
      statementImport: { isSummary: false, status: "COMMITTED" },
    },
    select: { id: true, date: true, amountCents: true, payee: true },
    orderBy: [{ date: "asc" }, { id: "asc" }],
  });
  const bank = bankRows
    .filter((r) => !NOT_RENT.has(categorizeMerchant(r.payee ?? "", undefined, merchantRules) ?? ""))
    .map((r) => ({ id: r.id, date: iso(r.date), amountCents: r.amountCents }));
  return { bills, bank };
}
