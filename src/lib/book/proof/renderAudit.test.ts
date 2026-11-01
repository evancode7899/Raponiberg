import { describe, expect, it } from "vitest";
import { descriptorKey } from "./key";
import { auditRender as audit, drawerStrays, figureFamily, readDrawn, textMatches, type DrawnFigure, type DrawnView } from "./renderAudit";

const fig = (over: Partial<DrawnFigure> = {}): DrawnFigure => ({ key: "k1", shown: "4125.50", shownKind: "cents", perMonths: null, clearance: "cleared", text: "$4,126", ...over });
const view = (over: Partial<DrawnView> = {}): DrawnView => ({ view: "/example", figures: [fig()], strays: [], errors: [], ...over });
const sweep = { cleared: { k1: { cents: 4125_50 } }, problems: {} };
/** The audit as these tests knew it before F6d: whatever a test leaves undrawn counts as pending (the gate has its own test below). */
const auditRender: typeof audit = (views, s, pending, opts = {}) => {
  const drawn = new Set(views.flatMap((v) => v.figures.map((f) => f.key)));
  const undrawn = Object.fromEntries(Object.keys(s.cleared).filter((k) => !drawn.has(k)).map((k) => [figureFamily(k), "test"]));
  return audit(views, s, pending, { undrawnPending: undrawn, ...opts });
};

describe("readDrawn: a drawn number read back, with how far the drawing rounds it", () => {
  it("reads whole dollars, cents, compact and accounting negatives", () => {
    expect(readDrawn("$4,126")).toMatchObject({ value: 4126, tol: 0.5, unit: "usd" });
    expect(readDrawn("$5,056.10")).toMatchObject({ value: 5056.1, unit: "usd" });
    expect(readDrawn("$916.7k")).toMatchObject({ value: 916_700, tol: 50 });
    expect(readDrawn("$1.24M")).toMatchObject({ value: 1_240_000, tol: 5000 });
    expect(readDrawn("($1,235)")?.value).toBe(-1235);
    expect(readDrawn("−$4.1k")?.value).toBe(-4100);
    expect(readDrawn("+$12.3k")?.value).toBe(12_300);
  });

  it("reads rates as ratios, and a lone dash as zero", () => {
    expect(readDrawn("6.5%")).toMatchObject({ value: 0.065, unit: "pct" });
    expect(readDrawn("(6.5%)")?.value).toBe(-0.065);
    expect(readDrawn("—")).toMatchObject({ value: 0, tol: 0 });
  });

  it("refuses text with no number or with two", () => {
    expect(readDrawn("Up to date")).toBeNull();
    expect(readDrawn("$1,200 of $3,400")).toBeNull();
  });
});

describe("textMatches: the visible text is the value the figure says it shows", () => {
  it("accepts the shown value rounded the way it's drawn", () => {
    expect(textMatches(fig()).ok).toBe(true);
    expect(textMatches(fig({ text: "$4.1k" })).ok).toBe(true);
    expect(textMatches(fig({ shown: "0.065", shownKind: "ratio", text: "6.5%" })).ok).toBe(true);
  });

  it("divides by the months a page spreads the total over", () => {
    expect(textMatches(fig({ shown: "1200.00", perMonths: 12, text: "$100" })).ok).toBe(true);
    expect(textMatches(fig({ shown: "1200.00", perMonths: 12, text: "$1,200" })).ok).toBe(false);
  });

  it("catches a page that proves one number and draws another", () => {
    expect(textMatches(fig({ text: "$4,200" }))).toMatchObject({ ok: false });
    expect(textMatches(fig({ text: "—" }))).toMatchObject({ ok: false });
    expect(textMatches(fig({ text: "soon" }))).toMatchObject({ ok: false });
  });
});

