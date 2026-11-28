import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { fireScenario, fromFireMark } from "@/lib/fire/scenarios";
import { migrateFireScenarios, readScenarios, writeScenarios } from "@/lib/scenarios/store";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * FIRE's scenarios: the Scenarios page's own (data/scenarios.json, lib/scenarios), one concept
 * for both pages. Read per request, never part of a figure. FIRE's old file is moved in once.
 */
const list = () => {
  migrateFireScenarios(fromFireMark);
  return readScenarios().scenarios;
};

export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ scenarios: list() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Couldn't read the scenarios" }, { status: 500 });
  }
}

/**
 * Body: { op: "save", name, workYears, livingDelta, oneOff } keeps a scenario (replacing FIRE's
 * parts of one of the same name, and keeping whatever else the Scenarios page set on it);
 * { op: "remove", id } drops it from both pages.
 */
export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  try {
    list();
    const file = readScenarios();
    if (body?.op === "remove" && typeof body.id === "string") {
      writeScenarios({ ...file, scenarios: file.scenarios.filter((s) => s.id !== body.id), compare: file.compare.filter((id) => id !== body.id) });
      await logAuditEvent({ action: "fire_scenario_removed", actor: AUDIT_ACTOR_APP, payload: { id: body.id, from: "fire" } });
      return NextResponse.json({ scenarios: readScenarios().scenarios });
    }
    if (body?.op !== "save" || typeof body.name !== "string" || !body.name.trim()) return NextResponse.json({ error: "op (save with a name, or remove with an id) is required" }, { status: 400 });
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const o = body.oneOff as { year?: unknown; amount?: unknown } | null | undefined;
    const made = fireScenario(body.name, { workYears: num(body.workYears), livingDelta: num(body.livingDelta), oneOff: o && num(o.amount) > 0 ? { year: num(o.year), amount: num(o.amount) } : null });
    const had = file.scenarios.find((s) => s.id === made.id);
    const next = had ? { ...had, retire: made.retire, spending: { ...had.spending, livingChange: made.spending.livingChange, oneOffs: [...had.spending.oneOffs.filter((x) => x.id !== "one-off"), ...made.spending.oneOffs] } } : made;
    writeScenarios({ ...file, scenarios: had ? file.scenarios.map((s) => (s.id === made.id ? next : s)) : [...file.scenarios, next] });
    await logAuditEvent({ action: "fire_scenario_saved", actor: AUDIT_ACTOR_APP, payload: { id: made.id, from: "fire" } });
    return NextResponse.json({ scenarios: readScenarios().scenarios });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Couldn't save" }, { status: 400 });
  }
}
