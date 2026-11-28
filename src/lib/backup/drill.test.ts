import { PrismaClient } from "@prisma/client";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBackup, listSnapshots } from "./backup";
import { drillDue, readDrill, runRestoreDrill, saveDrill } from "./drill";

let tmp: string;
let dataDir: string;
let root: string;
let live: PrismaClient;
const opened: PrismaClient[] = [];
const open = (file: string) => {
  const c = new PrismaClient({ datasources: { db: { url: `file:${file.replace(/\\/g, "/")}` } } });
  opened.push(c);
  return c;
};

beforeEach(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "pf-drill-test-"));
  dataDir = path.join(tmp, "data");
  root = path.join(tmp, "Backup");
  mkdirSync(path.join(dataDir, "statements"), { recursive: true });
  writeFileSync(path.join(dataDir, "merchant-rules.json"), '{"rules":[]}');
  // An invented ledger: two tables of made-up rows.
  live = open(path.join(dataDir, "finance.db"));
  await live.$executeRawUnsafe(`CREATE TABLE "Account" (id TEXT PRIMARY KEY, name TEXT)`);
  await live.$executeRawUnsafe(`CREATE TABLE "Transaction" (id TEXT PRIMARY KEY, cents INTEGER)`);
  await live.$executeRawUnsafe(`INSERT INTO "Account" VALUES ('a1', 'Example Checking ••1234')`);
  for (let i = 0; i < 5; i++) await live.$executeRawUnsafe(`INSERT INTO "Transaction" VALUES ('t${i}', ${(i + 1) * 1111})`);
  await live.$executeRawUnsafe(`CREATE TABLE "_prisma_migrations" (migration_name TEXT, finished_at TEXT)`);
});

afterEach(async () => {
  for (const c of opened.splice(0)) await c.$disconnect();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// Its own lock folder: backup.test.ts backs up at the same time.
const backUp = () => createBackup(live, { root, dataDir, reason: "test", lockDir: tmp });

describe("the restore drill", () => {
  it("says there's nothing to try before the first backup", async () => {
    const r = await runRestoreDrill({ root, live, open, dataDir });
    expect(r).toMatchObject({ ok: false, snapshot: null, checks: [{ ok: false }] });
  });

  it("restores the newest snapshot into a scratch copy, finds it intact and matching", async () => {
    await backUp();
    const r = await runRestoreDrill({ root, live, open, dataDir });
    expect(r.ok).toBe(true);
    expect(r.matches).toBe(true);
    expect(r.checks.map((c) => c.ok)).toEqual([true, true, true, true]);
    expect(r.checks[2]!.detail).toBe("2 tables, 6 rows, the same in both.");
  });

  it("tells changes made since the backup from a broken backup", async () => {
    await backUp();
    await live.$executeRawUnsafe(`INSERT INTO "Transaction" VALUES ('t9', 999)`);
    writeFileSync(path.join(dataDir, "merchant-rules.json"), '{"rules":[1]}');
    const r = await runRestoreDrill({ root, live, open, dataDir });
    expect(r).toMatchObject({ ok: true, matches: false, differences: [{ table: "Transaction", snapshot: 5, live: 6 }], changedFiles: ["merchant-rules.json"] });
  });

  it("fails a snapshot whose files were changed after it was written, without opening it", async () => {
    await backUp();
    const snap = listSnapshots(root)[0]!;
    writeFileSync(path.join(snap.dir, "merchant-rules.json"), "tampered");
    const r = await runRestoreDrill({ root, live, open, dataDir });
    expect(r.ok).toBe(false);
    expect(r.checks).toEqual([expect.objectContaining({ label: "Its files are whole", ok: false, detail: "merchant-rules.json doesn't match its manifest" })]);
  });

  it("is due when never run, or a month after the last", () => {
    const file = path.join(dataDir, "restore-drill.json");
    expect(drillDue(readDrill(file))).toBe(true);
    saveDrill({ at: "2031-03-01T00:00:00.000Z", snapshot: "s", snapshotAt: null, ok: true, matches: true, checks: [], differences: [], changedFiles: [] }, file);
    expect(drillDue(readDrill(file), new Date("2031-03-20T00:00:00Z"))).toBe(false);
    expect(drillDue(readDrill(file), new Date("2031-04-01T00:00:00Z"))).toBe(true);
  });
});
