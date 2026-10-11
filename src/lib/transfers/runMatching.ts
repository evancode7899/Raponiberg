import type { Prisma, PrismaClient, TransactionLane } from "@prisma/client";
import { ensureCategories } from "../classifier/persist.ts";
import { householdPatterns } from "../household/householdFile.ts";
import { addDays } from "../dates/isoDate.ts";
import { getMergeDate } from "../ledger/householdSettings.ts";
import type { AccountSubtype } from "../ingest/types.ts";
import { applyTransferDecisions } from "./applyDecisions.ts";
import { readDecisions } from "./decisionStore.ts";
import { matchTransfers, type Leg, type MatchResult } from "./matchTransfers.ts";
import { isRelabel, readStash, RELABEL, type RelabelStash } from "./relabel.ts";

export { RELABEL } from "./relabel.ts";

type Db = PrismaClient | Prisma.TransactionClient;

/** Classifier rules whose rows may secretly be the other leg of a transfer. */
export const UNKNOWN_SOURCE_RULES = ["bank-deposit", "fallback", "bank-branch-withdrawal"];

export async function loadLegs(db: Db): Promise<{ legs: Leg[]; confirmedLegIds: Set<string> }> {
  const confirmed = await db.transferLeg.findMany({
    where: { match: { status: "CONFIRMED" } },
    select: { transactionId: true },
  });
  const confirmedLegIds = new Set(confirmed.map((c) => c.transactionId));
  const rows = await db.transaction.findMany({
    where: {
      statementImport: { isSummary: false },
      OR: [{ lane: "TRANSFER" }, { classifiedBy: { in: UNKNOWN_SOURCE_RULES }, userLocked: false }],
    },
    select: {
      id: true,
      accountId: true,
      date: true,
      datePrecision: true,
      amountCents: true,
      classifiedBy: true,
      userLocked: true,
      counterpartyInstitution: true,
      counterpartyAccountHint: true,
      counterpartySubtypes: true,
      statementImport: { select: { periodStart: true, periodEnd: true } },
      account: { select: { institution: true, subtype: true, type: true, aliases: { select: { identifier: true } } } },
    },
  });
  const legs: Leg[] = [];
  for (const r of rows) {
    if (confirmedLegIds.has(r.id)) continue;
    const unknown = !r.userLocked && UNKNOWN_SOURCE_RULES.includes(r.classifiedBy ?? "");
    legs.push({
      id: r.id,
      accountId: r.accountId,
      institution: r.account.institution ?? "",
      subtype: (r.account.subtype ?? r.account.type) as AccountSubtype,
      identifiers: r.account.aliases.map((a) => a.identifier),
      date: r.date.toISOString().slice(0, 10),
      datePrecision: r.datePrecision === "PERIOD" ? "PERIOD" : "EXACT",
      periodStart: r.statementImport!.periodStart.toISOString().slice(0, 10),
      periodEnd: r.statementImport!.periodEnd.toISOString().slice(0, 10),
      amountCents: r.amountCents,
      role: unknown ? "UNKNOWN" : "TRANSFER",
      counterpartyInstitution: unknown ? null : r.counterpartyInstitution,
      counterpartyAccountHint: unknown ? null : r.counterpartyAccountHint,
      counterpartySubtypes: unknown ? null : ((r.counterpartySubtypes?.split(",").filter(Boolean) as AccountSubtype[]) ?? null),
    });
  }
  return { legs, confirmedLegIds };
}

export async function computeMatches(db: Db): Promise<{ result: MatchResult; legs: Leg[] }> {
  const { legs } = await loadLegs(db);
  const rejections = await db.transferRejection.findMany({ select: { legKey: true } });
  return { result: matchTransfers(legs, rejections.map((r) => r.legKey)), legs };
}

async function relabel(
  db: Db,
  id: string,
  prefix: string,
  data: { lane: TransactionLane; categoryId: string | null; counterpartyKind: string },
): Promise<void> {
  const row = await db.transaction.findUnique({
    where: { id },
    select: { lane: true, categoryId: true, classifiedBy: true, needsReview: true, counterpartyKind: true },
  });
  if (!row || isRelabel(row.classifiedBy)) return;
  const stash: RelabelStash = row;
  await db.transaction.update({
    where: { id },
    data: {
      ...data,
      classifiedBy: `${prefix}${row.classifiedBy}`,
      needsReview: false,
      memo: JSON.stringify(stash),
    },
  });
}

