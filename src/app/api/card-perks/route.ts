import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { dataStamp, stampTag } from "@/lib/book/cache";
import { loadCardPerksPage } from "@/lib/cardPerks/page";
import { CARD_PERKS_KEY, normalizeCardPerks } from "@/lib/cardPerks/settings";
import { prisma } from "@/lib/db";
import { saveJsonSetting } from "@/lib/settingsStore";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Each credit card's annual fee against its rewards, perks and offers for one year (?year=, default this year), and the owner's choices behind it. */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const y = Number(request.nextUrl.searchParams.get("year"));
  const year = Number.isInteger(y) && y >= 1990 && y <= 2200 ? y : undefined;
  // The stamp of the data read, taken before reading it: a change during the read makes it stale, never newer.
  const stamp = dataStamp();
  return NextResponse.json(await loadCardPerksPage(prisma, year), { headers: { "x-data-stamp": stampTag(stamp) } });
}

/** Body: the owner's choices (CardPerksSettings): products, point values, hidden cards. */
export async function PUT(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Expected the card perks settings" }, { status: 400 });
  }
  const saved = await saveJsonSetting(prisma, CARD_PERKS_KEY, body, normalizeCardPerks);
  await logAuditEvent({ action: "card_perks_updated", actor: AUDIT_ACTOR_APP, payload: { cards: Object.keys(saved.cards).length, pointValues: Object.keys(saved.pointValues).length } });
  return NextResponse.json(saved);
}
