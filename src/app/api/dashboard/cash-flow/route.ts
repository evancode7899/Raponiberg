import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { jsonBody } from "@/lib/book/cache";
import { cashFlowPayload } from "@/lib/cashFlowPayload";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * The spending app's data from the Book (internal transfers excluded): every proven
 * month — the unbroken run ending at the latest complete proven month — with category,
 * merchant and payer splits, recurring charges and big one-offs, plus what withholds the
 * months around it. Query: accountIds (comma list); parts=lean (without each month's
 * merchant list) or parts=merchants (those lists alone): lib/cashFlowParts.ts.
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const sp = request.nextUrl.searchParams;
  const accountIds = sp.get("accountIds")?.split(",").map((s) => s.trim()).filter(Boolean);
  const parts = sp.get("parts");
  return jsonBody(await cashFlowPayload(prisma, accountIds, parts === "lean" || parts === "merchants" ? parts : null));
}
