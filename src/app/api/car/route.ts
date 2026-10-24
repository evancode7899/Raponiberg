import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedReport, jsonBody } from "@/lib/book/cache";
import { garagePage } from "@/lib/car/page";
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
      const accounts = Object.fromEntries(book.accounts.map((a) => [a.id, a.name]));
      return { report: garagePage(book, settings), settings, accounts };
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
