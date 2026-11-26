import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedBuilt, jsonBody } from "@/lib/book/cache";
import { buildCommandIndex } from "@/lib/commandIndex";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** The accounts and merchants the command line finds by name (lib/commandIndex.ts). */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return jsonBody(await cachedBuilt(prisma, "command-index", buildCommandIndex));
}
