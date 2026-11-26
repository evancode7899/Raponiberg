import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedBuilt, jsonBody } from "@/lib/book/cache";
import { prisma } from "@/lib/db";
import { edgeOf } from "@/lib/ingest/unlocked";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** The proven-through date and each open account's latest statement day (lib/ingest/unlocked.ts): the import page reads it before and after, to say what an import unlocked. */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return jsonBody(await cachedBuilt(prisma, "statements-edge", edgeOf));
}
