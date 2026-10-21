import { AUDIT_ACTOR_APP, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { cachedReport, jsonBody } from "@/lib/book/cache";
import { buildTaxAccounts } from "@/lib/book/reports/taxAccounts";
import { prisma } from "@/lib/db";
import { taxLink } from "@/lib/forecast/forecast";
import { loadForecast } from "@/lib/forecast/load";
import { loadProfileSettings } from "@/lib/profile/settings";
import { loadJsonSetting, saveJsonSetting } from "@/lib/settingsStore";
import { normalizeRetirementSettings, RETIREMENT_SETTINGS_KEY } from "@/lib/taxAccounts/settings";
import { TAX_YEARS } from "@/lib/tax/params";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Room left in every tax-advantaged account for a year (?year=, default this year). */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const years = Object.keys(TAX_YEARS).map(Number).sort();
  const asked = Number(request.nextUrl.searchParams.get("year"));
  return jsonBody(
    await cachedReport(prisma, `tax-accounts|${years.includes(asked) ? asked : "current"}`, async (book) => {
      // No year asked: the Book's year (book.today), the one every figure is built as of.
      const thisYear = Number(book.today.slice(0, 4));
      const year = years.includes(asked) ? asked : years.includes(thisYear) ? thisYear : years.at(-1)!;
      const [settings, profile, { forecast }] = await Promise.all([loadJsonSetting(prisma, RETIREMENT_SETTINGS_KEY, normalizeRetirementSettings), loadProfileSettings(prisma), loadForecast(prisma, book)]);
      // The year in progress uses the shared forecast's pay and bonuses, as the Taxes page does.
      const report = buildTaxAccounts(book, year, settings, profile.birthYears, forecast ? taxLink(forecast) : null);
      return { report, settings, years, persons: book.persons.map((p) => ({ id: p.id, name: p.name })) };
    }),
  );
}

/** Body: the whole retirement-accounts settings object. */
export async function PUT(request: NextRequest) {
  if (!checkApiAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Expected a settings object" }, { status: 400 });
  }
  const saved = await saveJsonSetting(prisma, RETIREMENT_SETTINGS_KEY, body, normalizeRetirementSettings);
  await logAuditEvent({ action: "retirement_accounts_updated", actor: AUDIT_ACTOR_APP, payload: { people: Object.keys(saved.people) } });
  return NextResponse.json(saved);
}
