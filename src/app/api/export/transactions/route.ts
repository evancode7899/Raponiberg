import { AUDIT_ACTOR_API, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { csvRow } from "@/lib/csv";
import { prisma } from "@/lib/db";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { NextRequest, NextResponse } from "next/server";

function filenameSafe(s: string): string {
  return s.replace(/[^\w\- .]+/g, "_").replace(/\s+/g, "_").slice(0, 80);
}

/**
 * CSV export of one account's ledger rows (or every account with accountId=all), with
 * how each row counts (lane), its category, counterparty, transfer pairing and the
 * statement it came from. UTF-8 with BOM for Excel.
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accountId = request.nextUrl.searchParams.get("accountId")?.trim();
  if (!accountId) {
    return NextResponse.json({ error: "Missing accountId query parameter" }, { status: 400 });
  }
  const all = accountId === "all";
  const account = all
    ? null
    : await prisma.account.findUnique({ where: { id: accountId }, select: { id: true, name: true, institution: true } });
  if (!all && !account) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  const rows = await prisma.transaction.findMany({
    where: { ...(all ? {} : { accountId }), statementImport: { isSummary: false } },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    include: {
      category: { select: { name: true } },
      account: { select: { name: true, institution: true } },
      transferLeg: { select: { matchId: true, match: { select: { status: true } } } },
      statementImport: { select: { status: true, periodStart: true, periodEnd: true, document: { select: { originalFileName: true } } } },
    },
  });

  const headers = [
    "date",
    "date_precision",
    "amount_cents",
    "payee",
    "detail",
    "lane",
    "category",
    "merchant_key",
    "counterparty_kind",
    "counterparty_institution",
    "transfer_match_id",
    "transfer_match_status",
    "classified_by",
    "confidence",
    "needs_review",
    "user_locked",
    "statement_status",
    "statement_period",
    "source_file",
    "account_name",
    "institution",
    "db_transaction_id",
  ];

  const lines = [csvRow(headers)];
  for (const r of rows) {
    lines.push(
      csvRow([
        r.date.toISOString().slice(0, 10),
        r.datePrecision,
        r.amountCents,
        r.payee,
        r.detail,
        r.lane ?? "",
        r.category?.name ?? "",
        r.merchantKey ?? "",
        r.counterpartyKind ?? "",
        r.counterpartyInstitution ?? "",
        r.transferLeg?.matchId ?? "",
        r.transferLeg?.match.status ?? "",
        r.classifiedBy ?? "",
        r.confidence ?? "",
        r.needsReview ? "true" : "false",
        r.userLocked ? "true" : "false",
        r.statementImport?.status ?? "",
        r.statementImport
          ? `${r.statementImport.periodStart.toISOString().slice(0, 10)}..${r.statementImport.periodEnd.toISOString().slice(0, 10)}`
          : "",
        r.statementImport?.document.originalFileName ?? "",
        r.account.name,
        r.account.institution ?? "",
        r.id,
      ]),
    );
  }

  const csv = `﻿${lines.join("\r\n")}`;
  const fname = filenameSafe(all ? "transactions_all_accounts" : `transactions_${account!.name}_${account!.id.slice(0, 8)}`);

  void logAuditEvent({
    action: "export_transactions_csv",
    actor: AUDIT_ACTOR_API,
    payload: { accountId: account?.id ?? "all", accountName: account?.name ?? "All accounts", rowCount: rows.length },
  }).catch(() => {});

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fname}.csv"`,
    },
  });
}
