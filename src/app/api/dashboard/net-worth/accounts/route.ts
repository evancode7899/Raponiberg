import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedBuilt, jsonBody } from "@/lib/book/cache";
import { prisma } from "@/lib/db";
import { buildAccountRollforwards } from "@/lib/profile/rollforwards";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Every investment account's calendar-year roll-forward from the Book (opening,
 * contributions, withdrawals, income, market change, closing, return). A year that
 * depends on a missing or failing statement comes back with its blockers instead.
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return jsonBody(await cachedBuilt(prisma, "net-worth-accounts", buildAccountRollforwards));
}
