import { checkChain, splitLink } from "@/lib/audit/chain";
import { readAuditHead } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Settings › Audit log: the newest events that match the filters (action, actor, from, to
 * as days), each with its own payload and its place in the chain; what there is to filter
 * by; and whether the whole chain holds (lib/audit/chain.ts). Reads only.
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const sp = request.nextUrl.searchParams;
  const limit = Math.min(2000, Number(sp.get("limit") ?? 500) || 500);
  const action = sp.get("action")?.trim() || undefined;
  const actor = sp.get("actor")?.trim() || undefined;
  const from = sp.get("from") ?? "";
  const to = sp.get("to") ?? "";
  const occurredAt: Prisma.DateTimeFilter = {};
  if (DAY.test(from)) occurredAt.gte = new Date(`${from}T00:00:00`);
  if (DAY.test(to)) occurredAt.lt = new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000);
  const where: Prisma.AuditEventWhereInput = { ...(action ? { action } : {}), ...(actor ? { actor } : {}), ...(Object.keys(occurredAt).length ? { occurredAt } : {}) };

  const [all, total, matched, actions, actors] = await Promise.all([
    prisma.auditEvent.findMany({ select: { id: true, occurredAt: true, action: true, actor: true, payloadJson: true, correlationId: true } }),
    prisma.auditEvent.count(),
    prisma.auditEvent.count({ where }),
    prisma.auditEvent.groupBy({ by: ["action"], _count: { _all: true }, orderBy: { action: "asc" } }),
    prisma.auditEvent.groupBy({ by: ["actor"], _count: { _all: true }, orderBy: { actor: "asc" } }),
  ]);
  const events = await prisma.auditEvent.findMany({ where, orderBy: { occurredAt: "desc" }, take: limit, select: { id: true, occurredAt: true, action: true, actor: true, payloadJson: true } });
  return NextResponse.json({
    events: events.map((e) => {
      const { payload, link } = splitLink(e.payloadJson);
      return { id: e.id, occurredAt: e.occurredAt, action: e.action, actor: e.actor, payload, seq: link?.seq ?? null };
    }),
    total,
    matched,
    actions: actions.map((a) => ({ value: a.action, count: a._count._all })),
    actors: actors.map((a) => ({ value: a.actor, count: a._count._all })),
    chain: checkChain(all, readAuditHead()),
  });
}
