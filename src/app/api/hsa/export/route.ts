import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { csvRow } from "@/lib/csv";
import { KIND_LABEL } from "@/lib/hsa/qualify";
import { readHsaFile } from "@/lib/hsa/store";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const dollars = (c: number) => (c / 100).toFixed(2);

/**
 * The HSA receipts log as CSV (UTF-8 with BOM for Excel): one row per expense, with
 * whether and when it was reimbursed. ?status=open limits it to the unreimbursed ones,
 * the list to hand over if the IRS ever asks what a withdrawal paid for.
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const openOnly = request.nextUrl.searchParams.get("status") === "open";
  let expenses;
  try {
    expenses = readHsaFile().expenses.filter((e) => !openOnly || !e.reimbursement);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the HSA log" }, { status: 500 });
  }
  const lines = [
    csvRow(["Date", "Amount", "Provider", "Patient", "Kind", "Notes", "Receipt saved", "Receipt location", "Paid with", "Reimbursed", "Reimbursed on", "Reimbursement note"]),
    ...expenses.map((e) =>
      csvRow([
        e.date,
        dollars(e.amountCents),
        e.provider,
        e.patient,
        KIND_LABEL[e.kind],
        e.notes,
        e.receipt ? "Yes" : "No",
        e.receiptRef,
        e.paidWith ? `${e.paidWith.payee} (${e.paidWith.institution}, ${e.paidWith.date})` : "",
        e.reimbursement ? "Yes" : "No",
        e.reimbursement?.date ?? "",
        e.reimbursement?.note ?? "",
      ]),
    ),
  ];
  await logAuditEvent({ action: "hsa_expenses_exported", actor: AUDIT_ACTOR_APP, payload: { rows: expenses.length, openOnly } });
  const name = `hsa-receipts-${openOnly ? "unreimbursed-" : ""}${new Date().toLocaleDateString("en-CA")}.csv`;
  return new NextResponse("﻿" + lines.join("\r\n") + "\r\n", {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` },
  });
}
