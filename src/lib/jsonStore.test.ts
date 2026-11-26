import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendJournal, journalPathOf, jsonText, readJsonStore, writeJsonAtomic, writeTextAtomic } from "./jsonStore";

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(path.join(tmpdir(), "pf-jsonstore-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("jsonStore", () => {
  it("keeps each store's own format", () => {
    const data = { version: 1, items: [{ a: 1 }] };
    expect(jsonText(data)).toBe(JSON.stringify(data, null, 2) + "\n");
    expect(jsonText(data, { indent: 1, newline: false })).toBe(JSON.stringify(data, null, 1));
    expect(jsonText(data, { indent: 0, newline: false })).toBe(JSON.stringify(data));
  });

  it("writes whole, makes the folder, and leaves no temporary file", () => {
    const file = path.join(scratch(), "deep", "decisions.json");
    writeJsonAtomic(file, { version: 1, n: 2 });
    expect(readFileSync(file, "utf8")).toBe('{\n  "version": 1,\n  "n": 2\n}\n');
    expect(existsSync(`${file}.tmp`)).toBe(false);
    writeTextAtomic(file, "x", { tmp: `${file}.42.tmp` });
    expect(readFileSync(file, "utf8")).toBe("x");
  });

  it("journals beside the store, oldest first", () => {
    const file = path.join(scratch(), "rules.json");
    expect(journalPathOf(file)).toBe(path.join(path.dirname(file), "rules.journal.jsonl"));
    appendJournal(journalPathOf(file), { op: "add", id: "a" }, "2031-01-02T00:00:00.000Z");
    appendJournal(journalPathOf(file), { op: "remove", id: "a" }, "2031-01-03T00:00:00.000Z");
    const lines = readFileSync(journalPathOf(file), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { at: string; op: string });
    expect(lines.map((l) => l.op)).toEqual(["add", "remove"]);
    expect(lines[0]!.at).toBe("2031-01-02T00:00:00.000Z");
  });

  it("reads a missing store as empty, and a damaged one as an error", () => {
    const file = path.join(scratch(), "store.json");
    expect(readJsonStore(file, () => ({ version: 1, rows: [] }))).toEqual({ version: 1, rows: [] });
    writeTextAtomic(file, "{ not json");
    expect(() => readJsonStore(file, () => ({}), { journal: journalPathOf(file) })).toThrow(/damaged.*store\.journal\.jsonl/);
  });
});
