import type { Prisma, PrismaClient } from "@prisma/client";
import { ensureCategories } from "../classifier/persist.ts";
import { readDecisions, recordConfirmed, resolveLegs, sameLegs, type LegFingerprint } from "./decisionStore.ts";
import { legKey } from "./matchTransfers.ts";

type Db = PrismaClient | Prisma.TransactionClient;

const rowSelect = {
  id: true,
  date: true,
  amountCents: true,
  account: { select: { institution: true, aliases: { select: { identifier: true } } } },
} as const;

type FingerprintRow = { id: string; date: Date; amountCents: number; account: { institution: string | null; aliases: { identifier: string }[] } };

const toFingerprint = (r: FingerprintRow): LegFingerprint & { id: string } => ({
  id: r.id,
  institution: r.account.institution ?? "",
  identifiers: r.account.aliases.map((a) => a.identifier),
  date: r.date.toISOString().slice(0, 10),
  amountCents: r.amountCents,
});

/** What identifies these rows across re-imports (see decisionStore.ts), in the given order. */
export async function legFingerprints(db: Db, ids: string[]): Promise<LegFingerprint[]> {
  const rows = await db.transaction.findMany({ where: { id: { in: ids } }, select: rowSelect });
  return ids.flatMap((id) => {
    const r = rows.find((x) => x.id === id);
    if (!r) return [];
    const { id: _, ...fp } = toFingerprint(r);
    return [fp];
  });
}

/** Marks rows as an owner-confirmed transfer and pairs them. */
export async function createConfirmedMatch(db: Db, ids: string[], differenceCents: number, note: string | null) {
  const categoryIds = await ensureCategories(db);
  await db.transaction.updateMany({
    where: { id: { in: ids } },
    data: {
      lane: "TRANSFER",
      categoryId: categoryIds.get("Own-account transfers") ?? null,
      counterpartyKind: "OWN_ACCOUNT",
      classifiedBy: "USER",
      needsReview: false,
      userLocked: true,
      memo: null,
    },
  });
  return db.transferMatch.create({
    data: { status: "CONFIRMED", method: "MANUAL", differenceCents, note, legs: { create: ids.map((transactionId) => ({ transactionId })) } },
  });
}

/**
 * Re-applies the owner's saved transfer decisions to today's rows, so a re-imported
 * statement (new row ids) keeps its confirmed pairings and rejections. Confirmed matches
 * already in the database but missing from the file are saved to it first. Runs before
 * AUTO matching, with no AUTO matches present.
 */
export async function applyTransferDecisions(db: Db): Promise<{ restored: number; waiting: number }> {
  const inDb = await db.transferMatch.findMany({
    where: { status: "CONFIRMED" },
    select: { differenceCents: true, note: true, legs: { select: { transactionId: true } } },
  });
  let saved = readDecisions();
  for (const m of inDb) {
    const legs = await legFingerprints(db, m.legs.map((l) => l.transactionId));
    if (legs.length === m.legs.length && !saved.confirmed.some((c) => sameLegs(c.legs, legs))) {
      saved = recordConfirmed({ legs, differenceCents: m.differenceCents, note: m.note });
    }
  }
  if (saved.confirmed.length === 0 && saved.rejected.length === 0) return { restored: 0, waiting: 0 };

  const amounts = [...new Set([...saved.confirmed, ...saved.rejected].flatMap((d) => d.legs.map((l) => l.amountCents)))];
  // Only statement rows can be legs (as in matching): a year-end summary repeating a
  // transfer would otherwise make the leg look ambiguous and the decision wait forever.
  const rows = (await db.transaction.findMany({ where: { amountCents: { in: amounts }, statementImport: { isSummary: false } }, select: rowSelect })).map(toFingerprint);
  const confirmedLegs = new Set(
    (await db.transferLeg.findMany({ where: { match: { status: "CONFIRMED" } }, select: { transactionId: true } })).map((l) => l.transactionId),
  );

  let restored = 0;
  let waiting = 0;
  for (const d of saved.confirmed) {
    const ids = resolveLegs(d.legs, rows);
    if (!ids) {
      waiting++;
      continue;
    }
    if (ids.some((id) => confirmedLegs.has(id))) continue;
    await createConfirmedMatch(db, ids, d.differenceCents, d.note);
    ids.forEach((id) => confirmedLegs.add(id));
    restored++;
  }
  for (const d of saved.rejected) {
    const ids = resolveLegs(d.legs, rows);
    if (!ids) continue;
    const key = legKey(ids);
    await db.transferRejection.upsert({ where: { legKey: key }, create: { legKey: key }, update: {} });
  }
  return { restored, waiting };
}
