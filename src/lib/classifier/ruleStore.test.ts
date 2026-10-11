import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readRules, saveRules } from "./ruleStore";

const tempFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), "merchant-rules-")), "merchant-rules.json");
const journal = (file: string) => readFileSync(file.replace(/\.json$/, ".journal.jsonl"), "utf8").trim().split("\n");

describe("merchant rules file", () => {
  it("keeps one rule per merchant, the latest answer winning, and skips unchanged saves", () => {
    const file = tempFile();
    expect(saveRules([{ merchantKey: "ZQ BISTRO", category: "Dining", lane: null, source: "LLM_PROMOTED", note: "a bistro" }], file)).toBe(1);
    expect(saveRules([{ merchantKey: "ZQ BISTRO", category: "Dining", lane: null, source: "LLM_PROMOTED" }], file)).toBe(0);
    expect(journal(file)).toHaveLength(1);

    saveRules([{ merchantKey: "ZQ BISTRO", category: "Groceries", lane: null, source: "USER", note: null }], file);
    const { rules } = readRules(file);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ merchantKey: "ZQ BISTRO", category: "Groceries", source: "USER" });
    expect(journal(file)).toHaveLength(2);
  });

  it("treats a missing file as no rules, and refuses a damaged or newer one", () => {
    const file = tempFile();
    expect(readRules(file).rules).toEqual([]);
    writeFileSync(file, "{ nope");
    expect(() => readRules(file)).toThrow(/damaged/);
    writeFileSync(file, JSON.stringify({ version: 2, rules: [] }));
    expect(() => readRules(file)).toThrow(/newer version/);
  });
});
