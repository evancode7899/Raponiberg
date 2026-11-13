import { AUDIT_ACTOR_SETTINGS, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { prisma } from "@/lib/db";
import { assertSettingsDatabaseRequest } from "@/lib/settingsDatabaseAuth";
import { resolveSqliteDatabaseFilePath } from "@/lib/sqliteDbPath";
import { databaseBytes } from "@/lib/sqliteSnapshot";
import { existsSync } from "node:fs";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = assertSettingsDatabaseRequest(req);
  if (auth) {
    return auth;
  }

  const dbPath = resolveSqliteDatabaseFilePath();
  if (!dbPath) {
    return NextResponse.json(
      { error: "DATABASE_URL must be a file: SQLite URL for this export." },
      { status: 400 },
    );
  }
  if (!existsSync(dbPath)) {
    return NextResponse.json(
      { error: `Database file not found: ${dbPath}` },
      { status: 404 },
    );
  }

  // A copy SQLite writes itself: the file on disk alone can lack what the write-ahead log still holds.
  let buf: Buffer;
  try {
    buf = await databaseBytes(prisma);
  } catch (e) {
    return NextResponse.json({ error: `Could not copy the database: ${e instanceof Error ? e.message : e}` }, { status: 500 });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  await logAuditEvent({
    action: "export_database_sqlite",
    actor: AUDIT_ACTOR_SETTINGS,
    payload: { bytes: buf.length, pathHint: "finance.db" },
  });

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="finance_backup_${stamp}.db"`,
      "Cache-Control": "no-store",
    },
  });
}
