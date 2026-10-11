import { describe, expect, it } from "vitest";
import { legKey, matchTransfers, type Leg } from "./matchTransfers";

const chase = { accountId: "chase", institution: "Chase", subtype: "CHECKING" as const, identifiers: ["1111"] };
const fid = { accountId: "fid", institution: "Fidelity", subtype: "BROKERAGE" as const, identifiers: ["X00-000001"] };
const gold = { accountId: "gold", institution: "American Express", subtype: "CREDIT_CARD" as const, identifiers: ["0-00001"] };
const blue = { accountId: "blue", institution: "American Express", subtype: "CREDIT_CARD" as const, identifiers: ["0-00002"] };
const slavic = { accountId: "slavic", institution: "Slavic401k", subtype: "401K" as const, identifiers: ["9000000001"] };
const rollover = { accountId: "ira", institution: "Fidelity", subtype: "ROLLOVER_IRA" as const, identifiers: ["200-000001"] };

let n = 0;
function leg(acct: typeof chase | typeof fid | typeof gold | typeof blue | typeof slavic | typeof rollover, date: string, amountCents: number, extra: Partial<Leg> = {}): Leg {
  return {
    id: `t${++n}`,
    ...acct,
    date,
    datePrecision: "EXACT",
    periodStart: date,
    periodEnd: date,
    amountCents,
    role: "TRANSFER",
    ...extra,
  };
}

describe("matchTransfers", () => {
  it("pairs a Chase→Fidelity EFT with the Fidelity deposit", () => {
    const out = leg(chase, "2026-08-05", -3_250_000, { counterpartyInstitution: "Fidelity" });
    const inn = leg(fid, "2026-08-05", 3_250_000, { counterpartyInstitution: "Chase", counterpartyAccountHint: "1111" });
    const r = matchTransfers([out, inn]);
    expect(r.matches).toEqual([{ legIds: [out.id, inn.id], method: "EXACT_PAIR" }]);
  });

  it("refuses a pair whose named counterparty doesn't fit", () => {
    const out = leg(chase, "2026-08-05", -50_000, { counterpartyInstitution: "Fidelity" });
    const card = leg(gold, "2026-08-05", 50_000);
    expect(matchTransfers([out, card]).matches).toEqual([]);
  });

  it("refuses an account hint that names a different account", () => {
    const out = leg(fid, "2026-08-27", -1_150_000, { counterpartyInstitution: "Fidelity", counterpartyAccountHint: "300-000001" });
    const wrong = leg(rollover, "2026-08-27", 1_150_000);
    expect(matchTransfers([out, wrong]).matches).toEqual([]);
  });

  it("does not guess when one payment could belong to either card", () => {
    const pay = leg(chase, "2026-07-27", -250_000, { counterpartyInstitution: "American Express" });
    const g = leg(gold, "2026-07-27", 250_000, { counterpartySubtypes: ["CHECKING"] });
    const b = leg(blue, "2026-07-28", 250_000, { counterpartySubtypes: ["CHECKING"] });
    const r = matchTransfers([pay, g, b]);
    expect(r.matches).toEqual([]);
    expect(r.ambiguous).toHaveLength(1);
  });

  it("pairs recurring same-amount transfers in date order", () => {
    const legs = [
      leg(chase, "2026-01-16", -275_000, { counterpartyInstitution: "Fidelity" }),
      leg(fid, "2026-01-16", 275_000, { counterpartyInstitution: "Chase" }),
      leg(chase, "2026-01-20", -275_000, { counterpartyInstitution: "Fidelity" }),
      leg(fid, "2026-01-21", 275_000, { counterpartyInstitution: "Chase" }),
    ];
    const r = matchTransfers(legs);
    expect(r.matches.map((m) => m.legIds)).toEqual([
      [legs[0]!.id, legs[1]!.id],
      [legs[2]!.id, legs[3]!.id],
    ]);
    expect(r.matches.every((m) => m.method === "ORDERED_PAIR")).toBe(true);
  });

  it("never pairs two unknown-source rows with each other", () => {
    const a = leg(chase, "2026-01-26", -150_000, { role: "UNKNOWN" });
    const b = leg(fid, "2026-01-26", 150_000, { role: "UNKNOWN" });
    expect(matchTransfers([a, b]).matches).toEqual([]);
  });

  it("lets an unknown deposit complete a transfer only within a tight window", () => {
    const refund = leg(slavic, "2026-03-31", -150_000, { datePrecision: "PERIOD", periodStart: "2026-01-01", periodEnd: "2026-03-31" });
    const deposit = leg(chase, "2026-01-26", 150_000, { role: "UNKNOWN" });
    expect(matchTransfers([refund, deposit]).matches).toHaveLength(1);
  });

  it("matches a quarterly total to the unique subset of dated legs", () => {
    const q = leg(slavic, "2026-06-30", 5_000_007, {
      datePrecision: "PERIOD",
      periodStart: "2026-04-01",
      periodEnd: "2026-06-30",
      counterpartySubtypes: ["ROLLOVER_IRA", "TRADITIONAL_IRA"],
    });
    const a = leg(rollover, "2026-04-22", -4_970_000, { counterpartySubtypes: ["401K"] });
    const b = leg(rollover, "2026-05-01", -30_000, { counterpartySubtypes: ["401K"] });
    const c = leg(rollover, "2026-06-01", -7, { counterpartySubtypes: ["401K"] });
    const r = matchTransfers([q, a, b, c]);
    expect(r.matches).toEqual([{ legIds: [q.id, a.id, b.id, c.id], method: "AGGREGATE" }]);
  });

  it("never re-proposes a rejected pairing", () => {
    const out = leg(chase, "2026-08-05", -3_250_000, { counterpartyInstitution: "Fidelity" });
    const inn = leg(fid, "2026-08-05", 3_250_000);
    expect(matchTransfers([out, inn], [legKey([inn.id, out.id])]).matches).toEqual([]);
  });

  it("offers lossy rollovers as suggestions, not matches", () => {
    const empower = { accountId: "emp", institution: "Empower", subtype: "401K" as const, identifiers: ["900000-01"] };
    const w = leg(empower, "2025-12-31", -5_003_725, { datePrecision: "PERIOD", periodStart: "2025-10-01", periodEnd: "2025-12-31" });
    const c = leg(rollover, "2026-01-05", 5_000_000, { counterpartySubtypes: ["401K"] });
    const r = matchTransfers([w, c]);
    expect(r.matches).toEqual([]);
    expect(r.suggestions).toEqual([{ legIds: [w.id, c.id], differenceCents: -3_725 }]);
  });

  it("is independent of input order", () => {
    const legs = [
      leg(chase, "2026-02-03", -6_000_000, { counterpartyInstitution: "Fidelity" }),
      leg(fid, "2026-02-03", 6_000_000, { counterpartyInstitution: "Chase" }),
      leg(chase, "2026-02-17", -275_000, { counterpartyInstitution: "Fidelity" }),
      leg(fid, "2026-02-17", 275_000, { counterpartyInstitution: "Chase" }),
    ];
    const key = (r: ReturnType<typeof matchTransfers>) => r.matches.map((m) => legKey(m.legIds)).sort();
    expect(key(matchTransfers([...legs].reverse()))).toEqual(key(matchTransfers(legs)));
  });
});
