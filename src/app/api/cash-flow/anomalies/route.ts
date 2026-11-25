import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedBuilt, jsonBody } from "@/lib/book/cache";
import { buildAnomalies } from "@/lib/book/reports/anomalies";
import { buildSpendingReport } from "@/lib/book/reports/spending";
import { prisma } from "@/lib/db";
import { loadProfileSettings } from "@/lib/profile/settings";
import { readRowDecisions } from "@/lib/review/rowDecisions";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Cash flow › Unusual (lib/book/reports/anomalies.ts): what looks unusual in the proven months, from the Book. */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return jsonBody(await cachedBuilt(prisma, "anomalies", async (book) => buildAnomalies(book, buildSpendingReport(book, await loadProfileSettings(prisma)), reviewedRows())));
}

/** The rows the owner answered one by one: a damaged file (a finding of its own) reads as none here. */
function reviewedRows() {
  try {
    return readRowDecisions().decisions.map((d) => d.row);
  } catch {
    return [];
  }
}
