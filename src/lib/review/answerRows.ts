import type { Prisma, PrismaClient, TransactionLane } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { isGenericMerchantKey } from "../classifier/merchants.ts";
import { ensureCategories, reclassifyRows } from "../classifier/persist.ts";
import { readRules, restoreRule, saveRules, type SavedRule } from "../classifier/ruleStore.ts";
import type { Lane } from "../classifier/taxonomy.ts";
import { decisionsFor, recordRowDecisionsFor, restoreRowDecisions, type RowDecision } from "./rowDecisions.ts";
import type { RowFingerprint } from "./rowFingerprint.ts";

/**
 * The owner's answer to one question about one or more rows: a category and/or how they
 * count, a rule for the merchant, or "the classifier was right". Every row of an answer
 * changes together in one database transaction, so a failure part-way leaves nothing half
 * answered, and the caller refreshes the ledger once, not once per row.
 *
 * Each answer can be taken back while the app stays open. What it replaced is kept here, on
 * the server, so undo puts back exactly that and never values a page sends.
 */

type Db = PrismaClient;

export type RowAnswer = {
  ids: string[];
  category?: string;
  lane?: Lane;
  /** Teach a rule for the rows' merchant: every past and future row from it follows. */
  applyToMerchant?: boolean;
  /** Keep the classifier's answer and clear the flag. */
  reviewed?: boolean;
};

/** A row's filing, as an answer found or left it. */
const filing = { id: true, categoryId: true, lane: true, classifiedBy: true, confidence: true, needsReview: true, userLocked: true, memo: true } as const;
type Filing = Prisma.TransactionGetPayload<{ select: typeof filing }>;

type Undo = {
  rows: Filing[];
  /** The filing the answer left each row with: undo stops if it has changed since. */
  after: Map<string, { categoryId: string | null; lane: string | null }>;
  decisions: { row: RowFingerprint; previous: RowDecision | null }[];
  rule: { merchantKey: string; previous: SavedRule | null; previousDb: { categoryId: string; lane: TransactionLane | null; source: "USER" | "LLM_PROMOTED" } | null } | null;
};

const KEPT = 30;
// On globalThis: each route is bundled separately, and they must share one list.
const g = globalThis as unknown as { __pfAnswerUndo?: Map<string, Undo> };
const undos = () => (g.__pfAnswerUndo ??= new Map<string, Undo>());

export class AnswerError extends Error {
  status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409) {
    super(message);
    this.status = status;
  }
}

export type AnswerResult = {
  affected: number;
  /** Takes this answer back (undoAnswer), while the app stays open. */
  undoId: string;
  /** Lanes or a whole merchant moved, so transfers must be matched again. */
  needsRefresh: boolean;
  /** For the audit log: each answered row's category and lane before and after. */
  audit: { id: string; before: { category: string | null; lane: string | null }; after: { category: string | null; lane: string | null } }[];
  merchantKey: string | null;
};

