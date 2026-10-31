import { describe, expect, it } from "vitest";
import { auditRender, readDrawn, textMatches, type DrawnFigure, type DrawnView } from "./renderAudit";

const fig = (over: Partial<DrawnFigure> = {}): DrawnFigure => ({ key: "k1", shown: "4125.50", shownKind: "cents", perMonths: null, clearance: "cleared", text: "$4,126", ...over });
const view = (over: Partial<DrawnView> = {}): DrawnView => ({ view: "/example", figures: [fig()], strays: [], errors: [], ...over });
const sweep = { cleared: { k1: { cents: 4125_50 } }, problems: {} };

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
