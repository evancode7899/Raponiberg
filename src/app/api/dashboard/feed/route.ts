import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { decideFeedItem, readFeedDecisions, undoFeedDecision } from "@/lib/insights/feedDecisions";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** The owner's decisions on the Dashboard's feed (lib/insights/feedDecisions.ts): { marks }. Read per request; the Book never reads them. */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ marks: readFeedDecisions() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Couldn't read the feed decisions" }, { status: 500 });
  }
}

/**
 * Body: { op: "dismiss", id, says } hides an item until what it says changes; { op: "remind",
 * id, says, until } hides it until that day; { op: "undo", id } brings it back.
 */
export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { op?: unknown; id?: unknown; says?: unknown; until?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  try {
    if (body?.op === "undo") {
      const marks = undoFeedDecision(id);
      await logAuditEvent({ action: "feed_decision_undone", actor: AUDIT_ACTOR_APP, payload: { id } });
      return NextResponse.json({ marks });
    }
    if (body?.op !== "dismiss" && body?.op !== "remind") return NextResponse.json({ error: "op must be dismiss, remind or undo" }, { status: 400 });
    if (body.op === "remind" && typeof body.until !== "string") return NextResponse.json({ error: "until is required to remind" }, { status: 400 });
    const marks = decideFeedItem({ id, says: typeof body.says === "string" ? body.says : "", until: body.op === "remind" ? (body.until as string) : null });
    // The item's id names what it is about; what it says (amounts) stays in the data folder.
    await logAuditEvent({ action: body.op === "dismiss" ? "feed_item_dismissed" : "feed_item_reminded", actor: AUDIT_ACTOR_APP, payload: { id, ...(body.op === "remind" ? { until: body.until as string } : {}) } });
    return NextResponse.json({ marks });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Couldn't save" }, { status: 400 });
  }
}
