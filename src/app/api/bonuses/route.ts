import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedReport, getBook, jsonBody } from "@/lib/book/cache";
import { addException, retireException } from "@/lib/book/exceptionStore";
import { bonusesOf, bonusFindingId } from "@/lib/book/reports/bonuses";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** `{ report }` as JSON text. The award letters are a file in data/, read into the Book (which the cache watches). */
function report(): Promise<string> {
  return cachedReport(prisma, "bonuses", (book) => ({ report: bonusesOf(book) }));
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
 * review ("reopen", with a reason). A warning is an open bonus.letters finding, so a
 * review is an integrity exception (the permanent list Statements → Issues keeps), for
 * the warning's current gap, read from the Book here, never from the request.
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
      const book = await getBook(prisma);
      const w = bonusesOf(book).warnings.find((x) => x.id === id);
      const f = w && book.integrity.findings.find((x) => x.id === bonusFindingId(w));
      if (!f) return NextResponse.json({ error: "That warning isn't open any more — reload the page" }, { status: 404 });
      try {
        addException({ id: f.id, check: f.check, note, acceptedAt: new Date().toISOString(), finding: { status: f.status, title: f.title, detail: f.detail, scope: f.scope } });
      } catch (e) {
        return NextResponse.json({ error: (e as Error).message }, { status: 409 });
      }
      await prisma.auditEvent.create({ data: { action: "bonus_warning_reviewed", actor: "owner", payloadJson: { id, note } } });
    } else if (body.action === "reopen") {
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (!reason) return NextResponse.json({ error: "Say why the review no longer holds" }, { status: 400 });
      // `id`: the review's exception (StaleReview.id), or the warning's id at its current gap.
      const book = await getBook(prisma);
      const w = bonusesOf(book).reviewed.find((x) => x.id === id);
      try {
        retireException(w ? bonusFindingId(w) : id, reason);
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
