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

  it("keeps text a spreadsheet would run as a formula from running", () => {
    expect(csvCell("=HYPERLINK(A1)")).toBe("'=HYPERLINK(A1)");
    expect(csvCell("+1 store")).toBe("'+1 store");
    expect(csvCell("-cmd|x")).toBe("'-cmd|x");
    expect(csvCell("@SUM(A1:A2)")).toBe("'@SUM(A1:A2)");
    expect(csvCell('=A1,"x"')).toBe('"\'=A1,""x"""');
  });

  it("leaves numbers alone, negative ones too", () => {
    expect(csvCell("-12.34")).toBe("-12.34");
    expect(csvCell("+5")).toBe("+5");
    expect(csvCell(-12.34)).toBe("-12.34");
    expect(csvCell("2026-01-15")).toBe("2026-01-15");
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
