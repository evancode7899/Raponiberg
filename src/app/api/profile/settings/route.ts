import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { prisma } from "@/lib/db";
import { loadProfileSettings, saveProfileSettings } from "@/lib/profile/settings";
import { loadForecast } from "@/lib/forecast/load";
import { keepForecast } from "@/lib/forecast/snapshots";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await loadProfileSettings(prisma));
}

/**
 * Body: any part of the financial-profile settings (birth years, one-off tags, FIRE
 * assumptions); fields left out keep their stored values.
 */
export async function PUT(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Expected a settings object" }, { status: 400 });
  }
  const saved = await saveProfileSettings(prisma, body);
  await logAuditEvent({
    action: "financial_profile_updated",
    actor: AUDIT_ACTOR_APP,
    payload: { oneOffs: Object.keys(saved.oneOffs).length, nonRecurringCategories: saved.nonRecurringCategories.length },
  });
  // Saved drivers: the forecast they make is kept as it stands (forecast/snapshots.ts), when it moved.
  if ("outlook" in body) {
    try {
      const { forecast } = await loadForecast(prisma);
      const snap = forecast ? keepForecast(forecast, { reason: "drivers saved", now: new Date() }) : null;
      if (snap) await logAuditEvent({ action: "forecast_kept", actor: AUDIT_ACTOR_APP, payload: { id: snap.id, months: snap.months.length } });
    } catch (e) {
      console.error("Keeping the forecast failed:", e instanceof Error ? e.message : e);
    }
  }
  return NextResponse.json(saved);
}
