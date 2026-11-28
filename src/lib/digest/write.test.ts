import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { digestDir, digestStale } from "./write";

const root = path.resolve("/apps/raponiberg");

describe("digestDir", () => {
  it("is DIGEST_DIR, outside the app folder", () => {
    expect(digestDir(root, { DIGEST_DIR: "/phone/sync" })).toBe(path.resolve("/phone/sync"));
  });
  it("is null when unset, for the demo, or inside the app folder", () => {
    expect(digestDir(root, {})).toBeNull();
    expect(digestDir(root, { DIGEST_DIR: "  " })).toBeNull();
    expect(digestDir(root, { DIGEST_DIR: "/phone/sync", APP_PROFILE: "demo" })).toBeNull();
    expect(digestDir(root, { DIGEST_DIR: path.join(root, "data") })).toBeNull();
    expect(digestDir(root, { DIGEST_DIR: root })).toBeNull();
  });
});

describe("digestStale", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "digest-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "d.html");
  const now = new Date(2026, 2, 31, 12);

  it("rewrites when the backup saved something new, or there's no digest yet", () => {
    expect(digestStale(file, false, now)).toBe(true);
    writeFileSync(file, "x");
    utimesSync(file, now, now);
    expect(digestStale(file, true, now)).toBe(true);
  });
  it("leaves a digest from today alone when nothing changed, and rewrites one from an earlier day", () => {
    utimesSync(file, now, new Date(2026, 2, 31, 8));
    expect(digestStale(file, false, now)).toBe(false);
    utimesSync(file, now, new Date(2026, 2, 30, 23));
    expect(digestStale(file, false, now)).toBe(true);
  });
});
