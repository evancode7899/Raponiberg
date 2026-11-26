import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APP_FILES } from "./appFiles";
import { buildCommandIndex } from "./commandIndex";
import { addPin, isAppHref, readPins, removePin, toPin } from "./pins";

const dirs: string[] = [];
const file = () => {
  const d = mkdtempSync(path.join(tmpdir(), "pf-pins-"));
  dirs.push(d);
  return path.join(d, "pins.json");
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("saved views and pins", () => {
  it("keeps views and figures by name, replacing one of the same name, with a journal", () => {
    const f = file();
    const now = new Date("2031-05-01T12:00:00Z");
    addPin(toPin({ kind: "view", name: "Dining  2030", href: "/cash-flow?tab=trends" }, now), f);
    addPin(toPin({ kind: "figure", name: "Net worth", descriptor: { report: "net-worth", metric: "total" } }, now), f);
    addPin(toPin({ kind: "view", name: "dining 2030", href: "/cash-flow?tab=yoy" }, now), f);
    expect(readPins(f)).toEqual([
      { kind: "figure", name: "Net worth", descriptor: { report: "net-worth", metric: "total" }, at: now.toISOString() },
      { kind: "view", name: "dining 2030", href: "/cash-flow?tab=yoy", at: now.toISOString() },
    ]);
    expect(removePin("view", "DINING 2030", f)).toHaveLength(1);
    expect(readFileSync(f.replace(/\.json$/, ".journal.jsonl"), "utf8").trim().split("\n")).toHaveLength(4);
  });

  it("refuses what isn't a page of the app or a proof's recipe", () => {
    expect(() => toPin({ kind: "view", name: "x", href: "https://example.com/" })).toThrow(/page of this app/);
    expect(() => toPin({ kind: "view", name: "x", href: "//example.com" })).toThrow();
    expect(() => toPin({ kind: "view", name: "", href: "/" })).toThrow(/name/);
    expect(() => toPin({ kind: "figure", name: "x", descriptor: { metric: 1 } })).toThrow(/recipe/);
    expect(isAppHref("/statements?tab=transactions&q=coffee%20shop")).toBe(true);
    expect(isAppHref("javascript:alert(1)")).toBe(false);
  });

  it("reads no file as none, and a damaged one as an error", () => {
    const f = file();
    expect(readPins(f)).toEqual([]);
    writeFileSync(f, "{");
    expect(() => readPins(f)).toThrow(/damaged/);
    expect(existsSync(f)).toBe(true);
  });

  it("is one of the app's own files, outside the Book's stamp", () => {
    expect(APP_FILES.has("pins.json")).toBe(true);
  });
});

describe("the command line's index", () => {
  it("lists accounts (archived last) and merchants by rows, named as their rows print most", () => {
    const row = (merchantKey: string | null, payee: string, lane = "EXPENSE") => ({ merchantKey, payee, lane }) as never;
    const idx = buildCommandIndex({
      accounts: [
        { id: "b", name: "Old Card", institution: null, archived: true },
        { id: "a", name: "Example Checking", institution: "Springfield Bank" },
      ] as never,
      rows: [row("GROCER", "Springfield Grocer #1"), row("GROCER", "Springfield Grocer #2"), row("GROCER", "Springfield Grocer #2"), row("PHARM", "Example Pharmacy"), row(null, "Cash"), row("XFER", "Transfer", "TRANSFER")],
    });
    expect(idx.accounts.map((a) => a.id)).toEqual(["a", "b"]);
    expect(idx.merchants).toEqual([
      { key: "GROCER", name: "Springfield Grocer #2", rows: 3 },
      { key: "PHARM", name: "Example Pharmacy", rows: 1 },
    ]);
  });
});
