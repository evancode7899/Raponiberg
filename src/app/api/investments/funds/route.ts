import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { stampTag } from "@/lib/book/cache";
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
    return NextResponse.json(await loadFundsPage(prisma), { headers: { "x-data-stamp": stampTag() } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the fund documents" }, { status: 500 });
  }
}
