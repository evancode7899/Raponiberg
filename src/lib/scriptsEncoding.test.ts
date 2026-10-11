import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Windows PowerShell 5.1 reads BOM-less scripts as ANSI, where the UTF-8 bytes of a
 * character like "—" include a curly quote that PowerShell treats as a string delimiter
 * — silently swallowing the code after it. The desktop launcher once skipped its
 * install/migrate steps that way, so launcher scripts must stay plain ASCII.
 */
describe("Windows launcher scripts", () => {
  const dir = path.join(__dirname, "..", "..", "scripts");
  const files = readdirSync(dir).filter((f) => /\.(ps1|vbs|bat)$/i.test(f));
  it.each(files)("%s is plain ASCII", (f) => {
    const bad = readFileSync(path.join(dir, f), "utf8")
      .split(/\r?\n/)
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter((l) => /[^\x00-\x7F]/.test(l.text));
    expect(bad).toEqual([]);
  });
});
