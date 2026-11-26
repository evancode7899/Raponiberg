import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { jsonBody, stampTag } from "@/lib/book/cache";
import { proofSweep } from "@/lib/book/proof/sweepProcess";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * The proof sweep (lib/book/proof/sweep.ts): every figure every page shows, held to its
 * proof on the Book as it is now. Run once per change to the data, in a process of its own
 * (sweepProcess.ts) so pages stay quick while it works; started by instrumentation.ts.
 *
 * Pages clear their figures from it (lib/book/proof/clearance.ts), so it never keeps them
 * waiting: while the sweep of the data as it is now runs it answers 202 with that data's
 * stamp, and the page shows its figures meanwhile and asks again. `?wait=1` waits for the report
 * instead (Statements → Checks). A sweep that failed answers 503: pages withhold every figure.
 *
 * A finished sweep of some data never changes, so it carries that data's stamp as its ETag:
 * a page that already has it is answered 304 with no body (it runs to megabytes on a big Book).
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    if (request.nextUrl.searchParams.get("wait")) return jsonBody(await proofSweep().report());
    const stamp = stampTag();
    const now = proofSweep().peek();
    if (now.state === "ready") {
      const etag = `"sweep-${stamp}"`;
      const headers = { etag, "cache-control": "private, no-cache", "x-data-stamp": stamp };
      if (request.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers });
      const res = jsonBody(now.body);
      for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
      return res;
    }
    if (now.state === "pending") return NextResponse.json({ status: "pending", stamp }, { status: 202, headers: { "x-data-stamp": stamp, "cache-control": "no-store" } });
    return NextResponse.json({ error: now.error }, { status: 503, headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
