import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { blockersFor } from "@/lib/book/blockers";
import { cachedReport, jsonBody } from "@/lib/book/cache";
import { refs } from "@/lib/book/reports/blockerRef";
import { buildGarage } from "@/lib/car/report";
import { CAR_KEY, normalizeGarage } from "@/lib/car/settings";
import { prisma } from "@/lib/db";
import { loadJsonSetting, saveJsonSetting } from "@/lib/settingsStore";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** The garage (every car and the car log) and every figure built from it and the car charges in the statements. */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return jsonBody(
    await cachedReport(prisma, "car", async (book) => {
      const settings = await loadJsonSetting(prisma, CAR_KEY, normalizeGarage);
      // A log entry dated after the last day every card and bank statement is in for is awaiting its statement, not missing.
      const accounts = Object.fromEntries(book.accounts.map((a) => [a.id, a.name]));
      const report = buildGarage(settings, book.rows, book.today, { statementsThrough: book.horizon.cashFlow });
      // Car charges can be on any bank or card statement, so any cash-flow finding since the first purchase withholds them.
      const from = settings.cars.map((c) => c.vehicle.purchaseDate).filter((d): d is string => !!d).sort()[0];
      const blockers = from && from <= book.horizon.cashFlow ? refs(blockersFor(book, { affects: "CASH_FLOW", from, to: book.horizon.cashFlow })) : [];
      return { report: { ...report, blockers }, settings, accounts };
    }),
  );
}

/** Body: the whole garage (GarageSettings). */
export async function PUT(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Expected the car log" }, { status: 400 });
  }
  const saved = await saveJsonSetting(prisma, CAR_KEY, body, normalizeGarage);
  await logAuditEvent({ action: "car_updated", actor: AUDIT_ACTOR_APP, payload: { cars: saved.cars.length, entries: saved.entries.length } });
  return NextResponse.json(saved);
}
