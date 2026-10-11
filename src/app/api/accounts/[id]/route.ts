import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { prisma } from "@/lib/db";
import { refreshDerived } from "@/lib/ledger/maintenance";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Body: { name?: string, archived?: boolean } */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as { name?: string; archived?: boolean } | null;
  const name = body?.name?.trim();
  if (!name && body?.archived === undefined) return NextResponse.json({ error: "Nothing to change" }, { status: 400 });
  const account = await prisma.account.update({
    where: { id },
    data: {
      ...(name ? { name } : {}),
      ...(body?.archived === undefined ? {} : { archivedAt: body.archived ? new Date() : null }),
    },
  });
  await logAuditEvent({ action: "account_updated", actor: AUDIT_ACTOR_APP, payload: { accountId: id, name, archived: body?.archived } });
  return NextResponse.json({ account });
}

/**
 * Merge this account into another: { intoAccountId }. For when one real account got
 * split in two (e.g. a reissued card whose first new statement didn't chain to the old
 * one). Refused if their statement periods overlap.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as { intoAccountId?: string } | null;
  const into = body?.intoAccountId;
  if (!into || into === id) return NextResponse.json({ error: "intoAccountId must be another account" }, { status: 400 });

  const [src, dst] = await Promise.all([
    prisma.account.findUnique({ where: { id }, include: { statementImports: { where: { isSummary: false } } } }),
    prisma.account.findUnique({ where: { id: into }, include: { statementImports: { where: { isSummary: false } } } }),
  ]);
  if (!src || !dst) return NextResponse.json({ error: "Account not found" }, { status: 404 });
  const overlap = src.statementImports.find((a) =>
    dst.statementImports.some((b) => a.periodStart <= b.periodEnd && b.periodStart <= a.periodEnd),
  );
  if (overlap) {
    return NextResponse.json(
      { error: `Both accounts have a statement covering ${overlap.periodStart.toISOString().slice(0, 10)} — they can't be the same account.` },
      { status: 409 },
    );
  }
  await prisma.$transaction([
    prisma.accountAlias.updateMany({ where: { accountId: id }, data: { accountId: into, source: "USER" } }),
    prisma.statementImport.updateMany({ where: { accountId: id }, data: { accountId: into } }),
    prisma.transaction.updateMany({ where: { accountId: id }, data: { accountId: into } }),
    prisma.account.delete({ where: { id } }),
  ]);
  await logAuditEvent({ action: "accounts_merged", actor: AUDIT_ACTOR_APP, payload: { from: id, fromName: src.name, into, intoName: dst.name } });
  const maintenance = await refreshDerived(prisma);
  return NextResponse.json({ ok: true, maintenance });
}
