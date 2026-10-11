import { describe, expect, it } from "vitest";
import { parseIsoDate } from "./parseIsoDate";

describe("parseIsoDate", () => {
  it("parses a date to noon UTC on that calendar day", () => {
    const d = parseIsoDate("2026-03-05");
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(2);
    expect(d.getUTCDate()).toBe(5);
    expect(d.getUTCHours()).toBe(12);
  });

  it("rejects a malformed date", () => {
    expect(() => parseIsoDate("03/05/2026")).toThrow();
  });
});
