import { AUDIT_ACTOR_SETTINGS, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { dataDir } from "@/lib/dataDir";
import { prisma } from "@/lib/db";
import { assertSettingsDatabaseRequest } from "@/lib/settingsDatabaseAuth";
import {
  bufferLooksLikeSqliteDatabase,
  resolveSqliteDatabaseFilePath,
  sqliteFileUrlForPath,
} from "@/lib/sqliteDbPath";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = assertSettingsDatabaseRequest(req);
  if (auth) {
    return auth;
  }

  const dbPath = resolveSqliteDatabaseFilePath();
  if (!dbPath) {
    return NextResponse.json(
      { error: "DATABASE_URL must be a file: SQLite URL." },
      { status: 400 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json(
      { error: 'Missing file field (use name "file")' },
      { status: 400 },
    );
  }

  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length < 1024) {
    return NextResponse.json({ error: "File too small to be a SQLite database" }, { status: 400 });
  }
  if (!bufferLooksLikeSqliteDatabase(buf)) {
    return NextResponse.json(
      { error: "Not a SQLite database file (bad header)" },
      { status: 400 },
    );
  }

  const tmpName = `pf-import-${randomBytes(12).toString("hex")}.db`;
  const tmpPath = path.join(tmpdir(), tmpName);

  function removeTempDbFiles() {
    for (const side of [`${tmpPath}-wal`, `${tmpPath}-shm`]) {
      try {
        if (existsSync(side)) unlinkSync(side);
      } catch {
        /* ignore */
      }
    }
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
  }

  let validate: PrismaClient | null = null;
  try {
    writeFileSync(tmpPath, buf);

    validate = new PrismaClient({
      datasources: { db: { url: sqliteFileUrlForPath(tmpPath) } },
    });
    await validate.$connect();
    const rows = (await validate.$queryRawUnsafe(
      "PRAGMA integrity_check",
    )) as { integrity_check: string }[];
    const check = rows?.[0]?.integrity_check;
    if (check !== "ok") {
      removeTempDbFiles();
      return NextResponse.json(
        { error: `integrity_check failed: ${check ?? "unknown"}` },
        { status: 400 },
      );
    }
  } catch (e) {
    removeTempDbFiles();
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Validation failed" },
      { status: 400 },
    );
  } finally {
    if (validate) {
      await validate.$disconnect().catch(() => {});
    }
  }

  const backupsDir = path.join(dataDir(), "backups");
  mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const preImportPath = path.join(backupsDir, `finance_pre_import_${stamp}.db`);

  try {
    if (existsSync(dbPath)) {
      copyFileSync(dbPath, preImportPath);
    }

    await prisma.$disconnect();

    for (const suffix of ["-wal", "-shm"] as const) {
      const side = dbPath + suffix;
      if (existsSync(side)) {
        try {
          unlinkSync(side);
        } catch {
          /* ignore */
        }
      }
    }

    copyFileSync(tmpPath, dbPath);
  } catch (e) {
    try {
      await prisma.$connect();
    } catch {
      /* ignore */
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Replace failed" },
      { status: 500 },
    );
  } finally {
    removeTempDbFiles();
  }

  try {
    await prisma.$connect();
  } catch {
    /* next request may still connect */
  }

  await logAuditEvent({
    action: "import_database_sqlite",
    actor: AUDIT_ACTOR_SETTINGS,
    payload: {
      bytes: buf.length,
      previousSavedTo: existsSync(preImportPath) ? preImportPath : null,
    },
  });

  return NextResponse.json({
    ok: true,
    previousDatabaseBackedUpTo: existsSync(preImportPath)
      ? preImportPath
      : null,
  });
}
