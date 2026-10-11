import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { prisma } from "@/lib/db";
import { refreshDerived } from "@/lib/ledger/maintenance";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Removes an imported document and everything it contributed (statement sections,
 * rows, pay stubs, transfer pairings), e.g. to replace a statement with a corrected
 * one. Transfer matching and pay-stub links are recomputed afterwards.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const doc = await prisma.sourceDocument.findUnique({
    where: { id },
    select: { id: true, title: true, originalFileName: true, statementImports: { select: { id: true } } },
  });
  if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  await prisma.$transaction(async (tx) => {
    // Matches that lose a leg can't stand on their own.
    const legs = await tx.transferLeg.findMany({
      where: { transaction: { statementImport: { documentId: id } } },
      select: { matchId: true },
    });
    await tx.transferMatch.deleteMany({ where: { id: { in: legs.map((l) => l.matchId) } } });
    await tx.sourceDocument.delete({ where: { id } });
  });
  await logAuditEvent({
    action: "statement_deleted",
    actor: AUDIT_ACTOR_APP,
    payload: { documentId: id, title: doc.title, fileName: doc.originalFileName, sections: doc.statementImports.length },
  });
  const maintenance = await refreshDerived(prisma);
  return NextResponse.json({ ok: true, maintenance });
}
