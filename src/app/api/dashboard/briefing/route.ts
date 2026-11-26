import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedBuilt, jsonBody } from "@/lib/book/cache";
import { loadBriefing } from "@/lib/dashboard/loadBriefing";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** The Dashboard's panels beyond net worth and cash flow (lib/dashboard/briefing.ts), built from the reports the other pages' routes build, the same way (lib/dashboard/loadBriefing.ts). */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return jsonBody(await cachedBuilt(prisma, "briefing", (book) => loadBriefing(prisma, book)));
}
