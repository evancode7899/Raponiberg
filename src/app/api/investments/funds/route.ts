import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { dataStamp, stampTag } from "@/lib/book/cache";
import { prisma } from "@/lib/db";
import { loadFundsPage } from "@/lib/funds/page";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Every private fund's LP view, from the manager's own notices and capital statements (lib/funds). */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    // The stamp of the data read, taken before reading it: a change during the read makes it stale, never newer.
    const stamp = dataStamp();
    return NextResponse.json(await loadFundsPage(prisma), { headers: { "x-data-stamp": stampTag(stamp) } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the fund documents" }, { status: 500 });
  }
}
