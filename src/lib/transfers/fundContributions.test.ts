import { describe, expect, it } from "vitest";
import type { FundCall } from "../funds/types.ts";
import { FUND_NOTICE, transferDifferenceAdjustments } from "../ledger/transferFees.ts";
import { planFundContributions } from "./fundContributions.ts";
import type { Leg } from "./matchTransfers.ts";

// An invented fund, investor number, notices and wires.
const ID = "INV0000004242";
const MANAGER = "Example Partners";

const call = (issued: string, due: string, dollars: { called: number; returned?: number; interest?: number }, format: FundCall["format"] = "letter"): FundCall => {
  const [contributionCents, returnedCents, interestCents] = [dollars.called * 100, (dollars.returned ?? 0) * 100, (dollars.interest ?? 0) * 100];
  return { kind: "CALL", format, fund: "Example Credit Fund II LP", investorId: ID, issued, due, equalisation: returnedCents > 0, contributionCents, returnedCents, interestCents, netDueCents: Math.max(0, contributionCents - returnedCents - interestCents), printed: null };
};

/** The quarter's "Contributions" line on the fund's capital statement. */
const quarter = (id: string, start: string, end: string, dollars: number): Leg => ({
  id,
  accountId: "fund",
  institution: MANAGER,
  subtype: "OTHER",
  identifiers: [ID],
  date: end,
  datePrecision: "PERIOD",
  periodStart: start,
  periodEnd: end,
  amountCents: dollars * 100,
  role: "TRANSFER",
  counterpartySubtypes: ["CHECKING", "SAVINGS"],
});

const wire = (id: string, date: string, dollars: number, to = MANAGER): Leg => ({
  id,
  accountId: "chk",
  institution: "Example Bank",
  subtype: "CHECKING",
  identifiers: ["1234"],
  date,
  datePrecision: "EXACT",
  periodStart: `${date.slice(0, 8)}01`,
  periodEnd: `${date.slice(0, 8)}28`,
  amountCents: -dollars * 100,
  role: "TRANSFER",
  counterpartyInstitution: to,
  counterpartySubtypes: ["OTHER"],
});

// Q3: one equalisation call wired in part, one paid entirely by its interest.
const JULY = call("2027-07-06", "2027-07-20", { called: 1_300, returned: 1_100, interest: 40 }); // +200, wire 160
const SEPT = call("2027-09-02", "2027-09-16", { called: 1_500, returned: 1_440, interest: 60 }); // +60, wire 0
const Q3 = quarter("q3", "2027-07-01", "2027-09-30", 260);

describe("a fund contribution its notices paid partly with interest", () => {
  it("pairs the quarter's contribution with the one wire, the interest as the difference", () => {
    expect(planFundContributions([Q3, wire("w", "2027-07-09", 160)], [JULY, SEPT])).toEqual([{ legIds: ["q3", "w"], differenceCents: 10_000 }]);
  });

  it("counts the letter and its ILPA copy as one notice", () => {
    const copy = { ...JULY, format: "ilpa" as const };
    expect(planFundContributions([Q3, wire("w", "2027-07-09", 160)], [JULY, copy, SEPT])).toEqual([{ legIds: ["q3", "w"], differenceCents: 10_000 }]);
  });

  it("pairs a quarter paid entirely by interest with no wire at all", () => {
    const q4 = quarter("q4", "2027-10-01", "2027-12-31", 25);
    const nov = call("2027-11-09", "2027-11-23", { called: 700, returned: 675, interest: 25 });
    expect(planFundContributions([q4], [JULY, SEPT, nov])).toEqual([{ legIds: ["q4"], differenceCents: 2_500 }]);
  });

  it("leaves a plain call to the ordinary matcher", () => {
    const q1 = quarter("q1", "2027-01-01", "2027-03-31", 2_000);
    expect(planFundContributions([q1, wire("w", "2027-01-20", 2_000)], [call("2027-01-12", "2027-01-26", { called: 2_000 })])).toEqual([]);
  });

  it("pairs nothing when the notices don't add up to the statement's contribution", () => {
    // The September notice isn't on file: July alone explains 200 of the 260.
    expect(planFundContributions([Q3, wire("w", "2027-07-09", 160)], [JULY])).toEqual([]);
  });

  it("pairs nothing when a notice's wire is missing, went elsewhere, or is outside its dates", () => {
    expect(planFundContributions([Q3], [JULY, SEPT])).toEqual([]);
    expect(planFundContributions([Q3, wire("w", "2027-07-09", 160, "Another Manager")], [JULY, SEPT])).toEqual([]);
    expect(planFundContributions([Q3, wire("w", "2027-07-03", 160)], [JULY, SEPT])).toEqual([]);
    expect(planFundContributions([Q3, wire("w", "2027-08-20", 160)], [JULY, SEPT])).toEqual([]);
  });

  it("pairs nothing when two wires could be the notice's", () => {
    expect(planFundContributions([Q3, wire("w1", "2027-07-09", 160), wire("w2", "2027-07-12", 160)], [JULY, SEPT])).toEqual([]);
  });

  it("ignores notices for another investor number", () => {
    const other = { ...Q3, identifiers: ["INV0000009999"] };
    expect(planFundContributions([other, wire("w", "2027-07-09", 160)], [JULY, SEPT])).toEqual([]);
  });

  it("keeps the interest on the fund's leg, so the ledger books it as the fund's growth", () => {
    const [m] = planFundContributions([Q3, wire("w", "2027-07-09", 160)], [JULY, SEPT]);
    const legs = [
      { id: "q3", amountCents: 26_000, accountId: "fund" },
      { id: "w", amountCents: -16_000, accountId: "chk" },
    ];
    expect([...transferDifferenceAdjustments([{ differenceCents: m!.differenceCents, method: FUND_NOTICE, legs }])]).toEqual([["q3", 10_000]]);
    // Without the notices behind it, a difference still lands on the sending leg.
    expect([...transferDifferenceAdjustments([{ differenceCents: 10_000, legs }])]).toEqual([["w", 10_000]]);
  });
});
