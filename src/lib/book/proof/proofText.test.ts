import { describe, expect, it } from "vitest";
import { monthEndLine, proofText } from "./proofText.ts";
import type { Proof } from "./types.ts";

/** An invented proof: Pat Example's dining in one made-up month. */
const proof: Proof = {
  report: "cash-flow",
  descriptor: { report: "cash-flow" } as unknown as Proof["descriptor"],
  describes: "Dining in Mar 2031",
  figure: { cents: 12_345 },
  selfCheck: { ok: true, deltaCents: 0, explain: "The 2 rows below add up to $123.45" },
  rederived: { routes: [{ route: "the statements' own totals", value: { cents: 12_345 }, ok: true, explain: "same rows, summed by statement" }] },
  withheld: false,
  blocks: [
    {
      kind: "rows",
      title: "Rows",
      figureCents: 12_345,
      groups: [
        {
          statement: { id: "s1", account: "Example Card ••1234", institution: null, periodStart: "2031-03-01", periodEnd: "2031-03-31", documentTitle: "example.pdf", status: "OK" },
          subtotalCents: 12_345,
          rows: [
            { id: "r1", date: "2031-03-04", bookedOn: "2031-03-04", payee: "SPRINGFIELD DINER", category: "Dining", account: "Example Card ••1234", amountCents: -10_000, countedCents: 10_000, share: 1, precision: "EXACT" },
            { id: "r2", date: "2031-03-19", bookedOn: "2031-03-19", payee: "", category: "Dining", account: "Example Card ••1234", amountCents: -2_345, countedCents: 2_345, share: 1, precision: "EXACT" },
          ],
        },
      ],
    },
    { kind: "chain", title: "How it's worked out", lines: [{ label: "Rows", value: { cents: 12_345 }, source: "proven" }, { op: "=", label: "Dining", value: { cents: 12_345 }, source: "derived", note: "a note" }] },
    { kind: "facts", title: "Filed by", items: [{ label: "Rule", text: "merchant rule" }] },
  ],
  checks: [{ id: "coverage" as never, title: "Every statement on file", description: "", state: "passed", passed: 3, subjects: [], open: [], accepted: [] }],
  estimates: [{ id: "e1", title: "An estimate", detail: "made up" }],
  through: "2031-03-31",
  today: "2031-04-10",
};

describe("a proof as text", () => {
  const text = proofText(proof, { state: "cleared", key: "k", shown: { cents: 12_345 }, cleared: { cents: 12_345 }, basis: "exact" as never });

  it("says what the figure is, whether it was cleared, and how it adds up", () => {
    expect(text.split("\n").slice(0, 4)).toEqual(["Dining in Mar 2031", "$123.45  (data through Mar 31, 2031)", "Cleared by the proof sweep.", "The 2 rows below add up to $123.45: exactly the figure shown."]);
    expect(text).toContain("Re-derived by the statements' own totals: $123.45");
  });

  it("lists every row under its statement, each in the app's own date and money format", () => {
    expect(text).toContain("  Example Card ••1234, statement Mar 1, 2031 to Mar 31, 2031\t$123.45");
    expect(text).toContain("    Mar 4, 2031  SPRINGFIELD DINER\t$100.00");
    // A row without a payee reads n.a., never blank.
    expect(text).toContain("    Mar 19, 2031  n.a.\t$23.45");
  });

  it("marks each chain line with where it stands, and lists checks and estimates", () => {
    expect(text).toContain("  = Dining [worked out]\t$123.45\n      a note");
    expect(text).toContain("CHECKS\n  Every statement on file: passed, on 3");
    expect(text).toContain("ESTIMATED PARTS\n  An estimate: made up");
  });

  it("says when a second route disagrees, and why a figure is withheld", () => {
    const bad = proofText({ ...proof, rederived: { routes: [{ route: "balances", value: { cents: 100 }, ok: false, explain: "" }] } }, { state: "withheld", key: null, shown: null, reason: "mismatch", detail: "the page differs" });
    expect(bad).toContain("Re-derived by balances: $1.00 (DISAGREES with $123.45)");
    expect(bad).toContain("Withheld (mismatch): the page differs");
  });
});

describe("the month-end line", () => {
  it("says unchanged, new since, or what it was and what changed", () => {
    expect(monthEndLine({ month: "2031-02", takenAt: "", was: { cents: 100 }, moved: false, why: [] })).toBe("Unchanged since the Feb 2031 month-end.");
    expect(monthEndLine({ month: "2031-02", takenAt: "", was: null, moved: true, why: [] })).toBe("Not a cleared figure at the Feb 2031 month-end.");
    expect(monthEndLine({ month: "2031-02", takenAt: "", was: { cents: 10_000 }, moved: true, why: [{ words: "statements imported for these dates", count: 2 }] })).toBe(
      "At the Feb 2031 month-end it was $100.00; since then: 2 statements imported for these dates.",
    );
    expect(proofText({ ...proof, monthEnd: { month: "2031-02", takenAt: "", was: { cents: 1 }, moved: false, why: [] } })).toContain("Unchanged since the Feb 2031 month-end.");
  });
});
