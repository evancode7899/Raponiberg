import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedBuilt, jsonBody } from "@/lib/book/cache";
import { prisma } from "@/lib/db";
import { buildAnnualProfile } from "@/lib/profile/buildAnnualProfile";
import { loadProfileSettings } from "@/lib/profile/settings";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * The financial profile from the Book: one column per calendar year — pay, the paycheck
 * to savings waterfall, year-end net worth by liquidity, the net worth bridge — plus the
 * FIRE plan's starting point. Sections that depend on missing or failing facts come back
 * empty with their blockers.
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return jsonBody(
    await cachedBuilt(prisma, "profile", async (book) => {
      return buildAnnualProfile(book, await loadProfileSettings(prisma), book.taxProfile.dependents);
    }),
  );
}
