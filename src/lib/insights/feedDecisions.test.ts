import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addMark, readMarks, removeMark } from "../markStore";
import { holds } from "../marks";
import { buildFeed, type FeedInputs } from "./feed";
import { visibleFeed } from "./feedVisible";
import type { NetWorthReport } from "../book/reports/netWorth";
import type { SpendingReport } from "../book/reports/spending";
import type { CalendarItem } from "../book/reports/moneyCalendar";

const file = () => path.join(mkdtempSync(path.join(tmpdir(), "marks-")), "feed-decisions.json");

describe("the marks file", () => {
  it("starts empty, keeps one mark per thing, and takes a mark off", () => {
    const f = file();
    expect(readMarks(f)).toEqual([]);
    addMark(f, { id: "a", says: "one" });
    addMark(f, { id: "b", says: "two", until: "2026-08-01" });
    addMark(f, { id: "a", says: "one again" });
    expect(readMarks(f).map((m) => [m.id, m.says, m.until])).toEqual([
      ["b", "two", "2026-08-01"],
      ["a", "one again", null],
    ]);
    expect(removeMark(f, "a").map((m) => m.id)).toEqual(["b"]);
    // Every change is in the journal beside it.
    expect(readFileSync(f.replace(/\.json$/, ".journal.jsonl"), "utf8").trim().split("\n")).toHaveLength(4);
  });

  it("refuses a damaged file instead of reading it as none, and a bad day", () => {
    const f = file();
    writeFileSync(f, "{");
    expect(() => readMarks(f)).toThrow(/damaged/);
    writeFileSync(f, "{}");
    expect(() => readMarks(f)).toThrow(/no list/);
    expect(() => addMark(file(), { id: "a", says: "x", until: "next week" })).toThrow(/YYYY-MM-DD/);
  });

  it("holds while the thing says the same and its day hasn't come", () => {
    const m = { id: "a", says: "Rent went up $50", at: "", until: null };
    expect(holds(m, "Rent went up $50", "2026-07-15")).toBe(true);
    expect(holds(m, "Rent went up $75", "2026-07-15")).toBe(false);
    expect(holds(undefined, "x", "2026-07-15")).toBe(false);
    const later = { ...m, until: "2026-07-22" };
    expect([holds(later, m.says, "2026-07-21"), holds(later, m.says, "2026-07-22")]).toEqual([true, false]);
  });
});

describe("the feed as the owner left it", () => {
  const item = (over: Partial<CalendarItem>): CalendarItem => ({ id: "x", date: "2026-07-20", year: 2026, kind: "tax", title: "Example payment", detail: "", cents: 500_000, proof: null, href: "/calendar", done: false, ...over });
  const nw = { periods: [] } as unknown as NetWorthReport;
  const inputs = (calendar: CalendarItem[], today = "2026-07-15"): FeedInputs => ({ today, spending: { months: [], recurring: [], oneOffs: [] } as unknown as SpendingReport, netWorth: nw, change: null, calendar, goals: [] });

  it("says a deadline the same way as it draws nearer, and differently once its amount moves", () => {
    const [a] = buildFeed(inputs([item({})]));
    const [b] = buildFeed(inputs([item({})], "2026-07-18"));
    const [c] = buildFeed(inputs([item({ cents: 600_000 })], "2026-07-18"));
    expect(a!.says).toBe(b!.says);
    expect(c!.says).not.toBe(a!.says);
  });

  it("hides what's dismissed, fills the list from below, and brings it back when it changes", () => {
    const feed = buildFeed(inputs(Array.from({ length: 5 }, (_, i) => item({ id: `d${i}`, date: `2026-07-${20 + i}` }))), 40);
    const marks = [{ id: feed[0]!.id, says: feed[0]!.says, at: "", until: null }];
    const v = visibleFeed(feed, marks, "2026-07-15", 3);
    expect(v.shown.map((f) => f.id)).toEqual(["due:d1", "due:d2", "due:d3"]);
    expect(v.hidden.map((f) => f.id)).toEqual(["due:d0"]);
    const changed = feed.map((f, i) => (i === 0 ? { ...f, says: `${f.says}!` } : f));
    expect(visibleFeed(changed, marks, "2026-07-15", 3).shown[0]!.id).toBe("due:d0");
  });

  it("brings a reminder back on its day", () => {
    const feed = buildFeed(inputs([item({ id: "a" })]));
    const marks = [{ id: feed[0]!.id, says: feed[0]!.says, at: "", until: "2026-07-18" }];
    expect(visibleFeed(feed, marks, "2026-07-17").shown).toEqual([]);
    expect(visibleFeed(feed, marks, "2026-07-18").shown).toHaveLength(1);
    expect(visibleFeed([], marks, "2026-07-18")).toEqual({ shown: [], hidden: [] });
  });
});
