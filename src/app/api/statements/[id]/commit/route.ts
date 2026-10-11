import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { prisma } from "@/lib/db";
import { refreshDerived } from "@/lib/ledger/maintenance";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Commits a held statement section so it counts on the dashboards. A section that
 * doesn't tie out needs `{ force: true }` — its gap will show as "unexplained".
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { force?: boolean };
  const statement = await prisma.statementImport.findUnique({ where: { id } });
  if (!statement) return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  if (statement.status === "COMMITTED") return NextResponse.json({ error: "Already committed" }, { status: 409 });
  if (statement.status === "DISCREPANT" && !body.force) {
    return NextResponse.json(
      {
        error: `Statement doesn't tie out (off by ${statement.reconciliationDeltaCents}¢). Pass force: true to commit anyway.`,
      },
      { status: 409 },
    );
  }
  await prisma.statementImport.update({ where: { id }, data: { status: "COMMITTED" } });
  await logAuditEvent({
    action: "statement_committed",
    actor: AUDIT_ACTOR_APP,
    payload: { statementImportId: id, accountId: statement.accountId, forced: statement.status === "DISCREPANT" },
  });
  const maintenance = await refreshDerived(prisma);
  return NextResponse.json({ ok: true, maintenance });
}
