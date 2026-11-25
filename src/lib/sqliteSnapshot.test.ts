import { PrismaClient } from "@prisma/client";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { snapshotBefore } from "./sqliteSnapshot";

let dir: string;
let db: PrismaClient;
const open = (file: string) => new PrismaClient({ datasources: { db: { url: `file:${file.replace(/\\/g, "/")}` } } });

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "snapshot-"));
  db = open(path.join(dir, "live.db"));
  await db.$executeRawUnsafe("CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT)");
  await db.$executeRawUnsafe("INSERT INTO notes (text) VALUES ('kept')");
});
afterEach(async () => {
  await db.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("the copy kept before a wipe", () => {
  it("holds everything, and survives the wipe that follows", async () => {
    const file = await snapshotBefore(db, dir, "wipe", new Date("2026-01-02T03:04:05Z"));
    expect(path.basename(file)).toBe("finance_pre_wipe_2026-01-02T03-04-05.db");
    await db.$executeRawUnsafe("DELETE FROM notes");
    const copy = open(file);
    expect(await copy.$queryRawUnsafe("SELECT text FROM notes")).toEqual([{ text: "kept" }]);
    await copy.$disconnect();
  });

  it("fails rather than overwrite a copy already there, so the wipe doesn't go ahead", async () => {
    const at = new Date("2026-01-02T03:04:05Z");
    await snapshotBefore(db, dir, "wipe", at);
    await expect(snapshotBefore(db, dir, "wipe", at)).rejects.toThrow();
    expect(readdirSync(path.join(dir, "backups"))).toHaveLength(1);
    expect(existsSync(path.join(dir, "live.db"))).toBe(true);
  });
});
