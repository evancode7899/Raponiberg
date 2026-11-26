import path from "node:path";
import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { dataDir } from "@/lib/dataDir";
import { addMark, readMarks, removeMark } from "@/lib/markStore";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** The bills the owner means to cancel (lib/markStore.ts, data/cancel-list.json): read per request, never part of a figure. */
const file = () => process.env.CANCEL_LIST_FILE || path.join(dataDir(), "cancel-list.json");

export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ marks: readMarks(file()) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Couldn't read the cancel list" }, { status: 500 });
  }
}

/** Body: { op: "add", key, says } puts a bill on the list; { op: "remove", key } takes it off. */
export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { op?: unknown; key?: unknown; says?: unknown } | null;
  const key = typeof body?.key === "string" ? body.key : "";
  if (!key || (body?.op !== "add" && body?.op !== "remove")) return NextResponse.json({ error: "op (add or remove) and key are required" }, { status: 400 });
  try {
    const marks = body.op === "add" ? addMark(file(), { id: key, says: typeof body.says === "string" ? body.says : "" }) : removeMark(file(), key);
    await logAuditEvent({ action: body.op === "add" ? "cancel_list_added" : "cancel_list_removed", actor: AUDIT_ACTOR_APP, payload: { key } });
    return NextResponse.json({ marks });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Couldn't save" }, { status: 400 });
  }
}
