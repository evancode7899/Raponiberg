import type { Prisma, PrismaClient, TransactionLane } from "@prisma/client";
import { householdPatterns } from "../household/householdFile.ts";
import { getMergeDate } from "../ledger/householdSettings.ts";
import type { AccountSubtype } from "../ingest/types.ts";
import { classifyTransaction, recurringCheckCategory, type Classification, type ClassifyContext } from "./classify.ts";
import { isRelabel, readStash } from "../transfers/relabel.ts";
import { readRules, saveRules } from "./ruleStore.ts";
import { CATEGORIES, LEGACY_ROLLUP, rollupCategory, type Lane } from "./taxonomy.ts";

type Db = PrismaClient | Prisma.TransactionClient;

/** Creates any missing taxonomy categories; returns name → id for all categories. */
export async function ensureCategories(db: Db): Promise<Map<string, string>> {
  const existing = await db.category.findMany({ select: { id: true, name: true } });
  const byName = new Map(existing.map((c) => [c.name, c.id]));
  let order = existing.length;
  for (const def of CATEGORIES) {
    if (byName.has(def.name)) continue;
    const created = await db.category.create({
      data: { name: def.name, kind: def.kind, groupName: def.group, displayOrder: order++ },
    });
    byName.set(def.name, created.id);
  }
  await consolidateLegacyCategories(db, byName);
  return byName;
}

/**
 * Folds stored rows, merchant rules and budget lines under retired spending categories
 * into the ten current ones, then deletes the retired categories. Idempotent.
 */
async function consolidateLegacyCategories(db: Db, byName: Map<string, string>): Promise<void> {
  for (const [legacy, target] of Object.entries(LEGACY_ROLLUP)) {
    const fromId = byName.get(legacy);
    const toId = byName.get(target);
    if (!fromId || !toId || fromId === toId) continue;
    await db.transaction.updateMany({ where: { categoryId: fromId }, data: { categoryId: toId } });
    await db.merchantCategoryRule.updateMany({ where: { categoryId: fromId }, data: { categoryId: toId } });
    const lines = await db.budgetLine.findMany({ where: { categoryId: fromId } });
    for (const l of lines) {
      const existing = await db.budgetLine.findUnique({
        where: { year_month_categoryId: { year: l.year, month: l.month, categoryId: toId } },
      });
      if (existing) {
        await db.budgetLine.update({ where: { id: existing.id }, data: { amountCents: existing.amountCents + l.amountCents } });
        await db.budgetLine.delete({ where: { id: l.id } });
      } else {
        await db.budgetLine.update({ where: { id: l.id }, data: { categoryId: toId } });
      }
    }
    await db.category.delete({ where: { id: fromId } });
    byName.delete(legacy);
  }
}

/**
 * Keeps the merchant rules in the database and the rules file (ruleStore.ts) in step: a
 * rule only in the database is saved to the file (the database wins where both have one,
 * since every edit lands there first), and a rule only in the file — e.g. after the
 * database was rebuilt — is restored. Runs at the start of every ledger refresh.
 */
export async function syncMerchantRules(db: Db): Promise<{ saved: number; restored: number }> {
  const file = readRules();
  const categoryIds = await ensureCategories(db);
  const inDb = await db.merchantCategoryRule.findMany({ include: { category: { select: { name: true } } } });
  const saved = saveRules(
    inDb.map((r) => ({ merchantKey: r.matchPattern, category: rollupCategory(r.category.name), lane: (r.lane as Lane | null) ?? null, source: r.source })),
  );
  const known = new Set(inDb.map((r) => r.matchPattern));
  let restored = 0;
  for (const r of file.rules) {
    const categoryId = categoryIds.get(rollupCategory(r.category));
    if (known.has(r.merchantKey) || !categoryId) continue;
    await db.merchantCategoryRule.create({
      data: { matchPattern: r.merchantKey, categoryId, lane: (r.lane ?? null) as TransactionLane | null, source: r.source },
    });
    restored++;
  }
  return { saved, restored };
}

export async function loadClassifyContext(db: Db): Promise<ClassifyContext> {
  const [mergeDate, rules] = await Promise.all([
    getMergeDate(db),
    db.merchantCategoryRule.findMany({ include: { category: { select: { name: true } } } }),
  ]);
  return {
    mergeDate,
    userRules: rules.map((r) => ({ merchantKey: r.matchPattern, category: rollupCategory(r.category.name), lane: r.lane ?? null })),
    household: householdPatterns(),
  };
}

/** Transaction columns written from a classification. */
export function classificationData(c: Classification, categoryIds: Map<string, string>) {
  return {
    lane: c.lane as TransactionLane,
    categoryId: categoryIds.get(c.category) ?? null,
    merchantKey: c.merchantKey,
    counterpartyKind: c.counterparty.kind,
    counterpartyInstitution: c.counterparty.institution ?? null,
    counterpartyAccountHint: c.counterparty.accountHint ?? null,
    counterpartySubtypes: c.counterparty.subtypes?.join(",") ?? null,
    classifiedBy: c.ruleId,
    confidence: c.confidence,
    needsReview: c.needsReview,
  };
}

type RowForClassify = {
  id: string;
  date: Date;
  amountCents: number;
  payee: string | null;
  section: string | null;
  detail: string | null;
  account: { institution: string | null; subtype: string | null; type: string };
};

