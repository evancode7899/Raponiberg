import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { isGenericMerchantKey } from "@/lib/classifier/merchants";
import { ensureCategories, reclassifyRows } from "@/lib/classifier/persist";
import { saveRules } from "@/lib/classifier/ruleStore";
import { LANES, type Lane } from "@/lib/classifier/taxonomy";
import { prisma } from "@/lib/db";
import { refreshDerived } from "@/lib/ledger/maintenance";
import { recordRowDecisionsFor } from "@/lib/review/rowDecisions";
import type { TransactionLane } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Correct a row. Body:
 *   { category?: string, lane?: Lane, applyToMerchant?: boolean, reviewed?: boolean }
 *
 * - applyToMerchant: teach a rule for this merchant — every past and future row from
 *   the same merchant follows (except rows corrected individually).
 * - otherwise the change applies to this row only and is locked against reclassifying.
 * - reviewed alone just clears the review flag, keeping the classifier's answer.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as {
    category?: string;
    lane?: string;
    applyToMerchant?: boolean;
    reviewed?: boolean;
  } | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const row = await prisma.transaction.findUnique({
    where: { id },
    select: { id: true, lane: true, merchantKey: true, categoryId: true, payee: true },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const lane = body.lane as Lane | undefined;
  if (lane && !LANES.includes(lane)) {
    return NextResponse.json({ error: `lane must be one of ${LANES.join(", ")}` }, { status: 400 });
  }
  const categoryIds = await ensureCategories(prisma);
  const categoryId = body.category ? categoryIds.get(body.category) : undefined;
  if (body.category && !categoryId) {
    return NextResponse.json({ error: `Unknown category: ${body.category}` }, { status: 400 });
  }

  let affected = 1;
  if (body.applyToMerchant) {
    const merchantKey = row.merchantKey;
    if (!merchantKey || isGenericMerchantKey(merchantKey) || !categoryId) {
      return NextResponse.json(
        { error: "This row doesn't name a merchant (e.g. a deposit or check) — set it for this row only." },
        { status: 400 },
      );
    }
    await prisma.merchantCategoryRule.upsert({
      where: { matchPattern: merchantKey },
      create: { matchPattern: merchantKey, categoryId, lane: (lane ?? null) as TransactionLane | null },
      // The owner's answer replaces an AI-taught rule for the merchant.
      update: { categoryId, lane: (lane ?? null) as TransactionLane | null, source: "USER" },
    });
    saveRules([{ merchantKey, category: body.category!, lane: lane ?? null, source: "USER", note: null }]);
    affected = await reclassifyRows(prisma, { merchantKey });
    await prisma.transaction.update({ where: { id }, data: { needsReview: false } });
  } else if (categoryId || lane) {
    await prisma.transaction.update({
      where: { id },
      data: {
        ...(categoryId ? { categoryId } : {}),
        ...(lane ? { lane: lane as TransactionLane } : {}),
        classifiedBy: "USER",
        confidence: "high",
        needsReview: false,
        userLocked: true,
        memo: null,
      },
    });
    // Also keep it in data/row-decisions.json, so a re-import or rebuild can't lose it.
    await recordRowDecisionsFor(prisma, [id], { category: body.category ?? null, lane: lane ?? null, reviewedOnly: false });
  } else if (body.reviewed) {
    await prisma.transaction.update({ where: { id }, data: { needsReview: false } });
    await recordRowDecisionsFor(prisma, [id], { category: null, lane: null, reviewedOnly: true });
  } else {
    return NextResponse.json({ error: "Nothing to change" }, { status: 400 });
  }

  await logAuditEvent({
    action: "transaction_classified",
    actor: AUDIT_ACTOR_APP,
    payload: {
      transactionId: id,
      merchantKey: row.merchantKey,
      category: body.category ?? null,
      lane: lane ?? null,
      applyToMerchant: !!body.applyToMerchant,
      affected,
    },
  });
  const laneChanged = (lane && lane !== row.lane) || body.applyToMerchant;
  const maintenance = laneChanged ? await refreshDerived(prisma) : null;
  return NextResponse.json({ ok: true, affected, maintenance });
}
