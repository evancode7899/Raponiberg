import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { prisma } from "@/lib/db";
import { refreshDerived } from "@/lib/ledger/maintenance";
import { createConfirmedMatch, legFingerprints } from "@/lib/transfers/applyDecisions";
import { recordConfirmed, recordRejected } from "@/lib/transfers/decisionStore";
import { legKey } from "@/lib/transfers/matchTransfers";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Owner decisions on transfers. Body:
 *   { action: "confirm", transactionIds: string[], note?: string }
 *     Pair these rows as one transfer (e.g. accept a suggested rollover that lost a fee,
 *     or resolve an ambiguous pairing). Confirmed pairings are never recomputed.
 *   { action: "reject", transactionIds: string[] }
 *     Never pair exactly these rows.
 * Both are also saved beside the database (decisionStore.ts), so they survive re-imports.
 */
export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as {
    action?: string;
    transactionIds?: string[];
    note?: string;
  } | null;
  const ids = [...new Set(body?.transactionIds ?? [])];
  if (ids.length < 2) return NextResponse.json({ error: "Need at least two transactions" }, { status: 400 });

  if (body?.action === "reject") {
    // Recorded in the permanent decisions file, so only for rows that exist.
    if ((await prisma.transaction.count({ where: { id: { in: ids } } })) !== ids.length) {
      return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
    }
    await prisma.transferRejection.upsert({ where: { legKey: legKey(ids) }, create: { legKey: legKey(ids) }, update: {} });
    recordRejected(await legFingerprints(prisma, ids));
    const maintenance = await refreshDerived(prisma);
    return NextResponse.json({ ok: true, maintenance });
  }
  if (body?.action !== "confirm") return NextResponse.json({ error: 'action must be "confirm" or "reject"' }, { status: 400 });

  const rows = await prisma.transaction.findMany({
    where: { id: { in: ids } },
    select: { id: true, accountId: true, amountCents: true, transferLeg: { select: { match: { select: { id: true, status: true } } } } },
  });
  if (rows.length !== ids.length) return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
  if (new Set(rows.map((r) => r.accountId)).size < 2) {
    return NextResponse.json({ error: "A transfer needs legs in at least two accounts" }, { status: 400 });
  }
  if (!rows.some((r) => r.amountCents < 0) || !rows.some((r) => r.amountCents > 0)) {
    return NextResponse.json({ error: "A transfer needs money leaving one account and arriving in another" }, { status: 400 });
  }
  if (rows.some((r) => r.transferLeg?.match.status === "CONFIRMED")) {
    return NextResponse.json({ error: "One of these rows is already in a confirmed transfer — unpair it first" }, { status: 409 });
  }
  const differenceCents = rows.reduce((s, r) => s + r.amountCents, 0);
  const note = body.note?.slice(0, 500) ?? null;

  const match = await prisma.$transaction(async (tx) => {
    const autoIds = rows.map((r) => r.transferLeg?.match.id).filter((x): x is string => !!x);
    await tx.transferMatch.deleteMany({ where: { id: { in: autoIds } } });
    return createConfirmedMatch(tx, ids, differenceCents, note);
  });
  recordConfirmed({ legs: await legFingerprints(prisma, ids), differenceCents, note });
  await logAuditEvent({
    action: "transfer_confirmed",
    actor: AUDIT_ACTOR_APP,
    payload: { matchId: match.id, transactionIds: ids, differenceCents },
  });
  const maintenance = await refreshDerived(prisma);
  return NextResponse.json({ ok: true, matchId: match.id, maintenance });
}