export async function answerRows(db: Db, a: RowAnswer): Promise<AnswerResult> {
  const ids = [...new Set(a.ids)];
  if (!ids.length) throw new AnswerError("No rows to change", 400);
  if (!a.category && !a.lane && !a.reviewed) throw new AnswerError("Nothing to change", 400);
  const before = await db.transaction.findMany({ where: { id: { in: ids } }, select: { ...filing, merchantKey: true, category: { select: { name: true } } } });
  if (before.length !== ids.length) throw new AnswerError("Not found", 404);
  const categoryIds = await ensureCategories(db);
  const categoryId = a.category ? categoryIds.get(a.category) : undefined;
  if (a.category && !categoryId) throw new AnswerError(`Unknown category: ${a.category}`, 400);

  const merchantKey = before[0]!.merchantKey;
  if (a.applyToMerchant && (!merchantKey || isGenericMerchantKey(merchantKey) || !categoryId || before.some((r) => r.merchantKey !== merchantKey)))
    throw new AnswerError("This row doesn't name a merchant (e.g. a deposit or check) — set it for this row only.", 400);

  // A rule moves every row of the merchant that wasn't set by hand, so undo keeps them all.
  const touched: Filing[] = a.applyToMerchant ? await db.transaction.findMany({ where: { OR: [{ id: { in: ids } }, { merchantKey, userLocked: false }] }, select: filing }) : before.map(filingOf);
  const ruleBefore = a.applyToMerchant ? await db.merchantCategoryRule.findUnique({ where: { matchPattern: merchantKey! } }) : null;
  const fileBefore = a.applyToMerchant ? (readRules().rules.find((r) => r.merchantKey === merchantKey) ?? null) : null;
  const decisionsBefore = a.applyToMerchant ? [] : await decisionsFor(db, ids);

  let affected = ids.length;
  await db.$transaction(
    async (tx) => {
      if (a.applyToMerchant) {
        const rule = { categoryId: categoryId!, lane: (a.lane ?? null) as TransactionLane | null };
        // The owner's answer replaces an AI-taught rule for the merchant.
        await tx.merchantCategoryRule.upsert({ where: { matchPattern: merchantKey! }, create: { matchPattern: merchantKey!, ...rule }, update: { ...rule, source: "USER" } });
        affected = await reclassifyRows(tx, { merchantKey: merchantKey! });
        await tx.transaction.updateMany({ where: { id: { in: ids } }, data: { needsReview: false } });
      } else if (categoryId || a.lane) {
        await tx.transaction.updateMany({
          where: { id: { in: ids } },
          data: {
            ...(categoryId ? { categoryId } : {}),
            ...(a.lane ? { lane: a.lane as TransactionLane } : {}),
            classifiedBy: "USER",
            confidence: "high",
            needsReview: false,
            userLocked: true,
            memo: null,
          },
        });
      } else {
        await tx.transaction.updateMany({ where: { id: { in: ids } }, data: { needsReview: false } });
      }
    },
    { timeout: 60_000 },
  );
  // Beside the database too, so a re-import or rebuild can't lose the answer.
  if (a.applyToMerchant) saveRules([{ merchantKey: merchantKey!, category: a.category!, lane: a.lane ?? null, source: "USER", note: null }]);
  else await recordRowDecisionsFor(db, ids, { category: a.category ?? null, lane: a.lane ?? null, reviewedOnly: !a.category && !a.lane });

  const left = await db.transaction.findMany({ where: { id: { in: touched.map((r) => r.id) } }, select: { id: true, categoryId: true, lane: true, category: { select: { name: true } } } });
  const undoId = randomUUID();
  const kept = undos();
  kept.set(undoId, {
    rows: touched,
    after: new Map(left.map((r) => [r.id, { categoryId: r.categoryId, lane: r.lane }])),
    decisions: decisionsBefore,
    rule: a.applyToMerchant
      ? { merchantKey: merchantKey!, previous: fileBefore, previousDb: ruleBefore ? { categoryId: ruleBefore.categoryId, lane: ruleBefore.lane, source: ruleBefore.source } : null }
      : null,
  });
  while (kept.size > KEPT) kept.delete(kept.keys().next().value!);

  const now = new Map(left.map((r) => [r.id, r]));
  return {
    affected,
    undoId,
    needsRefresh: Boolean(a.applyToMerchant) || (a.lane != null && before.some((r) => r.lane !== a.lane)),
    audit: before.map((r) => ({
      id: r.id,
      before: { category: r.category?.name ?? null, lane: r.lane },
      after: { category: now.get(r.id)?.category?.name ?? null, lane: now.get(r.id)?.lane ?? null },
    })),
    merchantKey: a.applyToMerchant ? merchantKey : null,
  };
}

/** Takes an answer back: the rows, the merchant's rule and the saved decisions as they were. Returns the rows put back. */
export async function undoAnswer(db: Db, undoId: string): Promise<string[]> {
  const u = undos().get(undoId);
  if (!u) throw new AnswerError("That change can't be undone any more (the app restarted, or many changes came after it).", 404);
  const now = await db.transaction.findMany({ where: { id: { in: u.rows.map((r) => r.id) } }, select: { id: true, categoryId: true, lane: true } });
  const changed = now.length !== u.rows.length || now.some((r) => u.after.get(r.id)?.categoryId !== r.categoryId || u.after.get(r.id)?.lane !== r.lane);
  if (changed) throw new AnswerError("These rows changed again since, so undoing would lose that. Change them by hand instead.", 409);

  // The files first: the next refresh re-applies what they hold.
  if (u.rule) restoreRule(u.rule.merchantKey, u.rule.previous);
  else restoreRowDecisions(u.decisions);
  await db.$transaction(
    async (tx) => {
      if (u.rule) {
        const { merchantKey, previousDb } = u.rule;
        if (previousDb) await tx.merchantCategoryRule.update({ where: { matchPattern: merchantKey }, data: previousDb });
        else await tx.merchantCategoryRule.deleteMany({ where: { matchPattern: merchantKey } });
      }
      for (const { id, ...data } of u.rows) await tx.transaction.update({ where: { id }, data });
    },
    { timeout: 60_000 },
  );
  undos().delete(undoId);
  return u.rows.map((r) => r.id);
}

function filingOf({ id, categoryId, lane, classifiedBy, confidence, needsReview, userLocked, memo }: Filing): Filing {
  return { id, categoryId, lane, classifiedBy, confidence, needsReview, userLocked, memo };
}
