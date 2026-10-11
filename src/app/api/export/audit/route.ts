import { AUDIT_ACTOR_API, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { csvRow } from "@/lib/csv";
import { prisma } from "@/lib/db";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { NextRequest, NextResponse } from "next/server";

/**
 * CSV of audit events (optional date filter). Same auth as other exports.
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sp = request.nextUrl.searchParams;
  const from = sp.get("from")?.trim();
  const to = sp.get("to")?.trim();

  const fromD = from ? new Date(from) : undefined;
  const toD = to ? new Date(to) : undefined;
  if (from && (fromD == null || Number.isNaN(fromD.getTime()))) {
    return NextResponse.json({ error: "Invalid from date" }, { status: 400 });
  }
  if (to && (toD == null || Number.isNaN(toD.getTime()))) {
    return NextResponse.json({ error: "Invalid to date" }, { status: 400 });
  }

  const where =
    fromD || toD
      ? {
          occurredAt: {
            ...(fromD ? { gte: fromD } : {}),
            ...(toD ? { lte: toD } : {}),
          },
        }
      : {};

  const rows = await prisma.auditEvent.findMany({
    where,
    orderBy: { occurredAt: "desc" },
    take: 10_000,
  });

  const headers = [
    "occurred_at_utc",
    "action",
    "actor",
    "correlation_id",
    "payload_json",
  ];
  const lines = [csvRow(headers)];
  for (const r of rows) {
    lines.push(
      csvRow([
        r.occurredAt.toISOString(),
        r.action,
        r.actor,
        r.correlationId ?? "",
        r.payloadJson == null ? "" : JSON.stringify(r.payloadJson),
      ]),
    );
  }

  const csv = `\uFEFF${lines.join("\r\n")}`;

  void logAuditEvent({
    action: "export_audit_csv",
    actor: AUDIT_ACTOR_API,
    payload: { rowCount: rows.length, from: from ?? null, to: to ?? null },
  }).catch(() => {});

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit_log.csv"`,
    },
  });
}
