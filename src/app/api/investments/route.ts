import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedReport, jsonBody } from "@/lib/book/cache";
import { buildInvestments } from "@/lib/book/reports/investments";
import { prisma } from "@/lib/db";
import { loadProfileSettings } from "@/lib/profile/settings";
import { INVESTMENT_SETTINGS_KEY, normalizeInvestmentSettings } from "@/lib/investments/settings";
import { loadJsonSetting, saveJsonSetting } from "@/lib/settingsStore";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Holdings, allocation, fees, unrealized gains and growth from the Book, with the owner's classifications. */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return jsonBody(
    await cachedReport(prisma, "investments", async (book) => {
      const [settings, profile] = await Promise.all([loadJsonSetting(prisma, INVESTMENT_SETTINGS_KEY, normalizeInvestmentSettings), loadProfileSettings(prisma)]);
      // The forecast's return prices what a fee costs over time, as it prices every projection.
      return { report: buildInvestments(book, settings), settings, returnRate: profile.outlook.returnRate };
    }),
  );
}

/** Body: the whole investment settings object (security classifications, target allocation). */
export async function PUT(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Expected an investment settings object" }, { status: 400 });
  }
  const saved = await saveJsonSetting(prisma, INVESTMENT_SETTINGS_KEY, body, normalizeInvestmentSettings);
  await logAuditEvent({
    action: "investment_settings_updated",
    actor: AUDIT_ACTOR_APP,
    payload: { securities: Object.keys(saved.securities).length, target: saved.target != null },
  });
  return NextResponse.json(saved);
}
