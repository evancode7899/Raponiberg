import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { prisma } from "@/lib/db";
import { deletedDocuments, restoreDeletedDocument } from "@/lib/ingest/deletedDocuments";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Documents deleted lately that can be put back from their stored file (lib/ingest/deletedDocuments.ts): { deleted }. Reads only. */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ deleted: await deletedDocuments(prisma) });
}

/** Body: { eventId } (the deletion's audit event): reads the document's stored file again. */
export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { eventId?: unknown } | null;
  if (typeof body?.eventId !== "string") return NextResponse.json({ error: "Expected { eventId }" }, { status: 400 });
  try {
    const { outcome, payload } = await restoreDeletedDocument(prisma, body.eventId);
    if (outcome.ok) await logAuditEvent({ action: "statement_restored", actor: AUDIT_ACTOR_APP, payload: { eventId: body.eventId, documentId: outcome.result.documentId, title: payload.title ?? null, fileName: payload.fileName ?? null } });
    return NextResponse.json({ outcome, deleted: await deletedDocuments(prisma) }, { status: outcome.ok ? 200 : 422 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Couldn't put it back" }, { status: 400 });
  }
}
