import { PrismaClient } from "@prisma/client";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertBackupSource } from "./backup";

// Against real SQLite: what it reports as the open file and its tables.
let tmp: string;
const opened: PrismaClient[] = [];
const open = (file: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  const c = new PrismaClient({ datasources: { db: { url: `file:${file.replace(/\\/g, "/")}` } } });
  opened.push(c);
  return c;
};
const ledger = async (c: PrismaClient) => {
  await c.$executeRawUnsafe(`CREATE TABLE "Account" (id TEXT PRIMARY KEY)`);
  return c;
};

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "pf-source-test-"));
});
afterEach(async () => {
  for (const c of opened.splice(0)) await c.$disconnect();
  rmSync(tmp, { recursive: true, force: true });
});

describe("assertBackupSource", () => {
  it("accepts the data folder's finance.db with the app's tables", async () => {
    const dataDir = path.join(tmp, "app", "data");
    const db = await ledger(open(path.join(dataDir, "finance.db")));
    await expect(assertBackupSource(db, dataDir)).resolves.toBeUndefined();
  });

  it("refuses an empty database, as Prisma creates one for a missing file", async () => {
    const dataDir = path.join(tmp, "app", "data");
    const db = open(path.join(dataDir, "finance.db"));
    await expect(assertBackupSource(db, dataDir)).rejects.toThrow(/none of the app's tables/);
  });

  it("refuses another checkout's database even when it has the tables", async () => {
    const dataDir = path.join(tmp, "app", "data");
    await ledger(open(path.join(dataDir, "finance.db")));
    const other = await ledger(open(path.join(tmp, "worktree", "data", "finance.db")));
    await expect(assertBackupSource(other, dataDir)).rejects.toThrow(/open, not/);
  });
});
