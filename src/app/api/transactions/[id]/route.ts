import { answerAndRefresh } from "@/app/api/transactions/answer";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Correct a row. Body:
 *   { category?: string, lane?: Lane, applyToMerchant?: boolean, reviewed?: boolean }
 *
 * - applyToMerchant: teach a rule for this merchant — every past and future row from
 *   the same merchant follows (except rows corrected individually).
 * - otherwise the change applies to this row only and is locked against reclassifying.
 * - reviewed alone just clears the review flag, keeping the classifier's answer.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  return answerAndRefresh([id], body);
}