export function classifyRow(r: RowForClassify, ctx: ClassifyContext): Classification {
  return classifyTransaction(
    {
      institution: r.account.institution ?? "",
      accountSubtype: (r.account.subtype ?? r.account.type) as AccountSubtype,
      section: r.section ?? undefined,
      description: r.payee ?? "",
      detail: r.detail ?? undefined,
      amountCents: r.amountCents,
      date: r.date.toISOString().slice(0, 10),
    },
    ctx,
  );
}

/**
 * Re-runs the classifier over statement rows the owner hasn't hand-edited (all of them,
 * or a subset), e.g. after teaching a merchant rule, changing the merge date or upgrading
 * the rules — every ledger refresh runs it. Only rows the rules now file differently are
 * written:
 *  - a row the transfer matcher relabelled is compared by its classification before the
 *    relabel (the matcher re-applies relabels on every run); when that changed, the
 *    relabel is cleared and the matcher decides again;
 *  - a row the owner marked reviewed stays reviewed unless its lane or category changes;
 *  - a change to the counterparty alone (what transfer matching keys on) is written too.
 */
export async function reclassifyRows(db: Db, opts: { transactionIds?: string[]; merchantKey?: string } = {}): Promise<number> {
  const [ctx, categoryIds] = await Promise.all([loadClassifyContext(db), ensureCategories(db)]);
  const rows = await db.transaction.findMany({
    where: {
      userLocked: false,
      statementImportId: { not: null },
      statementImport: { isSummary: false },
      ...(opts.transactionIds ? { id: { in: opts.transactionIds } } : {}),
      ...(opts.merchantKey ? { merchantKey: opts.merchantKey } : {}),
    },
    select: {
      id: true,
      date: true,
      amountCents: true,
      payee: true,
      section: true,
      detail: true,
      lane: true,
      categoryId: true,
      classifiedBy: true,
      needsReview: true,
      merchantKey: true,
      counterpartyKind: true,
      counterpartyInstitution: true,
      counterpartyAccountHint: true,
      counterpartySubtypes: true,
      confidence: true,
      memo: true,
      account: { select: { institution: true, subtype: true, type: true } },
    },
  });
  let changed = 0;
  for (const r of rows) {
    const data = classificationData(classifyRow(r, ctx), categoryIds);
    // What the rules last gave the row, before any relabel by the transfer matcher.
    const stash = isRelabel(r.classifiedBy) ? (readStash(r.memo) ?? {}) : null;
    const before = stash
      ? {
          lane: stash.lane ?? r.lane,
          categoryId: stash.categoryId ?? null,
          classifiedBy: stash.classifiedBy ?? null,
          needsReview: stash.needsReview ?? r.needsReview,
          // A stash from before counterparties were kept can't be restored exactly: such a
          // row is re-filed now, and the matcher relabels it again with a full stash.
          counterpartyKind: stash.counterpartyKind,
        }
      : r;
    // The recurring-check pass (run right after) upgrades its own rows again.
    if (r.classifiedBy === "recurring-check" && data.classifiedBy === "bank-check") continue;
    const refiled = data.lane !== before.lane || data.categoryId !== before.categoryId;
    // The owner's "reviewed" mark stands until the row is filed differently.
    const needsReview = refiled ? data.needsReview : before.needsReview && data.needsReview;
    if (
      refiled ||
      data.classifiedBy !== before.classifiedBy ||
      needsReview !== before.needsReview ||
      data.counterpartyKind !== before.counterpartyKind ||
      data.merchantKey !== r.merchantKey ||
      data.counterpartyInstitution !== r.counterpartyInstitution ||
      data.counterpartyAccountHint !== r.counterpartyAccountHint ||
      data.counterpartySubtypes !== r.counterpartySubtypes ||
      data.confidence !== r.confidence
    ) {
      // A relabelled row loses its relabel; the matcher decides again.
      await db.transaction.update({ where: { id: r.id }, data: { ...data, needsReview, memo: null } });
      changed++;
    }
  }
  return changed;
}

/**
 * Same-amount checks recurring across ≥3 months are rent; relabels them (unless the
 * owner already labelled them) so they stop sitting in review.
 */
export async function applyRecurringChecks(db: Db): Promise<number> {
  const categoryIds = await ensureCategories(db);
  const housing = categoryIds.get("Housing & utilities")!;
  const checks = await db.transaction.findMany({
    where: { classifiedBy: { in: ["bank-check", "recurring-check"] }, userLocked: false },
    select: { id: true, payee: true, amountCents: true, date: true, accountId: true, classifiedBy: true },
  });
  const byAccount = new Map<string, typeof checks>();
  for (const c of checks) byAccount.set(c.accountId, [...(byAccount.get(c.accountId) ?? []), c]);
  let n = 0;
  for (const rows of byAccount.values()) {
    const mapped = recurringCheckCategory(
      rows.map((r) => ({ ...r, description: r.payee ?? "", date: r.date.toISOString().slice(0, 10) })),
    );
    const rentIds = new Set([...mapped.keys()].map((r) => r.id));
    for (const r of rows) {
      const isRent = rentIds.has(r.id);
      if (isRent && r.classifiedBy !== "recurring-check") {
        await db.transaction.update({
          where: { id: r.id },
          data: { categoryId: housing, classifiedBy: "recurring-check", needsReview: false, confidence: "medium" },
        });
        n++;
      }
    }
  }
  return n;
}