describe("auditRender: what the pages drew, held to the sweep", () => {
  it("passes a page that draws the cleared figure at its value", () => {
    expect(auditRender([view()], sweep)).toMatchObject({ problems: [], drawn: 1, cleared: 1, missing: [] });
  });

  it("flags a figure drawn as cleared the sweep never cleared, or cleared at another value", () => {
    expect(auditRender([view()], { cleared: {}, problems: {} }).problems).toMatchObject([{ kind: "RENDER_NOT_CLEARED" }]);
    expect(auditRender([view({ figures: [fig({ shown: "99.00", text: "$99" })] })], sweep).problems).toMatchObject([{ kind: "RENDER_NOT_CLEARED" }]);
  });

  it("flags drawn text that isn't the shown value", () => {
    expect(auditRender([view({ figures: [fig({ text: "$9,999" })] })], sweep).problems).toMatchObject([{ kind: "RENDER_TEXT" }]);
  });

  it("flags money drawn outside any figure, and bug-withheld or verifying figures; not blocked ones", () => {
    expect(auditRender([view({ strays: ['$1,234" in "Total $1,234'] })], sweep, {}).problems).toMatchObject([{ kind: "RENDER_BYPASS" }]);
    const withheld = (clearance: string) => auditRender([view({ figures: [fig(), fig({ key: "k2", clearance })] })], sweep).problems;
    expect(withheld("withheld:mismatch")).toMatchObject([{ kind: "RENDER_WITHHELD" }]);
    expect(withheld("verifying")).toMatchObject([{ kind: "RENDER_WITHHELD" }]);
    expect(withheld("withheld:blocked")).toEqual([]);
    expect(withheld("withheld:no-figure")).toEqual([]);
  });

  it("lists cleared figures no page drew", () => {
    expect(auditRender([view({ figures: [] })], sweep).missing).toEqual(["k1"]);
  });

  it("fails a cleared figure no page drew, unless its family is still pending; and a pending family drawn in full", () => {
    const d = JSON.stringify({ report: "derived", page: "example", figure: "cell", key: "a" });
    const s = { cleared: { [d]: { cents: 100 } }, problems: {} };
    expect(figureFamily(d)).toBe("derived › example › cell");
    expect(auditRender([view({ figures: [] })], s, {}, { undrawnPending: {} }).problems).toMatchObject([{ kind: "RENDER_UNDRAWN", view: "derived › example › cell" }]);
    expect(auditRender([view({ figures: [] })], s, {}, { undrawnPending: { "derived › example › cell": "F6x" } }).problems).toEqual([]);
    const drawnAll = view({ figures: [fig({ key: d, shown: "1.00", text: "$1" })] });
    expect(auditRender([drawnAll], s, {}, { undrawnPending: { "derived › example › cell": "F6x" } }).problems).toMatchObject([{ kind: "RENDER_UNDRAWN", detail: expect.stringContaining("take it off UNDRAWN_PENDING") }]);
  });
});

describe("drawn: a figure drawn in other units, rounded, or as words", () => {
  it("reads $k, cents-per-mile and a rounded price back to the shown value", () => {
    expect(textMatches(fig({ shown: "709999.92", text: "710", drawn: "per:1000;step:0" })).ok).toBe(true);
    expect(textMatches(fig({ shown: "709999.92", text: "720", drawn: "per:1000;step:0" })).ok).toBe(false);
    expect(textMatches(fig({ shown: "46.59", shownKind: "ratio", text: "$0.47", drawn: "per:100;step:0" })).ok).toBe(true);
    expect(textMatches(fig({ shown: "5832785.69", text: "$5,832,000", drawn: "per:1;step:1000" })).ok).toBe(true);
    expect(textMatches(fig({ shown: "5832785.69", text: "$5,830,000", drawn: "per:1;step:1000" })).ok).toBe(false);
  });

  it("lets words open a proof, but a number inside them is drawn with no proof", () => {
    expect(textMatches(fig({ text: "On a letter", drawn: "words" })).ok).toBe(true);
    const words = auditRender([view({ figures: [fig({ text: "You kept 66% of income", drawn: "words" })] })], sweep, {});
    expect(words.problems).toMatchObject([{ kind: "RENDER_BYPASS" }]);
  });
});

