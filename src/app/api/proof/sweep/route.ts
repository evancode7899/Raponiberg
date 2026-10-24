import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { jsonBody } from "@/lib/book/cache";
import { proofSweep } from "@/lib/book/proof/sweepProcess";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * The proof sweep (lib/book/proof/sweep.ts): every figure every page shows, held to its
 * proof on the Book as it is now. Run once per change to the data, in a process of its own
 * (sweepProcess.ts) so pages stay quick while it works; started by instrumentation.ts, so
 * Statements → Checks can list it and every page can withhold a figure that disagrees with
 * its proof.
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return jsonBody(await proofSweep().report());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
