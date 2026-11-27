import { describe, expect, it } from "vitest";
import { amountFigures } from "./derived/said.ts";
import { noteBook, sayer, sentences, splitSaid } from "./said.ts";

describe("said: amounts written into sentences", () => {
  it("records each amount as the sentence prints it, keyed by its owner, field and place", () => {
    const s = sayer("f:1", "title");
    const text = `Off by ${s.usd(123_456, "the gap")} on ${s.usd(-500, "a refund")}`;
    expect(text).toBe("Off by $1,234.56 on −$5.00");
    expect(s.amounts.map((a) => [a.key, a.text, a.value])).toEqual([
      ["f:1|title|0", "$1,234.56", { cents: 123_456 }],
      ["f:1|title|1", "−$5.00", { cents: -500 }],
    ]);
  });

  it("splits a sentence at its own field's amounts, in order, even when the text repeats", () => {
    const w = sentences("f:2");
    const title = `${w.title.usd(100, "a")} then ${w.title.usd(100, "b")}`;
    const detail = `${w.detail.usd(100, "c")}`;
    const parts = splitSaid(title, w.amounts, "title");
    expect(parts.map((p) => (typeof p === "string" ? p : p.key))).toEqual(["f:2|title|0", " then ", "f:2|title|1"]);
    expect(splitSaid(detail, w.amounts, "detail").map((p) => (typeof p === "string" ? p : p.key))).toEqual(["f:2|detail|0"]);
  });

  it("a notebook files each amount under its finished sentence, keys counting across sentences", () => {
    const nb = noteBook("tax:2025");
    const a = nb.say((x) => `First ${x.usd(1_00, "one")}.`);
    const b = nb.say((x) => `Then ${x.pct(0.455, "a share", 1)}.`);
    expect(b).toBe("Then 45.5%.");
    expect(nb.amounts.map((x) => [x.key, x.field])).toEqual([
      ["tax:2025|0", a],
      ["tax:2025|1", b],
    ]);
  });

  it("an amount's figure re-adds its lines, a line taken away drawn as minus its size", () => {
    const s = sayer("f:3", "detail");
    s.usd(70, "net", [
      { label: "In", cents: 100 },
      { label: "Out", cents: -30 },
    ]);
    const [f] = amountFigures(s.amounts);
    expect(f!.value).toEqual({ cents: 70 });
    expect(f!.lines.map((l) => [l.op ?? null, l.value])).toEqual([
      [null, { cents: 100 }],
      ["−", { cents: 30 }],
      ["=", { cents: 70 }],
    ]);
  });
});

describe("said: a notebook writing a sentence twice", () => {
  it("keeps the first copy's amounts only", () => {
    const nb = noteBook("t");
    nb.say((x) => `A ${x.usd(100, "a")}`);
    nb.say((x) => `A ${x.usd(100, "a")}`);
    expect(nb.amounts.map((a) => a.key)).toEqual(["t|0"]);
  });
});
