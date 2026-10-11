import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { readAwards } from "@/lib/bonuses/awardStore";
import { addReview, readReviews, reopenReview } from "@/lib/bonuses/reviewStore";
import { cachedReport, getBook, jsonBody } from "@/lib/book/cache";
import type { Book } from "@/lib/book/load";
import { buildBonuses, type BonusesReport } from "@/lib/book/reports/bonuses";
import { prisma } from "@/lib/db";
import { DISPLAY_TIME_ZONE } from "@/lib/displayTime";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: DISPLAY_TIME_ZONE });

function build(book: Book, day: string): BonusesReport {
  return buildBonuses(book, readAwards(), day, readReviews().reviews);
}

/** `{ report }` as JSON text. The award letters and reviews are files in data/, which the Book cache watches. */
function report(): Promise<string> {
  const day = today();
  return cachedReport(prisma, `bonuses|${day}`, (book) => ({ report: build(book, day) }));
}

/** Every bonus award letter checked against the bonus lines on the pay stubs. */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return jsonBody(await report());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * The owner reviews a warning ("review", with a note saying why it's fine) or reopens a
 * review ("reopen", with a reason). A review records the warning's current gap, read from
 * the report here, never from the request.
 */
export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { action?: unknown; id?: unknown; note?: unknown; reason?: unknown } | null;
  if (!body || typeof body.id !== "string" || !body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const id = body.id;

  try {
    if (body.action === "review") {
      const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
      if (!note) return NextResponse.json({ error: "A note saying why the warning is fine is required" }, { status: 400 });
      const w = build(await getBook(prisma), today()).warnings.find((x) => x.id === id);
      if (!w) return NextResponse.json({ error: "That warning isn't open any more — reload the page" }, { status: 404 });
      try {
        addReview({ id: w.id, gapCents: w.gapCents, warning: w.text, note, reviewedAt: new Date().toISOString() });
      } catch (e) {
        return NextResponse.json({ error: (e as Error).message }, { status: 409 });
      }
      await prisma.auditEvent.create({ data: { action: "bonus_warning_reviewed", actor: "owner", payloadJson: { id, note } } });
    } else if (body.action === "reopen") {
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (!reason) return NextResponse.json({ error: "Say why the review no longer holds" }, { status: 400 });
      try {
        reopenReview(id, reason);
      } catch (e) {
        return NextResponse.json({ error: (e as Error).message }, { status: 404 });
      }
      await prisma.auditEvent.create({ data: { action: "bonus_review_reopened", actor: "owner", payloadJson: { id, reason } } });
    } else {
      return NextResponse.json({ error: 'action must be "review" or "reopen"' }, { status: 400 });
    }
    return jsonBody(await report());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
