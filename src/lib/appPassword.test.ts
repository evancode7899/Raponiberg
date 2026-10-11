import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkAppPassword, DEFAULT_APP_PASSWORD, isDefaultAppPassword, readAppPassword, writeAppPassword } from "./appPassword";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pf-app-password-"));
  file = path.join(dir, "app-password.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("app password", () => {
  it("is 'password' until one is saved", () => {
    expect(DEFAULT_APP_PASSWORD).toBe("password");
    expect(readAppPassword(file)).toBe("password");
    expect(isDefaultAppPassword(file)).toBe(true);
    expect(checkAppPassword("password", file)).toBe(true);
  });

  it("checks against the saved password", () => {
    writeAppPassword("hunter2", file);
    expect(checkAppPassword("hunter2", file)).toBe(true);
    expect(checkAppPassword("password", file)).toBe(false);
    expect(checkAppPassword(undefined, file)).toBe(false);
    expect(isDefaultAppPassword(file)).toBe(false);
  });

  it("rejects a blank password", () => {
    expect(() => writeAppPassword("", file)).toThrow();
    expect(() => writeAppPassword(null, file)).toThrow();
  });

  it("falls back to the default when the file is damaged", () => {
    writeFileSync(file, "{not json");
    expect(readAppPassword(file)).toBe("password");
  });
});