describe("BYPASS_PENDING: a page's stray money waits for its stage, and the list only shrinks", () => {
  const strays = view({ strays: ['$1,234" in "Total $1,234'] });
  it("lists a pending page's bypasses without failing on them", () => {
    expect(auditRender([strays], sweep, { "/example": "F6b" })).toMatchObject({ problems: [], pending: [{ kind: "RENDER_BYPASS" }] });
  });

  it("fails a pending page that draws nothing outside its figures any more", () => {
    expect(auditRender([view()], sweep, { "/example": "F6b" }).problems).toMatchObject([{ kind: "RENDER_BYPASS", view: "/example" }]);
  });

  it("never excuses a mismatch on a pending page", () => {
    expect(auditRender([view({ strays: ["x"], figures: [fig({ text: "$9,999" })] })], sweep, { "/example": "F6b" }).problems).toMatchObject([{ kind: "RENDER_TEXT" }]);
  });
});

describe("drawerStrays: every number a proof drawer draws is one its proof holds", () => {
  const proof = { figure: { cents: 4125_50 }, selfCheck: { explain: "The 3 rows below add up to $4,125.50" }, blocks: [{ kind: "chain", lines: [{ value: { ratio: 0.065 } }, { value: { cents: -1200_00 } }] }] };
  it("passes cents drawn as dollars, ratios as rates, per-month splits and the proof's own words", () => {
    expect(drawerStrays(["$4,126", "$4,125.50", "6.5%", "($1,200)", "−$1.2k"], proof)).toEqual([]);
    expect(drawerStrays(["$344"], proof, 12)).toEqual([]);
  });
  it("flags a number the drawer worked out by itself", () => {
    expect(drawerStrays(["$4,200", "9%"], proof)).toEqual(["$4,200", "9%"]);
  });
});

describe("a figure that states no value is held to the one the sweep cleared", () => {
  it("passes text that is the cleared value, and catches text that isn't", () => {
    const quiet = (text: string) => view({ figures: [fig({ shown: "", shownKind: "", text })] });
    expect(auditRender([quiet("$4,126")], sweep, {}).problems).toEqual([]);
    expect(auditRender([quiet("$5,000")], sweep, {}).problems).toMatchObject([{ kind: "RENDER_TEXT" }]);
  });
  it("finds the page of a driven view", () => {
    expect(auditRender([view({ view: "/example · Year=2025 ▸ Dining", strays: ["x"] })], sweep, { "/example": "F6b" }).problems).toEqual([]);
  });
});

describe("words that stand for zero", () => {
  it("passes About even within the declared distance of zero, and nothing further", () => {
    expect(textMatches(fig({ shown: "0.40", text: "About even", drawn: "per:1;step:0;zero:1" })).ok).toBe(true);
    expect(textMatches(fig({ shown: "250.00", text: "About even", drawn: "per:1;step:0;zero:1" })).ok).toBe(false);
    expect(textMatches(fig({ shown: "0.40", text: "—" })).ok).toBe(true);
  });
});

describe("composite figures: arithmetic over figures the sweep proved", () => {
  const a = { report: "row", rowId: "a" } as const;
  const b = { report: "row", rowId: "b" } as const;
  const key = descriptorKey({ report: "composite", op: "share", of: [a, b] });
  const parts = { cleared: { [descriptorKey(a)]: { cents: 250_00 }, [descriptorKey(b)]: { cents: 1000_00 } }, problems: {} };
  it("clears in the audit at the share its parts work out to, held to the text drawn", () => {
    const share = (text: string, shown = "0.25") => view({ figures: [fig({ key, shown, shownKind: "ratio", text })] });
    expect(auditRender([share("25%")], parts, {}, { partial: true }).problems).toEqual([]);
    expect(auditRender([share("30%", "0.3")], parts, {}, { partial: true }).problems).toMatchObject([{ kind: "RENDER_NOT_CLEARED" }]);
    expect(auditRender([share("25%")], { cleared: {}, problems: {} }, {}, { partial: true }).problems).toMatchObject([{ kind: "RENDER_NOT_CLEARED" }]);
  });
});

describe("chart labels: a chart only pictures the figures the view draws", () => {
  it("passes a label that is a drawn figure's value, and flags one that isn't", () => {
    expect(auditRender([view({ chart: ["$4.1k"] })], sweep, {}, { partial: true }).problems).toEqual([]);
    expect(auditRender([view({ chart: ["$9.9k"] })], sweep, {}, { partial: true }).problems).toMatchObject([{ kind: "RENDER_BYPASS" }]);
  });
});
