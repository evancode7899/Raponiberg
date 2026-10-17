import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { dataStamp, getBook } from "@/lib/book/cache";
import { buildCashFlowProof, parseDescriptor } from "@/lib/book/proof/cashFlowProof";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";

export const dynamic = "force-dynamic";

/**
 * The proof behind a figure (body: a ProofDescriptor, book/proof/cashFlowProof.ts): the
 * rows that add up to it grouped by statement, whether they really do, and every check
 * that covers it. Built per request from the cached Book (one pass over its rows), not
 * kept in the report cache: each figure on a page has its own. `stamp` lets the page tell
 * the data changed since it loaded.
 */
export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const descriptor = parseDescriptor(await request.json().catch(() => null));
  if ("error" in descriptor) return NextResponse.json({ error: descriptor.error }, { status: 400 });
  const stamp = dataStamp();
  const book = await getBook(prisma, stamp);
  return NextResponse.json({ ...buildCashFlowProof(book, descriptor), stamp: createHash("sha1").update(stamp).digest("hex").slice(0, 12) });
}
