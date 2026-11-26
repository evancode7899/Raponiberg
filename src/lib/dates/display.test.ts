import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dateLabel, dayLabel, monthLabel, monthName, rangeLabel, weekdayLabel } from "./display";

describe("the one date format", () => {
  it("writes days, months and ranges the same way everywhere", () => {
    expect(dateLabel("2031-06-30")).toBe("Jun 30, 2031");
    expect(dateLabel("2031-06-03T12:00:00.000Z")).toBe("Jun 3, 2031");
    expect(dayLabel("2031-01-09")).toBe("Jan 9");
    expect(monthLabel("2031-06")).toBe("Jun 2031");
    expect(monthLabel("2031-12-31")).toBe("Dec 2031");
    expect(monthName(2)).toBe("Feb");
    expect(monthName("2031-11")).toBe("Nov");
    expect(weekdayLabel("2031-06-30")).toBe("Mon, Jun 30, 2031");
    expect(rangeLabel("2031-06-01", "2031-06-30")).toBe("Jun 1 – Jun 30, 2031");
    expect(rangeLabel("2030-12-01", "2031-01-31")).toBe("Dec 1, 2030 – Jan 31, 2031");
  });

  it("never moves a day by time zone, and passes words through", () => {
    // A Date read from "2031-01-01" is midnight UTC: the evening before in New York.
    expect(dateLabel("2031-01-01")).toBe("Jan 1, 2031");
    expect(dateLabel("n.a.")).toBe("n.a.");
    expect(dateLabel(null)).toBe("");
  });
});

/** Files allowed their own date formatting: the module itself, and parsers reading what a statement prints. */
const ALLOWED = [/src[\\/]lib[\\/]dates[\\/]display\.ts$/, /src[\\/]lib[\\/]displayTime\.ts$/, /src[\\/]lib[\\/]ingest[\\/]/, /\.test\.tsx?$/];
/** Pages that still format on their own; each moves to lib/dates/display as its page is next changed. The list may only shrink. */
const NOT_YET = new Set<string>(["src/app/dashboard/panels.tsx", "src/lib/car/report.ts"]);

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* sources(p);
    else if (/\.tsx?$/.test(name)) yield p;
  }
}

describe("no page formats a date on its own", () => {
  it("dates are written through lib/dates/display", () => {
    const own: string[] = [];
    for (const f of sources("src")) {
      if (ALLOWED.some((r) => r.test(f))) continue;
      if (/toLocaleDateString|Intl\.DateTimeFormat|toLocaleString\("en-US", \{ month/.test(readFileSync(f, "utf8"))) own.push(f.replace(/\\/g, "/"));
    }
    expect(own.filter((f) => !NOT_YET.has(f))).toEqual([]);
  });
});