/**
 * Recomputes every AUTO match from scratch (owner-confirmed ones are kept), so the
 * outcome never depends on upload order. Then:
 *   - unknown-source rows that turn out to be a transfer's other leg become transfers;
 *   - a bank→card payment that no tracked card received becomes spending ("Untracked
 *     card payments"), when the institution's cards are on file for that date (it paid a
 *     card we don't track) or the payment predates them (it paid charges never on file).
 *     Payments after the latest card statement stay transfers: the next statement will
 *     show them arriving;
 *   - a payment on the partner's card that no tracked bank account sent becomes partner
 *     money (the partner paid it from their own account).
 */
export async function runTransferMatching(
  db: Db,
): Promise<{ matched: number; ambiguous: number; promoted: number; untrackedCardPayments: number }> {
  // Before changing anything: a damaged decisions file stops the run here, with the
  // ledger as it was, rather than half-way through with every pairing undone.
  readDecisions();
  await db.transferMatch.deleteMany({ where: { status: "AUTO" } });
  const relabelled = await db.transaction.findMany({
    where: { OR: Object.values(RELABEL).map((p) => ({ classifiedBy: { startsWith: p } })) },
    select: { id: true, memo: true, counterpartyKind: true },
  });
  for (const p of relabelled) {
    const original = readStash(p.memo) ?? {};
    await db.transaction.update({
      where: { id: p.id },
      data: {
        lane: (original.lane as TransactionLane | undefined) ?? "TRANSFER",
        categoryId: original.categoryId ?? null,
        classifiedBy: original.classifiedBy ?? null,
        needsReview: original.needsReview ?? true,
        // Stashes written before the counterparty was kept leave it as it is.
        counterpartyKind: original.counterpartyKind !== undefined ? original.counterpartyKind : p.counterpartyKind,
        memo: null,
      },
    });
  }
  // Owner decisions outlive the rows they were made on (a re-import gives rows new ids).
  await applyTransferDecisions(db);

  const categoryIds = await ensureCategories(db);
  const { result, legs } = await computeMatches(db);
  const byId = new Map(legs.map((l) => [l.id, l]));
  let promoted = 0;
  const matchedIds = new Set<string>();
  for (const m of result.matches) {
    await db.transferMatch.create({
      data: { status: "AUTO", method: m.method, legs: { create: m.legIds.map((transactionId) => ({ transactionId })) } },
    });
    for (const id of m.legIds) {
      matchedIds.add(id);
      if (byId.get(id)?.role !== "UNKNOWN") continue;
      await relabel(db, id, RELABEL.PROMOTED, {
        lane: "TRANSFER",
        categoryId: categoryIds.get("Own-account transfers") ?? null,
        counterpartyKind: "OWN_ACCOUNT",
      });
      promoted++;
    }
  }

  // Card payments nobody received.
  const confirmed = await db.transferLeg.findMany({ select: { transactionId: true } });
  for (const c of confirmed) matchedIds.add(c.transactionId);
  const cardInstitutions = await db.account.findMany({
    where: { type: "CREDIT_CARD" },
    select: { institution: true, statementImports: { where: { isSummary: false }, select: { periodStart: true, periodEnd: true } } },
  });
  // Per card: its statements, and the window it could receive payments in (from its
  // first statement until shortly after its latest one).
  const cards = new Map<string, { periods: { start: string; end: string }[]; first: string; activeUntil: string }[]>();
  for (const a of cardInstitutions) {
    if (!a.institution || a.statementImports.length === 0) continue;
    const periods = a.statementImports
      .map((s) => ({ start: s.periodStart.toISOString().slice(0, 10), end: s.periodEnd.toISOString().slice(0, 10) }))
      .sort((x, y) => x.start.localeCompare(y.start));
    cards.set(a.institution, [
      ...(cards.get(a.institution) ?? []),
      { periods, first: periods[0]!.start, activeUntil: addDays(periods.at(-1)!.end, 45) },
    ]);
  }
  let untrackedCardPayments = 0;
  for (const l of legs) {
    if (matchedIds.has(l.id) || l.role !== "TRANSFER" || l.amountCents >= 0) continue;
    if (l.subtype !== "CHECKING" && l.subtype !== "SAVINGS") continue;
    // A transfer to the institution's savings account isn't a card payment.
    if (l.counterpartySubtypes?.length && !l.counterpartySubtypes.includes("CREDIT_CARD")) continue;
    const atInstitution = l.counterpartyInstitution ? cards.get(l.counterpartyInstitution) : undefined;
    if (!atInstitution) continue;
    const settle = addDays(l.date, 6);
    // Cards that could have received this payment.
    const candidates = atInstitution.filter((c) => c.first <= settle && c.activeUntil >= l.date);
    // It reached none of them only if every candidate's statements cover every day it
    // could have posted (cards post up to a few days before the bank's date, and up to
    // `settle` after): one posted in a cycle with no statement isn't on file to be missed.
    const posts = addDays(l.date, -3);
    const coversArrival = (periods: { start: string; end: string }[]) => {
      for (let d = posts; d <= settle; d = addDays(d, 1)) if (!periods.some((p) => p.start <= d && p.end >= d)) return false;
      return true;
    };
    const everyCandidateCovered = candidates.every((c) => coversArrival(c.periods));
    if (!everyCandidateCovered) continue; // a candidate's next statement isn't in yet: still in flight
    await relabel(db, l.id, RELABEL.UNTRACKED_CARD, {
      lane: "EXPENSE",
      categoryId: categoryIds.get("Untracked card payments") ?? null,
      counterpartyKind: "UNTRACKED_CARD",
    });
    untrackedCardPayments++;
  }

  // Payments on the partner's own card that no tracked bank account sent. When every bank
  // account on file around that date has statements for the days before it, the money came
  // from the partner's own (untracked) bank: partner money entering the books.
  const bankPeriods = (
    await db.account.findMany({
      where: { type: { in: ["CHECKING", "SAVINGS"] } },
      select: { statementImports: { where: { isSummary: false }, select: { periodStart: true, periodEnd: true } } },
    })
  )
    .map((a) => a.statementImports.map((s) => ({ start: s.periodStart.toISOString().slice(0, 10), end: s.periodEnd.toISOString().slice(0, 10) })))
    .filter((periods) => periods.length > 0);
  const noBankSent = (date: string) => {
    const from = addDays(date, -6);
    const onFile = bankPeriods.filter((periods) => periods.some((p) => p.start <= date) && periods.some((p) => p.end >= from));
    if (onFile.length === 0) return false;
    for (let d = from; d <= date; d = addDays(d, 1)) {
      if (!onFile.every((periods) => periods.some((p) => p.start <= d && p.end >= d))) return false;
    }
    return true;
  };
  const unsentCardPayments = legs.filter(
    (l) => !matchedIds.has(l.id) && l.role === "TRANSFER" && l.subtype === "CREDIT_CARD" && l.amountCents > 0 && noBankSent(l.date),
  );
  const partnerCard = householdPatterns().partnerCard;
  if (unsentCardPayments.length > 0 && partnerCard) {
    const mergeDate = await getMergeDate(db);
    const rows = await db.transaction.findMany({
      where: { id: { in: unsentCardPayments.map((l) => l.id) }, classifiedBy: "card-payment" },
      select: { id: true, date: true, cardMember: true },
    });
    for (const r of rows) {
      if (!partnerCard.test((r.cardMember ?? "").toUpperCase())) continue;
      const date = r.date.toISOString().slice(0, 10);
      await relabel(db, r.id, RELABEL.PARTNER_PAID, {
        lane: "EXTERNAL_TRANSFER",
        categoryId: categoryIds.get(date < mergeDate ? "Partner contributions (pre-merge)" : "Partner accounts (untracked)") ?? null,
        counterpartyKind: "PARTNER",
      });
    }
  }

  return { matched: result.matches.length, ambiguous: result.ambiguous.length, promoted, untrackedCardPayments };
}
