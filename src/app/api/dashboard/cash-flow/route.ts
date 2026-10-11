import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedReport, jsonBody } from "@/lib/book/cache";
import { buildSpendingReport } from "@/lib/book/reports/spending";
import { prisma } from "@/lib/db";
import { loadProfileSettings } from "@/lib/profile/settings";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * The spending app's data from the Book (internal transfers excluded): every proven
 * month — the unbroken run ending at the latest complete proven month — with category,
 * merchant and payer splits, recurring charges and big one-offs, plus what withholds the
 * months around it. Query: accountIds (comma list).
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const accountIds = request.nextUrl.searchParams.get("accountIds")?.split(",").map((s) => s.trim()).filter(Boolean);
  return jsonBody(
    await cachedReport(prisma, `cash-flow|${accountIds?.join(",") ?? ""}`, async (book) => ({
      ...buildSpendingReport(book, await loadProfileSettings(prisma), { accountIds }),
      accounts: book.ledger.accounts.filter((a) => !a.isInvestment).map((a) => ({ id: a.id, name: a.name })),
    })),
  );
}
