import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedBuilt, jsonBody } from "@/lib/book/cache";
import { prisma } from "@/lib/db";
import { buildMortgageLinks } from "@/lib/mortgage/links";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export type { MortgageLink } from "@/lib/mortgage/links";

/**
 * The figures the Mortgage page starts from instead of typed guesses (lib/mortgage/links.ts).
 * The page keeps a typed value where the owner types one, and shows the linked figure beside it.
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return jsonBody(await cachedBuilt(prisma, "mortgage-links", (book) => buildMortgageLinks(prisma, book)));
}
