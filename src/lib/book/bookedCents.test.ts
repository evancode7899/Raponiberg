import { describe, expect, it } from "vitest";
import { addDays } from "../dates/isoDate";
import { bookedCents, bookedShare } from "./booking";

// SSOT F · I: a period total splits into whole cents that add back to it exactly, whatever the periods.
const row = (amountCents: number, start: string, end: string) => ({ date: start, precision: "PERIOD" as const, statement: { start, end }, amountCents });

describe("bookedCents", () => {
  it("splits any period total into whole cents that add back exactly, each within a cent of its share", () => {
    let seed = 7;
    const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let t = 0; t < 300; t++) {
      const start = addDays("2025-01-01", Math.floor(rand() * 300));
      const end = addDays(start, Math.floor(rand() * 120));
      const r = row(Math.round((rand() - 0.5) * 2_000_000), start, end);
      // Random cut points: consecutive periods covering the statement and beyond.
      const cuts = [addDays(start, -5)];
      while (cuts.at(-1)! <= end) cuts.push(addDays(cuts.at(-1)!, 1 + Math.floor(rand() * 40)));
      let total = 0;
      for (let i = 0; i + 1 < cuts.length; i++) {
        const from = cuts[i]!;
        const to = addDays(cuts[i + 1]!, -1);
        const c = bookedCents(r, from, to);
        expect(Number.isInteger(c)).toBe(true);
        expect(Math.abs(c - r.amountCents * bookedShare(r, from, to))).toBeLessThan(1);
        total += c;
      }
      expect(total).toBe(r.amountCents);
    }
  });

  it("books an exact row whole on its day", () => {
    const r = { date: "2025-03-05", precision: "EXACT" as const, statement: { start: "2025-03-01", end: "2025-03-31" }, amountCents: -1234 };
    expect(bookedCents(r, "2025-03-01", "2025-03-31")).toBe(-1234);
    expect(bookedCents(r, "2025-04-01", "2025-04-30")).toBe(0);
  });
});
