import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { prisma } from "@/lib/db";
import type { AccountType } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const ACCOUNT_TYPES: AccountType[] = [
  "CHECKING",
  "SAVINGS",
  "CREDIT_CARD",
  "CASH",
  "INVESTMENT",
  "OTHER",
];

/** Accounts with every identifier they've had and how much history is on file. */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const accounts = await prisma.account.findMany({
    orderBy: [{ archivedAt: "asc" }, { displayOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      type: true,
      subtype: true,
      institution: true,
      archivedAt: true,
      aliases: { select: { identifier: true, source: true } },
      _count: { select: { statementImports: true, transactions: true } },
    },
  });
  return NextResponse.json({ accounts });
}

export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    name?: string;
    type?: string;
    institution?: string;
  } | null;

  const name = body?.name?.trim();
  if (!name) {
    return NextResponse.json({ error: "Missing name" }, { status: 400 });
  }
  const type = body?.type;
  if (!type || !ACCOUNT_TYPES.includes(type as AccountType)) {
    return NextResponse.json(
      { error: `type must be one of: ${ACCOUNT_TYPES.join(", ")}` },
      { status: 400 },
    );
  }

  const account = await prisma.account.create({
    data: {
      name,
      type: type as AccountType,
      institution: body?.institution?.trim() || null,
    },
  });

  await logAuditEvent({
    action: "account_created",
    actor: AUDIT_ACTOR_APP,
    payload: { accountId: account.id, type: account.type },
  });

  return NextResponse.json({ account });
}
