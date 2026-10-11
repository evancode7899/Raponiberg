import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { prisma } from "@/lib/db";
import { refreshDerived } from "@/lib/ledger/maintenance";
import { legFingerprints } from "@/lib/transfers/applyDecisions";
import { recordRejected } from "@/lib/transfers/decisionStore";
import { legKey } from "@/lib/transfers/matchTransfers";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Unpairs a transfer and records that these rows must not be paired again. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const match = await prisma.transferMatch.findUnique({ where: { id }, include: { legs: true } });
  if (!match) return NextResponse.json({ error: "Transfer not found" }, { status: 404 });
  const key = legKey(match.legs.map((l) => l.transactionId));
  // Saved beside the database too, replacing a confirmation of the same legs.
  recordRejected(await legFingerprints(prisma, match.legs.map((l) => l.transactionId)));
  await prisma.$transaction([
    prisma.transferRejection.upsert({ where: { legKey: key }, create: { legKey: key }, update: {} }),
    prisma.transferMatch.delete({ where: { id } }),
  ]);
  await logAuditEvent({
    action: "transfer_unpaired",
    actor: AUDIT_ACTOR_APP,
    payload: { matchId: id, status: match.status, transactionIds: match.legs.map((l) => l.transactionId) },
  });
  const maintenance = await refreshDerived(prisma);
  return NextResponse.json({ ok: true, maintenance });
}
