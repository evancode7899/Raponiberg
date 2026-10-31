import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { addException, retireException } from "@/lib/book/exceptionStore";
import { cachedBuilt, getBook, jsonBody } from "@/lib/book/cache";
import type { Book } from "@/lib/book/load";
import { buildCoverage } from "@/lib/book/reports/coverage";
import { buildStatementPlan } from "@/lib/book/reports/statementPlan";
import { buildBlockerTimeline } from "@/lib/book/reports/timeline";
import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Everything the Statements page shows from the Book, in one load: the report, the
 * statements to download to move the data edge forward, and coverage per account.
 */
const report = (book: Book) => ({
  today: book.today,
  horizon: book.horizon,
  ...book.integrity,
  timeline: buildBlockerTimeline(book),
  plan: buildStatementPlan(book),
  coverage: buildCoverage(book),
});

/**
 * The Book's integrity report: every check with its tally, every open finding (what
 * blocks which figures, and what to fetch or fix), every inferred figure, every
 * exception the owner accepted, every exception awaiting review (its finding no longer
 * arises), every exception the owner retired, the timeline of which months, quarters
 * and years of cash flow, net worth and taxes each finding withholds, the statements
 * to download to unlock the periods past the horizon, and statement coverage per
 * account and month.
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return jsonBody(await cachedBuilt(prisma, "integrity", report));
}

/**
 * Accept an open finding as explained (body: { action: "accept", id, note }), adding it
 * to the permanent exceptions list; or retire an exception (body: { action: "retire",
 * id, reason }) — the owner's approval, with why (usually what new data made it
 * redundant). Exceptions are never removed any other way.
 */
export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { action?: unknown; id?: unknown; note?: unknown; reason?: unknown } | null;
  if (!body || typeof body.id !== "string" || !body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const id = body.id;

  if (body.action === "accept") {
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
    if (!note) return NextResponse.json({ error: "A note explaining the exception is required" }, { status: 400 });
    const f = (await getBook(prisma)).integrity.findings.find((x) => x.id === id);
    if (!f) return NextResponse.json({ error: "That finding isn't open any more — reload the page" }, { status: 404 });
    try {
      addException({
        id: f.id,
        check: f.check,
        ...(f.accounts ? { accounts: f.accounts } : {}),
        note,
        acceptedAt: new Date().toISOString(),
        finding: { status: f.status, title: f.title, detail: f.detail, scope: f.scope },
      });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
    }
    await prisma.auditEvent.create({ data: { action: "integrity_exception_added", actor: "owner", payloadJson: { id, note } } });
  } else if (body.action === "retire") {
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) return NextResponse.json({ error: "Say why the exception is no longer needed" }, { status: 400 });
    try {
      retireException(id, reason);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
    }
    await prisma.auditEvent.create({ data: { action: "integrity_exception_retired", actor: "owner", payloadJson: { id, reason } } });
  } else {
    return NextResponse.json({ error: 'action must be "accept" or "retire"' }, { status: 400 });
  }

  return jsonBody(await cachedBuilt(prisma, "integrity", report));
}
