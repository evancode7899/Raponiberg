import { describe, expect, it } from "vitest";
import { csvCell, csvRow } from "./csv";

describe("csvCell", () => {
  it("leaves simple text unchanged", () => {
    expect(csvCell("hello")).toBe("hello");
    expect(csvCell(42)).toBe("42");
  });

  it("quotes and escapes double quotes", () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes fields with commas or newlines", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("treats null and undefined as empty", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
});

describe("csvRow", () => {
  it("joins cells with commas", () => {
    expect(csvRow(["a", "b", "c"])).toBe("a,b,c");
  });

  it("matches RFC4180-style escaping for mixed cells", () => {
    expect(csvRow(["plain", 'with,comma', 'with"quote'])).toBe(
      'plain,"with,comma","with""quote"',
    );
  });
});
