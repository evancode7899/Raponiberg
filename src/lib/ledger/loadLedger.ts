import type { Prisma, PrismaClient } from "@prisma/client";
import type { Lane } from "../classifier/taxonomy.ts";
import { daysBetween, localToday } from "../dates/isoDate.ts";
import type { AccountSubtype } from "../ingest/types.ts";
import { bookBill, type BillRowBooking, type BillStatement } from "./billBooking.ts";
import { getMergeDate } from "./householdSettings.ts";
import { buildTimeline, type AccountTimeline, type SegmentInput } from "./timeline.ts";
import { billAccountIds, transferDifferenceAdjustments } from "./transferFees.ts";

type Db = PrismaClient | Prisma.TransactionClient;

export type AccountGroup =
  | "Cash"
  | "Credit cards"
  | "Taxable investments"
  | "Retirement"
  | "Education (529)"
  | "Health savings"
  | "Other";

export const GROUP_ORDER: AccountGroup[] = [
  "Cash",
  "Taxable investments",
  "Retirement",
  "Education (529)",
  "Health savings",
  "Other",
  "Credit cards",
];

export function groupFor(subtype: string | null, type: string): AccountGroup {
  switch (subtype ?? type) {
    case "CHECKING":
    case "SAVINGS":
    case "CASH":
      return "Cash";
    case "CREDIT_CARD":
    // A landlord's bill is owed like a card and paid off like one.
    case "BILL":
      return "Credit cards";
    case "BROKERAGE":
    case "INVESTMENT":
      return "Taxable investments";
    case "ROTH_IRA":
    case "TRADITIONAL_IRA":
    case "ROLLOVER_IRA":
    case "401K":
      return "Retirement";
    case "529":
      return "Education (529)";
    case "HSA":
      return "Health savings";
    default:
      return "Other";
  }
}

export type LedgerAccount = {
  id: string;
  name: string;
  institution: string | null;
  type: string;
  subtype: AccountSubtype | null;
  group: AccountGroup;
  /** Market-valued account (growth/fees exist), as opposed to bank/card. */
  isInvestment: boolean;
  timeline: AccountTimeline;
  statementCount: number;
  /** Closed: last statement ended at zero and nothing newer arrived. */
  closed: boolean;
};

