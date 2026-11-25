import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedBuilt, jsonBody } from "@/lib/book/cache";
import { buildNetWorthChanges } from "@/lib/book/reports/netWorthChanges";
import { prisma } from "@/lib/db";
import { loadForecast } from "@/lib/forecast/load";
import { keepForecast, readForecastSnapshots } from "@/lib/forecast/snapshots";
import { forecastVsActual } from "@/lib/forecast/vsActual";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Forecast › vs actual (lib/forecast/vsActual.ts): every kept forecast against the months proven since. */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return jsonBody(
    await cachedBuilt(prisma, "forecast-vs-actual", (book) => {
      const snapshots = readForecastSnapshots();
      return { kept: snapshots.length, latest: snapshots.at(-1)?.savedAt ?? null, vs: forecastVsActual(snapshots, buildNetWorthChanges(book, { granularity: "month" }).periods) };
    }),
  );
}

/** Keeps the forecast on the saved drivers as it stands now, to hold to the months that come. */
export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { forecast } = await loadForecast(prisma);
  if (!forecast) return NextResponse.json({ error: "There's no forecast to keep: its starting point isn't proven yet." }, { status: 409 });
  try {
    const snap = keepForecast(forecast, { always: true, reason: "kept by hand" });
    await logAuditEvent({ action: "forecast_kept", actor: AUDIT_ACTOR_APP, payload: { id: snap!.id, months: snap!.months.length } });
    return NextResponse.json({ kept: snap!.id });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Couldn't keep the forecast" }, { status: 500 });
  }
}
