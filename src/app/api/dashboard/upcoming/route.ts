import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedBuilt, jsonBody } from "@/lib/book/cache";
import { loadCardPerksPage } from "@/lib/cardPerks/page";
import { cardRewardsFile } from "@/lib/cardPerks/rewardsScan";
import { upcomingDue } from "@/lib/dashboard/upcoming";
import { prisma } from "@/lib/db";
import { loadInsurancePage } from "@/lib/insurance/page";
import { loadHsaReport } from "@/lib/hsa/loadReport";
import { hsaFilePath } from "@/lib/hsa/store";
import { insuranceDocsFile } from "@/lib/insurance/store";
import { statSync } from "node:fs";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** When a file last changed (0: none): the two files these reports read beyond the Book aren't in its stamp. */
const changed = (file: string) => statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;

/**
 * Card credits about to close and insurance dates for the Dashboard's Next up
 * (lib/dashboard/upcoming.ts), and the HSA's receipts still to reimburse. Only reads: the Card perks and Insurance pages look for new
 * documents and keep what they read, and a change to either file rebuilds this.
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const key = `upcoming|${changed(cardRewardsFile())}|${changed(insuranceDocsFile())}|${changed(hsaFilePath())}`;
  return jsonBody(
    await cachedBuilt(prisma, key, async (book) => {
      const [perks, insurance, hsa] = await Promise.all([loadCardPerksPage(prisma, undefined, book, { read: false }), loadInsurancePage(prisma, book, { scan: false }), loadHsaReport(prisma, { scan: false }).catch(() => null)]);
      // The HSA page's own "to reimburse" total (its proof: report hsa, metric reimbursable): the Dashboard adds nothing to it.
      return { due: upcomingDue(perks.report, insurance), hsaReimbursableCents: hsa ? hsa.totals.unreimbursedCents : null };
    }),
  );
}
