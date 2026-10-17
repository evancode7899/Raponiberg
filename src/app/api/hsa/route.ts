import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { localToday } from "@/lib/dates/isoDate";
import { cachedReport } from "@/lib/book/cache";
import { prisma } from "@/lib/db";
import { taxLink } from "@/lib/forecast/forecast";
import { loadForecast } from "@/lib/forecast/load";
import { hsaLedger, hsaTaxMarginal, type HsaLedger } from "@/lib/hsa/load";
import { buildHsaReport, type TaxMarginalIn } from "@/lib/hsa/report";
import { loadProfileSettings } from "@/lib/profile/settings";
import { applyHsaOp, readHsaFile, type HsaOp } from "@/lib/hsa/store";
import { loadJsonSetting } from "@/lib/settingsStore";
import { normalizeRetirementSettings, RETIREMENT_SETTINGS_KEY } from "@/lib/taxAccounts/settings";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** The HSA receipts log joined to the ledger (lib/hsa/report.ts). */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const file = readHsaFile();
    const [ledger, retirement] = await Promise.all([
      cachedReport(prisma, "hsa-ledger", async (book) => {
        // The Taxes page's marginal rates, on the same forecast and birth years it uses.
        const [{ forecast }, profile] = await Promise.all([loadForecast(prisma, book), loadProfileSettings(prisma)]);
        return { ...hsaLedger(book), taxMarginal: hsaTaxMarginal(book, Number(localToday().slice(0, 4)), forecast ? taxLink(forecast) : null, profile.birthYears) };
      }).then((t) => JSON.parse(t) as HsaLedger & { taxMarginal: TaxMarginalIn | null }),
      loadJsonSetting(prisma, RETIREMENT_SETTINGS_KEY, normalizeRetirementSettings),
    ]);
    const report = buildHsaReport({ today: localToday(), file, ...ledger, marginalRate: retirement.marginalRate });
    return NextResponse.json(report);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the HSA log" }, { status: 500 });
  }
}

/** Body: one change (lib/hsa/store.ts HsaOp): add, update, delete, reimburse, dismiss… */
export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as HsaOp | null;
  if (!body || typeof body !== "object" || typeof body.op !== "string") {
    return NextResponse.json({ error: "Expected a change ({ op: … })" }, { status: 400 });
  }
  try {
    const result = applyHsaOp(body);
    // Amounts and providers stay in the journal beside the log; the audit trail only says what kind of change.
    if (result.changed) await logAuditEvent({ action: "hsa_expenses_updated", actor: AUDIT_ACTOR_APP, payload: { op: body.op, changed: result.changed } });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not save" }, { status: 400 });
  }
}
