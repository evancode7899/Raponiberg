import path from "node:path";
import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { dataDir } from "@/lib/dataDir";
import { addMark, readMarks, removeMark } from "@/lib/markStore";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Calendar dates the owner marked done (lib/markStore.ts, data/calendar-done.json): done stays done, whatever the engines say later. */
const file = () => process.env.CALENDAR_DONE_FILE || path.join(dataDir(), "calendar-done.json");

export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ marks: readMarks(file()) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Couldn't read what's done" }, { status: 500 });
  }
}

/** Body: { op: "done", id } marks a date done; { op: "open", id } takes the mark off. */
export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { op?: unknown; id?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id || (body?.op !== "done" && body?.op !== "open")) return NextResponse.json({ error: "op (done or open) and id are required" }, { status: 400 });
  try {
    // Done stays done: the mark holds whatever the item says later, so it says nothing.
    const marks = body.op === "done" ? addMark(file(), { id, says: "" }) : removeMark(file(), id);
    await logAuditEvent({ action: body.op === "done" ? "calendar_item_done" : "calendar_item_reopened", actor: AUDIT_ACTOR_APP, payload: { id } });
    return NextResponse.json({ marks });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Couldn't save" }, { status: 400 });
  }
}
