import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPageInputKey, readPageInputs, writePageInputs } from "./pageInputs";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pf-page-inputs-"));
  file = path.join(dir, "page-inputs.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("page inputs", () => {
  it("saves and reads each page's inputs separately", () => {
    expect(readPageInputs("pf-mortgage-v2", file)).toBeNull();
    writePageInputs("pf-mortgage-v2", { principal: 500_000 }, file);
    writePageInputs("pf-home-budget-inputs", { budgetHomePrice: 900_000 }, file);
    expect(readPageInputs("pf-mortgage-v2", file)).toEqual({ principal: 500_000 });
    expect(readPageInputs("pf-home-budget-inputs", file)).toEqual({ budgetHomePrice: 900_000 });
  });

  it("rejects anything but an object, and unknown keys", () => {
    expect(() => writePageInputs("pf-mortgage-v2", [1], file)).toThrow();
    expect(() => writePageInputs("pf-mortgage-v2", null, file)).toThrow();
    expect(isPageInputKey("pf-api-secret")).toBe(false);
  });

  it("reads a damaged file as no inputs", () => {
    writeFileSync(file, "{not json");
    expect(readPageInputs("pf-mortgage-v2", file)).toBeNull();
  });
});
