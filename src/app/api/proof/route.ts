import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { dataStamp, getBook } from "@/lib/book/cache";
import { buildProof, parseDescriptor } from "@/lib/book/proof";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";

export const dynamic = "force-dynamic";

/**
 * The proof behind a figure (body: a ProofDescriptor, lib/book/proof): what it's made
 * of, whether the parts really add up to it, and every check that covers it. Built per
 * request from the cached Book, not kept in the report cache: each figure on a page has
 * its own. `stamp` lets the page tell the data changed since it loaded.
 */
export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const descriptor = parseDescriptor(await request.json().catch(() => null));
  if ("error" in descriptor) return NextResponse.json({ error: descriptor.error }, { status: 400 });
  const stamp = dataStamp();
  const book = await getBook(prisma, stamp);
  const proof = await buildProof({ book, db: prisma }, descriptor);
  return NextResponse.json({ ...proof, stamp: createHash("sha1").update(stamp).digest("hex").slice(0, 12) });
}
