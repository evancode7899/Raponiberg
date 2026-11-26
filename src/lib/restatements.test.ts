import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { atMonthEnd, movedSince, readRestatements, recordSweep, rollForward, type Restatements } from "./restatements";
import { periodOf } from "./restatementWhy";

/** Made-up figure keys, as descriptorKey writes them. */
const DINING = '{"category":"Dining","report":"cash-flow","start":"2031-03-01"}';
const NW = '{"asOf":"2031-03-31","report":"net-worth"}';
const NEW = '{"asOf":"2031-04-30","report":"net-worth"}';

const EMPTY: Restatements = { version: 1, current: null, monthEnd: null };
const dir = mkdtempSync(path.join(os.tmpdir(), "pf-restate-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the restatement log", () => {
  it("replaces the month's record through the month, and closes it into the month-end when a new month's sweep lands", () => {
    let r = rollForward(EMPTY, { today: "2031-03-20", cleared: { [DINING]: { cents: 100 } } }, "t1");
    r = rollForward(r, { today: "2031-03-31", cleared: { [DINING]: { cents: 150 } } }, "t2");
    expect(r.monthEnd).toBeNull();
    r = rollForward(r, { today: "2031-04-02", cleared: { [DINING]: { cents: 175 } } }, "t3");
    expect(r.monthEnd).toMatchObject({ month: "2031-03", takenAt: "t2" });
    expect(r.current).toMatchObject({ month: "2031-04", takenAt: "t3" });
    // Later sweeps in April never touch March's record.
    r = rollForward(r, { today: "2031-04-25", cleared: { [DINING]: { cents: 999 } } }, "t4");
    expect(r.monthEnd).toMatchObject({ month: "2031-03", takenAt: "t2" });
    expect(Object.values(r.monthEnd!.values)).toEqual([{ cents: 150 }]);
  });

  it("keeps keys short in the file", () => {
    const r = rollForward(EMPTY, { today: "2031-03-20", cleared: { [DINING]: { cents: 100 } } }, "t1");
    expect(Object.keys(r.current!.values)[0]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("says what a figure was at the month-end and whether it moved, and lists the moves largest first", () => {
    const file = path.join(dir, "restatements.json");
    recordSweep(JSON.stringify({ today: "2031-03-31", cleared: { [DINING]: { cents: 15_000 }, [NW]: { cents: 1_000_000 } } }), file);
    expect(atMonthEnd(DINING, { cents: 1 }, file)).toBeNull();
    recordSweep(JSON.stringify({ today: "2031-04-03", cleared: { [DINING]: { cents: 15_500 }, [NW]: { cents: 900_000 }, [NEW]: { cents: 5 } } }), file);
    expect(readRestatements(file).monthEnd?.month).toBe("2031-03");
    expect(atMonthEnd(DINING, { cents: 15_000 }, file)).toMatchObject({ month: "2031-03", was: { cents: 15_000 }, moved: false });
    expect(atMonthEnd(DINING, { cents: 15_500 }, file)).toMatchObject({ moved: true });
    expect(atMonthEnd(NEW, { cents: 5 }, file)).toMatchObject({ was: null, moved: true });
    const m = movedSince({ [DINING]: { cents: 15_500 }, [NW]: { cents: 900_000 }, [NEW]: { cents: 5 } }, file)!;
    expect(m.compared).toBe(2);
    expect(m.moved.map((x) => x.key)).toEqual([NW, DINING]);
  });

  it("reads the dates a figure's recipe names", () => {
    expect(periodOf({ start: "2031-03-01", end: "2031-03-31" })).toEqual({ start: "2031-03-01", end: "2031-03-31" });
    expect(periodOf({ asOf: "2031-03-31" })).toEqual({ start: "0000-01-01", end: "2031-03-31" });
    expect(periodOf({ report: "forecast" })).toBeNull();
  });
});
