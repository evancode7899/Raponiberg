import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedReport, jsonBody } from "@/lib/book/cache";
import { cardPerksPage } from "@/lib/cardPerks/page";
import { CARD_PERKS_KEY, normalizeCardPerks } from "@/lib/cardPerks/settings";
import { prisma } from "@/lib/db";
import { loadJsonSetting, saveJsonSetting } from "@/lib/settingsStore";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Each credit card's annual fee against its perks and points for one year (?year=, default this year), and the setup behind it. */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const y = Number(request.nextUrl.searchParams.get("year"));
  const year = Number.isInteger(y) && y >= 1990 && y <= 2200 ? y : undefined;
  return jsonBody(
    await cachedReport(prisma, `card-perks:${year ?? "now"}`, async (book) => {
      const settings = await loadJsonSetting(prisma, CARD_PERKS_KEY, normalizeCardPerks);
      return { report: cardPerksPage(book, settings, year), settings };
    }),
  );
}

/** Body: the whole setup (CardPerksSettings). */
export async function PUT(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Expected the card perks setup" }, { status: 400 });
  }
  const saved = await saveJsonSetting(prisma, CARD_PERKS_KEY, body, normalizeCardPerks);
  await logAuditEvent({ action: "card_perks_updated", actor: AUDIT_ACTOR_APP, payload: { cards: Object.keys(saved.cards).length, marked: Object.keys(saved.usage).length } });
  return NextResponse.json(saved);
}
