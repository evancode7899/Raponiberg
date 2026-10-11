import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** The latest audit events (newest first) for Settings › Audit log. */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limit = Math.min(1000, Number(request.nextUrl.searchParams.get("limit") ?? 200) || 200);
  const [events, total] = await Promise.all([
    prisma.auditEvent.findMany({
      orderBy: { occurredAt: "desc" },
      take: limit,
      select: { id: true, occurredAt: true, action: true, actor: true, payloadJson: true },
    }),
    prisma.auditEvent.count(),
  ]);
  return NextResponse.json({ events, total });
}
