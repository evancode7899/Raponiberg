import { AUDIT_ACTOR_SETTINGS, logAuditEvent } from "@/lib/audit/logAuditEvent";
import { proofSweep } from "@/lib/book/proof/sweepProcess";
import { dataDir } from "@/lib/dataDir";
import { prisma } from "@/lib/db";
import { copyDatabaseTo } from "@/lib/sqliteSnapshot";
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

type RawDb = { $queryRawUnsafe(query: string): Promise<unknown> };

/** The migrations a database has applied, oldest first: what says which tables it holds. */
async function migrationNames(db: RawDb): Promise<string[]> {
  const rows = (await db.$queryRawUnsafe("SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name")) as { migration_name: string }[];
  return rows.map((r) => r.migration_name);
}

/**
 * Removes the database's write-ahead log and shared-memory files, waiting up to three
 * seconds for a process that was just stopped to let go of them. Returns the one that
 * couldn't be removed, or null. Blocks on purpose: see where it's called.
 */
function removeSideFiles(dbPath: string): string | null {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    let stuck: string | null = null;
    for (const suffix of ["-wal", "-shm"]) {
      const side = dbPath + suffix;
      try {
        if (existsSync(side)) unlinkSync(side);
      } catch {
        stuck ??= side;
      }
    }
    if (!stuck || attempt >= 30) return stuck;
    Atomics.wait(pause, 0, 0, 100);
  }
}

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
    // A sound SQLite file isn't yet this app's database: it must hold the same tables,
    // which its migration history says. (An older backup comes back with `npm run restore`,
    // which brings it up to date.)
    const theirs = await migrationNames(validate).catch(() => null);
    const ours = await migrationNames(prisma).catch(() => null);
    if (!theirs || (ours && theirs.join("\n") !== ours.join("\n"))) {
      removeTempDbFiles();
      return NextResponse.json(
        {
          error: theirs
            ? "This database was made by a different version of the app (its tables don't match). Restore it with npm run restore instead."
            : "This SQLite file isn't a database from this app.",
        },
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
      // SQLite writes the copy itself, so it includes what the write-ahead log still holds.
      await copyDatabaseTo(prisma, preImportPath);
    }

    // The proof sweep's process holds the database open too.
    proofSweep().stop();
    await prisma.$disconnect();

    // From here to the copy nothing awaits, so no other request can reopen the database.
    // The old write-ahead log must go: left beside the new file, SQLite would replay it
    // onto a database it doesn't belong to.
    const leftover = removeSideFiles(dbPath);
    if (leftover) {
      throw new Error(`Another program still has the database open (${path.basename(leftover)} can't be removed). Nothing was replaced; close it and try again.`);
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