export type Ledger = {
  accounts: LedgerAccount[];
  mergeDate: string;
  /** YYYY-MM-DD — last day every open account has a statement for. */
  completeThrough: string | null;
  /** YYYY-MM-DD — first day any account has a statement for. */
  firstDay: string | null;
  /** How each row of a landlord's bill is booked (billBooking.ts); the Book's rows follow it. */
  billRows?: ReadonlyMap<string, BillRowBooking>;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Loads committed statements (with their classified rows) into per-account timelines.
 * Only COMMITTED imports count; summaries are passed separately to fill gaps.
 */
export async function loadLedger(db: Db, opts: { today?: string } = {}): Promise<Ledger> {
  const [accounts, imports, mergeDate] = await Promise.all([
    // Archived accounts included: archiving hides an account from pickers, never its history from figures.
    db.account.findMany({ orderBy: [{ displayOrder: "asc" }, { name: "asc" }] }),
    db.statementImport.findMany({
      where: { status: "COMMITTED" },
      orderBy: { periodStart: "asc" },
      select: {
        id: true,
        accountId: true,
        isSummary: true,
        periodStart: true,
        periodEnd: true,
        openingBalanceCents: true,
        closingBalanceCents: true,
        growthCents: true,
        feesCents: true,
        transactions: { select: { id: true, date: true, datePrecision: true, amountCents: true, lane: true } },
      },
    }),
    getMergeDate(db),
  ]);
  const today = opts.today ?? localToday();

  const lossy = await db.transferMatch.findMany({
    where: { status: "CONFIRMED", differenceCents: { not: 0 } },
    select: { differenceCents: true, legs: { select: { transaction: { select: { id: true, amountCents: true, accountId: true } } } } },
  });
  const bills = billAccountIds(accounts);
  const transferFees = transferDifferenceAdjustments(
    lossy.map((m) => ({ differenceCents: m.differenceCents, legs: m.legs.map((l) => l.transaction) })),
    bills,
  );
  // The bank payments that paid each bill row, so the bill books them on the bank's days.
  const paidBy = new Map<string, { date: string; amountCents: number }[]>();
  if (bills.size) {
    const pairs = await db.transferMatch.findMany({
      where: { legs: { some: { transaction: { accountId: { in: [...bills] } } } } },
      select: { legs: { select: { transaction: { select: { id: true, accountId: true, date: true, amountCents: true } } } } },
    });
    for (const m of pairs) {
      const legs = m.legs.map((l) => l.transaction);
      const bill = legs.filter((l) => bills.has(l.accountId));
      if (bill.length !== 1) continue;
      paidBy.set(
        bill[0]!.id,
        legs.filter((l) => l !== bill[0]).map((l) => ({ date: iso(l.date), amountCents: l.amountCents })),
      );
    }
  }

  const byAccount = new Map<string, { statements: SegmentInput[]; summaries: SegmentInput[] }>();
  const billStatements = new Map<string, BillStatement[]>();
  for (const s of imports) {
    if (bills.has(s.accountId) && !s.isSummary) {
      const list = billStatements.get(s.accountId) ?? [];
      list.push({
        importId: s.id,
        periodStart: iso(s.periodStart),
        periodEnd: iso(s.periodEnd),
        openingCents: s.openingBalanceCents,
        closingCents: s.closingBalanceCents,
        rows: s.transactions.map((t) => ({
          id: t.id,
          date: iso(t.date),
          precision: t.datePrecision === "PERIOD" ? "PERIOD" : "EXACT",
          amountCents: t.amountCents,
          lane: (t.lane ?? "EXPENSE") as Lane,
        })),
      });
      billStatements.set(s.accountId, list);
      continue;
    }
    // A lossy transfer's shortfall leaves the transfer flow and becomes a fee (or
    // growth, if positive) on the sending account; the segment still ties out.
    let growthCents = s.growthCents;
    let feesCents = s.feesCents;
    const flows = s.transactions.map((t) => {
      const d = transferFees.get(t.id) ?? 0;
      const date = iso(t.date);
      const precision = (t.datePrecision === "PERIOD" ? "PERIOD" : "EXACT") as "PERIOD" | "EXACT";
      const flow = { id: t.id, date, precision, amountCents: t.amountCents - d, lane: (t.lane ?? "EXPENSE") as Lane };
      if (d < 0) feesCents += d;
      else growthCents += d;
      return flow;
    });
    const seg: SegmentInput = {
      accountId: s.accountId,
      importId: s.id,
      periodStart: iso(s.periodStart),
      periodEnd: iso(s.periodEnd),
      openingCents: s.openingBalanceCents,
      closingCents: s.closingBalanceCents,
      growthCents,
      feesCents,
      flows,
    };
    const bucket = byAccount.get(s.accountId) ?? { statements: [], summaries: [] };
    (s.isSummary ? bucket.summaries : bucket.statements).push(seg);
    byAccount.set(s.accountId, bucket);
  }
  // A landlord's bill books every row on its own day (billBooking.ts); a landlord's
  // unitemized change to its bill is spending on the bill.
  const billRows = new Map<string, BillRowBooking>();
  for (const [accountId, list] of billStatements) {
    const booked = bookBill(accountId, list, paidBy, transferFees);
    for (const [id, b] of booked.rows) billRows.set(id, b);
    const bucket = byAccount.get(accountId) ?? { statements: [], summaries: [] };
    bucket.statements = booked.segments;
    byAccount.set(accountId, bucket);
  }

  const out: LedgerAccount[] = [];
  for (const a of accounts) {
    const data = byAccount.get(a.id);
    if (!data || data.statements.length === 0) continue;
    const timeline = buildTimeline(a.id, data.statements, data.summaries);
    out.push({
      id: a.id,
      name: a.name,
      institution: a.institution,
      type: a.type,
      subtype: (a.subtype as AccountSubtype | null) ?? null,
      group: groupFor(a.subtype, a.type),
      isInvestment: a.type === "INVESTMENT",
      timeline,
      statementCount: data.statements.length,
      closed: false,
    });
  }
  const ledger: Ledger = { accounts: out, mergeDate, completeThrough: null, firstDay: null, billRows };
  refreshLedgerStatus(ledger, today);
  return ledger;
}

/**
 * Recomputes each account's closed flag and the ledger's complete-through / first day
 * from the timelines (after the Book fills proven idle windows, for instance).
 */
export function refreshLedgerStatus(ledger: Ledger, today: string) {
  for (const a of ledger.accounts) {
    const last = a.timeline.segments.at(-1)!;
    a.closed = last.closing === 0 && daysBetween(a.timeline.lastDay!, today) > 45;
  }
  const open = ledger.accounts.filter((a) => !a.closed);
  ledger.completeThrough = open.length ? open.map((a) => a.timeline.lastDay!).sort()[0]! : null;
  ledger.firstDay = ledger.accounts.length ? ledger.accounts.map((a) => a.timeline.firstDay!).sort()[0]! : null;
}
