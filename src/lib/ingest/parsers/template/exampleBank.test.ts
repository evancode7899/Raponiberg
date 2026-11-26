import { describe, expect, it } from "vitest";
import { PARSERS } from "../index";
import { detectExampleBank, parseExampleBank } from "./exampleBank";
import { exampleBankFixture } from "./fixture";

/** Every check a section carries ties to the cent. */
const ties = (doc: ReturnType<typeof parseExampleBank>) => doc.sections.every((s) => (s.checks ?? []).every((c) => c.expectedCents === c.actualCents));

describe("the statement parser template", () => {
  it("reads two hundred made-up statements exactly as written, each tying to the cent", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const f = exampleBankFixture({ seed });
      const doc = parseExampleBank(f.text);
      const s = doc.sections[0]!;
      expect(s.accountNumber).toBe(f.accountNumber);
      expect([s.periodStart, s.periodEnd]).toEqual([f.periodStart, f.periodEnd]);
      expect([s.openingBalanceCents, s.closingBalanceCents]).toEqual([f.openingCents, f.closingCents]);
      // Deposits are listed before withdrawals: compare as sets of rows.
      const key = (r: { date: string; description: string; amountCents: number }) => `${r.date}|${r.description}|${r.amountCents}`;
      expect(s.transactions.map(key).sort()).toEqual(f.rows.map(key).sort());
      expect(ties(doc)).toBe(true);
    }
  });

  it("handles a quiet month, and a period across a new year", () => {
    expect(parseExampleBank(exampleBankFixture({ rows: 0, seed: 7 }).text).sections[0]!.transactions).toEqual([]);
    const f = exampleBankFixture({ periodStart: "2031-12-15", days: 31, rows: 40, seed: 9 });
    const dates = parseExampleBank(f.text).sections[0]!.transactions.map((t) => t.date);
    expect(dates.some((d) => d.startsWith("2031-12")) && dates.some((d) => d.startsWith("2032-01"))).toBe(true);
  });

  it("holds a statement whose rows don't add up: a check fails rather than the import passing", () => {
    const f = exampleBankFixture({ seed: 3, rows: 5 });
    const dropped = f.text.split("\n").filter((l, i, all) => !(i === all.findIndex((x) => /^\d{2}\/\d{2} /.test(x)))).join("\n");
    expect(ties(parseExampleBank(dropped))).toBe(false);
  });

  it("is detected only by its own statement, and is a template, not a registered parser", () => {
    expect(detectExampleBank(exampleBankFixture().text)).toBe(true);
    expect(detectExampleBank("Statement period 03/01/2031 to 03/30/2031\nBeginning balance on 03/01/2031 $1.00")).toBe(false);
    for (const p of PARSERS) expect(p.detect(exampleBankFixture().text), p.id).toBe(false);
    expect(PARSERS.some((p) => p.id === "example-bank-checking")).toBe(false);
  });
});
