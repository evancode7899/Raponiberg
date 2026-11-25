import { describe, expect, it } from "vitest";
import { icsFile } from "./ics";

const now = new Date("2026-07-15T12:34:56.789Z");
const unfold = (s: string) => s.replace(/\r\n /g, "");

describe("the calendar file", () => {
  it("writes each date as one all-day event with its reminders", () => {
    const s = icsFile([{ id: "2026-q3-federal", date: "2026-12-31", title: "Federal Q3 estimated tax", description: "Pay it" }], now);
    expect(s).toContain("DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101\r\n");
    expect(s).toContain("DTSTAMP:20260715T123456Z");
    expect(s).toContain("UID:2026-q3-federal@raponiberg.local");
    expect(s.match(/TRIGGER:-P(14|3)D/g)).toHaveLength(2);
    expect(s.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(s.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("escapes what the format reserves", () => {
    const s = unfold(icsFile([{ id: "x", date: "2026-01-02", title: "A, b; c\\d", description: "one\ntwo" }], now, []));
    expect(s).toContain("SUMMARY:A\\, b\\; c\\\\d");
    expect(s).toContain("DESCRIPTION:one\\ntwo");
  });

  it("folds long lines at 75 bytes without losing or splitting a character", () => {
    const title = "Pay the estimated tax — ".repeat(12);
    const s = icsFile([{ id: "x", date: "2026-01-02", title }], now, []);
    for (const line of s.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(unfold(s)).toContain(`SUMMARY:${title}`);
  });
});
