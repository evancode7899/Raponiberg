import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { dataStamp, stampTag } from "@/lib/book/cache";
import { prisma } from "@/lib/db";
import { INSURANCE_NOTES_KEY, normalizeInsuranceNotes } from "@/lib/insurance/notes";
import { loadInsurancePage } from "@/lib/insurance/page";
import { saveJsonSetting } from "@/lib/settingsStore";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Every life insurance policy found in the statements folder, with its premiums from the statements (lib/insurance). */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    // The stamp of the data read, taken before reading it: a change during the read makes it stale, never newer.
    const stamp = dataStamp();
    return NextResponse.json(await loadInsurancePage(prisma), { headers: { "x-data-stamp": stampTag(stamp) } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the insurance documents" }, { status: 500 });
  }
}

/** Body: the owner's notes on every policy (InsuranceNotes: beneficiaries and a note, by policy number). */
export async function PUT(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Expected the policy notes" }, { status: 400 });
  }
  const saved = await saveJsonSetting(prisma, INSURANCE_NOTES_KEY, body, normalizeInsuranceNotes);
  // Names stay in the setting; the audit trail only says how many policies have notes.
  await logAuditEvent({ action: "insurance_notes_updated", actor: AUDIT_ACTOR_APP, payload: { policies: Object.keys(saved.policies).length } });
  return NextResponse.json(saved);
}
