import { AUDIT_ACTOR_SETTINGS, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { prisma } from "@/lib/db";
import { assertSettingsDatabaseRequest } from "@/lib/settingsDatabaseAuth";
import { resolveSqliteDatabaseFilePath } from "@/lib/sqliteDbPath";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const WIPE_CONFIRM = "WIPE ALL LOCAL DATA";

/**
 * Every table the statement ledger and its settings live in. AuditEvent is kept so the
 * wipe (and everything before it) stays traceable; the stored statement PDFs on disk
 * (data/statements) are left alone, so they can be imported again.
 */
const TABLES = [
  "TransferLeg",
  "TransferMatch",
  "TransferRejection",
  "Transaction",
  "PayStub",
  "StatementImport",
  "SourceDocument",
  "AccountAlias",
  "MerchantCategoryRule",
  "Account",
  "Category",
  "AppSetting",
  "BudgetLine",
];

export async function POST(req: Request) {
  const auth = assertSettingsDatabaseRequest(req);
  if (auth) {
    return auth;
  }

  if (!resolveSqliteDatabaseFilePath()) {
    return NextResponse.json({ error: "DATABASE_URL must be a file: SQLite URL." }, { status: 400 });
  }

  let body: { confirm?: string } = {};
  try {
    body = (await req.json()) as { confirm?: string };
  } catch {
    return NextResponse.json({ error: "Expected JSON body" }, { status: 400 });
  }
  if (body.confirm !== WIPE_CONFIRM) {
    return NextResponse.json({ error: "Confirmation mismatch", hint: `Send JSON { "confirm": "${WIPE_CONFIRM}" }` }, { status: 400 });
  }

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("PRAGMA defer_foreign_keys = ON");
    for (const t of TABLES) await tx.$executeRawUnsafe(`DELETE FROM "${t}"`);
  });

  try {
    await prisma.$executeRawUnsafe("VACUUM");
  } catch {
    /* ignore */
  }

  await logAuditEvent({
    action: "wipe_database_sqlite",
    actor: AUDIT_ACTOR_SETTINGS,
    payload: { mode: "statement_ledger", tables: TABLES },
  });

  return NextResponse.json({ ok: true });
}
