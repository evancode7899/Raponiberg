import type { Prisma, PrismaClient } from "@prisma/client";
import type { Lane } from "../classifier/taxonomy.ts";
import { daysBetween } from "../dates/isoDate.ts";
import type { AccountSubtype } from "../ingest/types.ts";
import { getMergeDate } from "./householdSettings.ts";
import { buildTimeline, type AccountTimeline, type SegmentInput } from "./timeline.ts";
import { transferDifferenceAdjustments } from "./transferFees.ts";

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
};

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Loads committed statements (with their classified rows) into per-account timelines.
 * Only COMMITTED imports count; summaries are passed separately to fill gaps.
 */
export async function loadLedger(db: Db, opts: { today?: string } = {}): Promise<Ledger> {
  const [accounts, imports, mergeDate] = await Promise.all([
    db.account.findMany({ where: { archivedAt: null }, orderBy: [{ displayOrder: "asc" }, { name: "asc" }] }),
    db.statementImport.findMany({
      where: { status: "COMMITTED" },
      orderBy: { periodStart: "asc" },
      select: {
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
  const today = opts.today ?? iso(new Date());

  const lossy = await db.transferMatch.findMany({
    where: { status: "CONFIRMED", differenceCents: { not: 0 } },
    select: { differenceCents: true, legs: { select: { transaction: { select: { id: true, amountCents: true } } } } },
  });
  const transferFees = transferDifferenceAdjustments(
    lossy.map((m) => ({ differenceCents: m.differenceCents, legs: m.legs.map((l) => l.transaction) })),
  );

  const byAccount = new Map<string, { statements: SegmentInput[]; summaries: SegmentInput[] }>();
  for (const s of imports) {
    // A lossy transfer's shortfall leaves the transfer flow and becomes a fee (or
    // growth, if positive) on the sending account; the segment still ties out.
    let growthCents = s.growthCents;
    let feesCents = s.feesCents;
    const flows = s.transactions.map((t) => {
      const d = transferFees.get(t.id) ?? 0;
      if (d < 0) feesCents += d;
      else growthCents += d;
      return {
        date: iso(t.date),
        precision: (t.datePrecision === "PERIOD" ? "PERIOD" : "EXACT") as "PERIOD" | "EXACT",
        amountCents: t.amountCents - d,
        lane: (t.lane ?? "EXPENSE") as Lane,
      };
    });
    const seg: SegmentInput = {
      accountId: s.accountId,
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
  const ledger: Ledger = { accounts: out, mergeDate, completeThrough: null, firstDay: null };
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
