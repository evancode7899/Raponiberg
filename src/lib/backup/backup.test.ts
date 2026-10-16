import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupRoot, createBackup, dataFiles, listSnapshots, restoreSnapshot, snapshotsToPrune, verifySnapshot, type BackupDb } from "./backup";

let tmp: string;
let dataDir: string;
let root: string;
let dbBytes: string;

/** Stands in for Prisma: VACUUM INTO writes the "database" to the given path. */
const fakeDb: BackupDb = {
  async $executeRawUnsafe(q: string) {
    const m = /^VACUUM INTO '(.*)'$/.exec(q);
    if (!m) throw new Error(`unexpected ${q}`);
    writeFileSync(m[1]!.replace(/''/g, "'"), dbBytes);
    return 0;
  },
  async $queryRawUnsafe() {
    return [{ migration_name: "20261009120000_init" }];
  },
};

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "pf-backup-test-"));
  dataDir = path.join(tmp, "app", "data");
  root = path.join(tmp, "OneDrive", "Backup");
  mkdirSync(path.join(dataDir, "statements"), { recursive: true });
  mkdirSync(path.dirname(root), { recursive: true });
  dbBytes = "ledger v1";
  writeFileSync(path.join(dataDir, "finance.db"), "live");
  writeFileSync(path.join(dataDir, "finance.db-wal"), "wal");
  writeFileSync(path.join(dataDir, "merchant-rules.json"), '{"rules":[]}');
  writeFileSync(path.join(dataDir, "row-decisions.journal.jsonl"), "{}\n");
  writeFileSync(path.join(dataDir, "statements", "abc.pdf"), "%PDF-1");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("createBackup", () => {
  it("writes a snapshot with the database, the data files and a manifest, and mirrors statements", async () => {
    const r = await createBackup(fakeDb, { root, dataDir, now: new Date(2026, 9, 9, 22, 15, 3), reason: "test" });
    expect(r.status).toBe("created");
    expect(r.snapshot.name).toBe("2026-10-09_22-15-03");
    expect(readdirSync(r.snapshot.dir).sort()).toEqual(["finance.db", "manifest.json", "merchant-rules.json", "row-decisions.journal.jsonl"]);
    expect(readFileSync(path.join(r.snapshot.dir, "finance.db"), "utf8")).toBe("ledger v1");
    expect(r.snapshot.manifest.migration).toBe("20261009120000_init");
    expect(readFileSync(path.join(root, "statements", "abc.pdf"), "utf8")).toBe("%PDF-1");
    expect(existsSync(path.join(root, "README.txt"))).toBe(true);
    expect(verifySnapshot(r.snapshot)).toEqual([]);
  });

  it("writes nothing new when nothing changed, and a new snapshot when something did", async () => {
    await createBackup(fakeDb, { root, dataDir, now: new Date(2026, 9, 9, 10, 0, 0) });
    const same = await createBackup(fakeDb, { root, dataDir, now: new Date(2026, 9, 9, 10, 15, 0) });
    expect(same.status).toBe("unchanged");
    writeFileSync(path.join(dataDir, "merchant-rules.json"), '{"rules":[1]}');
    const changed = await createBackup(fakeDb, { root, dataDir, now: new Date(2026, 9, 9, 10, 30, 0) });
    expect(changed.status).toBe("created");
    expect(listSnapshots(root).map((s) => s.name)).toEqual(["2026-10-09_10-30-00", "2026-10-09_10-00-00"]);
  });

  it("refuses a backup folder whose parent doesn't exist (OneDrive not there)", async () => {
    await expect(createBackup(fakeDb, { root: path.join(tmp, "nope", "Backup"), dataDir })).rejects.toThrow(/parent doesn't exist/);
  });

  it("ignores a snapshot folder without a manifest", async () => {
    mkdirSync(path.join(root, "snapshots", "2026-10-10_00-00-00"), { recursive: true });
    expect(listSnapshots(root)).toEqual([]);
  });
});

describe("verifySnapshot", () => {
  it("catches a file that changed or went missing", async () => {
    const { snapshot } = await createBackup(fakeDb, { root, dataDir });
    writeFileSync(path.join(snapshot.dir, "merchant-rules.json"), "tampered");
    rmSync(path.join(snapshot.dir, "row-decisions.journal.jsonl"));
    expect(verifySnapshot(snapshot)).toEqual(["merchant-rules.json doesn't match its manifest", "row-decisions.journal.jsonl is missing"]);
  });
});

describe("restoreSnapshot", () => {
  it("puts the snapshot back and keeps the previous data", async () => {
    const { snapshot } = await createBackup(fakeDb, { root, dataDir });
    const fresh = path.join(tmp, "new-pc", "data");
    mkdirSync(fresh, { recursive: true });
    writeFileSync(path.join(fresh, "finance.db"), "empty");
    writeFileSync(path.join(fresh, "finance.db-wal"), "stale wal");
    const r = restoreSnapshot({ snapshot, root, dataDir: fresh, dbFile: path.join(fresh, "finance.db") }, new Date(2026, 9, 10, 8, 0, 0));
    expect(readFileSync(path.join(fresh, "finance.db"), "utf8")).toBe("ledger v1");
    expect(existsSync(path.join(fresh, "finance.db-wal"))).toBe(false);
    expect(readFileSync(path.join(fresh, "merchant-rules.json"), "utf8")).toBe('{"rules":[]}');
    expect(readFileSync(path.join(fresh, "statements", "abc.pdf"), "utf8")).toBe("%PDF-1");
    expect(r.previous).toBe(path.join(fresh, "backups", "pre-restore_2026-10-10_08-00-00"));
    expect(readFileSync(path.join(r.previous!, "finance.db"), "utf8")).toBe("empty");
  });
});

describe("snapshotsToPrune", () => {
  it("keeps the newest 10, one a day for 45 days, then one a month", () => {
    const now = new Date(2026, 9, 10, 12, 0, 0);
    const names = [
      ...Array.from({ length: 12 }, (_, i) => `2026-10-10_${String(i).padStart(2, "0")}-00-00`),
      "2026-10-01_09-00-00",
      "2026-10-01_08-00-00",
      "2026-06-20_09-00-00",
      "2026-06-05_09-00-00",
    ];
    expect(snapshotsToPrune(names, now).sort()).toEqual(["2026-06-05_09-00-00", "2026-10-01_08-00-00", "2026-10-10_00-00-00", "2026-10-10_01-00-00"]);
  });
});

describe("dataFiles / backupRoot", () => {
  it("leaves database and temp files out", () => {
    writeFileSync(path.join(dataDir, "x.json.tmp"), "");
    writeFileSync(path.join(dataDir, ".gitkeep"), "");
    expect(dataFiles(dataDir)).toEqual(["merchant-rules.json", "row-decisions.journal.jsonl"]);
  });

  it("finds the folder from BACKUP_DIR, else beside the statements folder", () => {
    expect(backupRoot({ BACKUP_DIR: root })).toEqual({ root, source: "BACKUP_DIR" });
    const statements = path.join(tmp, "OneDrive", "Statements");
    expect(backupRoot({ STATEMENTS_DIR: statements })).toEqual({ root: path.join(tmp, "OneDrive", "Backup"), source: "statements" });
    expect(backupRoot({ STATEMENTS_DIR: path.join(tmp, "missing", "Statements") })).toBeNull();
  });

  it("never gives the demo a backup folder, even with BACKUP_DIR set", () => {
    expect(backupRoot({ APP_PROFILE: "demo", BACKUP_DIR: root })).toBeNull();
    expect(backupRoot({ APP_PROFILE: "demo", STATEMENTS_DIR: path.join(tmp, "OneDrive", "Statements") })).toBeNull();
  });
});
