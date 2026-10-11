import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedReport, jsonBody } from "@/lib/book/cache";
import { buildGoals } from "@/lib/book/reports/goals";
import { prisma } from "@/lib/db";
import { loadForecast } from "@/lib/forecast/load";
import { GOALS_KEY, normalizeGoals } from "@/lib/goals/settings";
import { loadJsonSetting, saveJsonSetting } from "@/lib/settingsStore";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Every savings goal's progress from the Book, with when each is reached on the shared forecast. */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return jsonBody(
    await cachedReport(prisma, "goals", async (book) => {
      const [settings, { forecast: f }] = await Promise.all([loadJsonSetting(prisma, GOALS_KEY, normalizeGoals), loadForecast(prisma, book)]);
      const forecast = f ? { startKey: f.startKey, start: f.plan.start, months: f.months.map(({ key, liquid, illiquid }) => ({ key, liquid, illiquid })) } : null;
      return { report: buildGoals(book, settings, forecast), settings };
    }),
  );
}

/** Body: { goals: [...] } in priority order. */
export async function PUT(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Expected { goals: [...] }" }, { status: 400 });
  }
  const saved = await saveJsonSetting(prisma, GOALS_KEY, body, normalizeGoals);
  await logAuditEvent({ action: "goals_updated", actor: AUDIT_ACTOR_APP, payload: { goals: saved.goals.length } });
  return NextResponse.json(saved);
}
