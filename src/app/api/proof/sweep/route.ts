import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedReport, jsonBody } from "@/lib/book/cache";
import { sweepProofs } from "@/lib/book/proof/sweep";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * The proof sweep (lib/book/proof/sweep.ts): every figure every page shows, held to its
 * proof on the Book as it is now. Built once per change to the data (kept warm by
 * instrumentation.ts), so Statements → Checks can list it and every page can withhold a
 * figure that disagrees with its proof.
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return jsonBody(await cachedReport(prisma, "proof-sweep", (book) => sweepProofs({ book, db: prisma })));
}
