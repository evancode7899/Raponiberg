import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedReport, jsonBody } from "@/lib/book/cache";
import { prisma } from "@/lib/db";
import { loadForecastData } from "@/lib/forecast/load";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * What the forecast is built from: the annual profile (proven history, the starting point
 * and base-pay seeds, the saved assumptions) and the bonus letters' facts. The page runs
 * the forecast itself (lib/forecast/forecast.ts) so assumptions can be tried before
 * they're saved; saving goes through /api/profile/settings.
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return jsonBody(await cachedReport(prisma, "forecast", (book) => loadForecastData(prisma, book)));
}
