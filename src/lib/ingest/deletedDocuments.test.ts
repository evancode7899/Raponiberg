import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isPdfFile, storedFileOf } from "./deletedDocuments";

const app = mkdtempSync(path.join(os.tmpdir(), "pf-deleted-test-"));
const data = path.join(app, "data");
mkdirSync(path.join(data, "statements"), { recursive: true });
writeFileSync(path.join(data, "statements", "abc123.pdf"), "%PDF-1 made up");
writeFileSync(path.join(app, "outside.pdf"), "%PDF-1 made up");
afterAll(() => rmSync(app, { recursive: true, force: true }));

describe("a deleted document's stored file", () => {
  it("is found where the deletion says, relative to the app folder", () => {
    expect(storedFileOf("data/statements/abc123.pdf", data, app)).toBe(path.join(data, "statements", "abc123.pdf"));
  });

  it("is never one outside the data folder, whatever the log says", () => {
    expect(storedFileOf("outside.pdf", data, app)).toBeNull();
    expect(storedFileOf("data/../outside.pdf", data, app)).toBeNull();
    expect(storedFileOf(path.join(app, "outside.pdf"), data, app)).toBeNull();
    expect(storedFileOf("data", data, app)).toBeNull();
  });

  it("is none when the file is gone or the log names none", () => {
    expect(storedFileOf("data/statements/gone.pdf", data, app)).toBeNull();
    expect(storedFileOf(undefined, data, app)).toBeNull();
    expect(storedFileOf(42, data, app)).toBeNull();
  });
});

describe("which deleted documents can be read again", () => {
  it("only those whose stored file is a PDF", () => {
    writeFileSync(path.join(data, "statements", "seeded.pdf"), "made up rows, no PDF");
    expect(isPdfFile(path.join(data, "statements", "abc123.pdf"))).toBe(true);
    expect(isPdfFile(path.join(data, "statements", "seeded.pdf"))).toBe(false);
  });
});
