import path from "node:path";
import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { dataDir } from "@/lib/dataDir";
import { scenarioId, scenarioOf, scenarioSays } from "@/lib/fire/scenarios";
import { addMark, readMarks, removeMark } from "@/lib/markStore";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** FIRE's saved scenarios (lib/fire/scenarios.ts, data/fire-scenarios.json): read per request, never part of a figure. */
const file = () => process.env.FIRE_SCENARIOS_FILE || path.join(dataDir(), "fire-scenarios.json");

const list = () => readMarks(file()).flatMap((m) => scenarioOf(m) ?? []);

export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ scenarios: list() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Couldn't read the scenarios" }, { status: 500 });
  }
}

/** Body: { op: "save", name, workYears, livingDelta, oneOff } keeps a scenario (replacing one of the same name); { op: "remove", id } drops it. */
export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  try {
    if (body?.op === "remove" && typeof body.id === "string") {
      removeMark(file(), body.id);
      await logAuditEvent({ action: "fire_scenario_removed", actor: AUDIT_ACTOR_APP, payload: { id: body.id } });
      return NextResponse.json({ scenarios: list() });
    }
    if (body?.op !== "save" || typeof body.name !== "string" || !scenarioId(body.name)) return NextResponse.json({ error: "op (save with a name, or remove with an id) is required" }, { status: 400 });
    const s = scenarioOf({ id: scenarioId(body.name), says: JSON.stringify(body) });
    if (!s) return NextResponse.json({ error: "A scenario needs a name" }, { status: 400 });
    addMark(file(), { id: s.id, says: scenarioSays(s) });
    await logAuditEvent({ action: "fire_scenario_saved", actor: AUDIT_ACTOR_APP, payload: { id: s.id } });
    return NextResponse.json({ scenarios: list() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Couldn't save" }, { status: 400 });
  }
}
