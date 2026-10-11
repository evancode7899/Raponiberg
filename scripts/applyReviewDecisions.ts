/**
 * Applies review-queue answers decided elsewhere (e.g. a phone/cloud chat) to the local ledger,
 * through the same logic as PATCH /api/transactions/[id].
 *
 * Usage: node scripts/applyReviewDecisions.ts <decisions.json>
 *
 * JSON: [{ "id": "...", "category": "Dining", "lane": "EXPENSE", "applyToMerchant": false },
 *        { "id": "...", "reviewed": true }]            // reviewed alone = keep classifier's answer
 * (category and lane are each optional; a merchant rule needs a category.)
 */
import { prisma } from "../src/lib/db.ts";
import { isGenericMerchantKey } from "../src/lib/classifier/merchants.ts";
import { ensureCategories, reclassifyRows } from "../src/lib/classifier/persist.ts";
import { saveRules } from "../src/lib/classifier/ruleStore.ts";
import { LANES } from "../src/lib/classifier/taxonomy.ts";
import { refreshDerived } from "../src/lib/ledger/maintenance.ts";
import { recordRowDecisionsFor } from "../src/lib/review/rowDecisions.ts";
import { readFileSync } from "node:fs";

type Decision = { id: string; category?: string; lane?: string; applyToMerchant?: boolean; reviewed?: boolean };

const decisions = JSON.parse(readFileSync(process.argv[2], "utf8")) as Decision[];
const categoryIds = await ensureCategories(prisma);
let applied = 0;
let needsRefresh = false;

for (const d of decisions) {
  const row = await prisma.transaction.findUnique({ where: { id: d.id }, select: { id: true, merchantKey: true, lane: true } });
  if (!row) { console.log(`SKIP ${d.id}: not found`); continue; }
  if (d.lane && !LANES.includes(d.lane as never)) { console.log(`SKIP ${d.id}: bad lane ${d.lane}`); continue; }
  const categoryId = d.category ? categoryIds.get(d.category) : undefined;
  if (d.category && !categoryId) { console.log(`SKIP ${d.id}: unknown category ${d.category}`); continue; }

  if (d.applyToMerchant) {
    if (!row.merchantKey || isGenericMerchantKey(row.merchantKey) || !categoryId) {
      console.log(`SKIP ${d.id}: cannot make a merchant rule (generic key or no category)`); continue;
    }
    await prisma.merchantCategoryRule.upsert({
      where: { matchPattern: row.merchantKey },
      create: { matchPattern: row.merchantKey, categoryId, lane: (d.lane ?? null) as never },
      update: { categoryId, lane: (d.lane ?? null) as never, source: "USER" },
    });
    saveRules([{ merchantKey: row.merchantKey, category: d.category!, lane: (d.lane ?? null) as never, source: "USER", note: null }]);
    await reclassifyRows(prisma, { merchantKey: row.merchantKey });
    await prisma.transaction.update({ where: { id: d.id }, data: { needsReview: false } });
    needsRefresh = true;
  } else if (categoryId || d.lane) {
    await prisma.transaction.update({
      where: { id: d.id },
      data: {
        ...(categoryId ? { categoryId } : {}),
        ...(d.lane ? { lane: d.lane as never } : {}),
        classifiedBy: "USER", confidence: "high", needsReview: false, userLocked: true, memo: null,
      },
    });
    if (d.lane && d.lane !== row.lane) needsRefresh = true;
  } else if (d.reviewed) {
    await prisma.transaction.update({ where: { id: d.id }, data: { needsReview: false } });
  } else { console.log(`SKIP ${d.id}: nothing to change`); continue; }
  if (!d.applyToMerchant) await recordRowDecisionsFor(prisma, [d.id], { category: d.category ?? null, lane: d.lane ?? null, reviewedOnly: !d.category && !d.lane });
  applied++;
}
if (needsRefresh) await refreshDerived(prisma);
console.log(`Applied ${applied}/${decisions.length}`);
await prisma.$disconnect();
