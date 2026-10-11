import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addException, readExceptions, retireException } from "./exceptionStore";
import type { StandingException } from "./types";

const entry = (id: string): StandingException => ({
  id,
  check: "statement.gap",
  accounts: ["CARD CO#9999"],
  note: "Card was idle",
  acceptedAt: "2025-06-01T00:00:00.000Z",
  finding: { status: "MISSING", title: "No statement", detail: "…", scope: { from: "2025-02-01", to: "2025-04-30", affects: ["NET_WORTH"] } },
});

const tempFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), "exceptions-")), "integrity-exceptions.json");

describe("permanent exceptions file", () => {
  it("starts empty, adds, and refuses the same finding twice", () => {
    const file = tempFile();
    expect(readExceptions(file)).toEqual({ version: 1, exceptions: [], retired: [] });
    addException(entry("a"), file);
    expect(readExceptions(file).exceptions.map((e) => e.id)).toEqual(["a"]);
    expect(() => addException(entry("a"), file)).toThrow(/already/);
  });

  it("refuses a file written by a newer app instead of misreading it", () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ version: 2, exceptions: [], retired: [], more: [] }));
    expect(() => readExceptions(file)).toThrow(/newer version/);
  });

  it("retires only with a reason, and keeps the retired entry", () => {
    const file = tempFile();
    addException(entry("a"), file);
    expect(() => retireException("a", "  ", file)).toThrow(/reason/);
    retireException("a", "Statement now on file", file);
    const data = readExceptions(file);
    expect(data.exceptions).toEqual([]);
    expect(data.retired.map((e) => [e.id, e.reason])).toEqual([["a", "Statement now on file"]]);
  });

  it("journals every change beside the file", () => {
    const file = tempFile();
    addException(entry("a"), file);
    retireException("a", "Redundant", file);
    const journal = readFileSync(file.replace(/\.json$/, ".journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { op: string });
    expect(journal.map((j) => j.op)).toEqual(["add", "retire"]);
  });

  it("treats a damaged file as an error, never as an empty list", () => {
    const file = tempFile();
    writeFileSync(file, "{ not json");
    expect(() => readExceptions(file)).toThrow(/damaged/);
    expect(() => addException(entry("b"), file)).toThrow(/damaged/);
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("only the owner's approval endpoint retires exceptions, and only the store touches the file", () => {
    const root = path.resolve(__dirname, "../../..");
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = path.join(dir, f);
        return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|mjs)$/.test(f) && !/\.test\.ts$/.test(f) ? [p] : [];
      });
    const all = [...files(path.join(root, "src")), ...(existsSync(path.join(root, "scripts")) ? files(path.join(root, "scripts")) : [])].map((p) =>
      path.relative(root, p).split(path.sep).join("/"),
    );
    const using = (re: RegExp) => all.filter((rel) => re.test(readFileSync(path.join(root, rel), "utf8")));
    expect(using(/\bretireException\(/)).toEqual(["src/app/api/integrity/route.ts", "src/lib/book/exceptionStore.ts"]);
    expect(using(/integrity-exceptions/)).toEqual(["src/lib/book/exceptionStore.ts"]);
  });
});
