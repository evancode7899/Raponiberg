/**
 * Moves a database whose recorded migration history isn't in prisma/migrations (a copy
 * from before the history was consolidated into one baseline) onto the current history,
 * so `prisma migrate deploy` can carry on from there. Runs first in `npm run db:refresh`;
 * does nothing for a new database or one already on this history.
 *
 * After a backup, the schema is brought in line with prisma/schema.prisma, the old
 * history rows are cleared, and every local migration is recorded as applied.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { resolveDbFilePath } from "./databasePath.mjs";

const PRISMA_CLI = path.join(process.cwd(), "node_modules", "prisma", "build", "index.js");

function run(args, { env, input } = {}) {
  const r = spawnSync(process.execPath, args, {
    env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: "1", ...env },
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (r.status !== 0) {
    if (r.stdout) console.error(r.stdout);
    throw new Error(`Failed: node ${args.join(" ")}`);
  }
  return r.stdout;
}

async function appliedMigrations(url) {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const table = await prisma.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_prisma_migrations'",
    );
    if (table.length === 0) return [];
    const rows = await prisma.$queryRawUnsafe(
      "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL",
    );
    return rows.map((r) => r.migration_name);
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const dbPath = resolveDbFilePath();
  if (!existsSync(dbPath)) return;
  const url = `file:${dbPath.replaceAll("\\", "/")}`;

  const applied = await appliedMigrations(url);
  const local = readdirSync(path.join(process.cwd(), "prisma", "migrations"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  if (applied.length === 0 || applied.some((name) => local.includes(name))) return;

  console.log(`Migration history in ${dbPath} predates prisma/migrations; moving it onto the current baseline.`);
  process.stdout.write(run(["scripts/backup-database.mjs"], { env: { DATABASE_URL: url } }));

  const tmp = mkdtempSync(path.join(os.tmpdir(), "pf-rebaseline-"));
  try {
    const sql = run([PRISMA_CLI, "migrate", "diff", "--from-url", url, "--to-schema-datamodel", "prisma/schema.prisma", "--script"]);
    const sqlFile = path.join(tmp, "align.sql");
    writeFileSync(sqlFile, sql);
    run([PRISMA_CLI, "db", "execute", "--url", url, "--file", sqlFile]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  run([PRISMA_CLI, "db", "execute", "--url", url, "--stdin"], { input: "DELETE FROM _prisma_migrations;" });
  for (const name of local) {
    run([PRISMA_CLI, "migrate", "resolve", "--applied", name], { env: { DATABASE_URL: url } });
  }
  console.log(`Recorded ${local.length} migration(s) as applied.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
