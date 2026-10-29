import { describe, expect, it } from "vitest";
import { parseFundDoc } from "./parse.ts";
import { buildLpFunds, type FundWire } from "./report.ts";
import type { FundCall, FundStatement } from "./types.ts";

// A made-up fund and investor: none of these figures come from a real statement.
const FUND = "Example Credit Fund II Feeder LP";
const ID = "TNR0000009999";

const letter = (date: string, body: string, summary: [number, number, number, number, number]) => `${FUND}
CONFIDENTIAL
${body.includes("Return of") ? "EQUALISATION AND " : ""}CAPITAL CALL NOTICE
Start${ID}End
${date}
Pat Example
This letter will serve as an official Drawdown Notice pursuant to clause 3.3 of the Partnership Agreement dated May 1, 2025.
${body}
After this Contribution, a summary of your Commitment is as follows:
Total Capital Commitment \t$ ${summary[0].toLocaleString()}
Prior Contributions – Inception to Date \t$ ${summary[1].toLocaleString()}
Distributions – Inception to Date \t$ (0)
Current Contribution \t$ ${summary[3].toLocaleString()}
Remaining Unfunded Commitment \t$ ${summary[4].toLocaleString()}
On behalf of ${FUND}
Acting by its general partner Example Credit II GP LP`;

const CALL_1 = letter("February 10, 2026", "Total Amount Due by February 24, 2026 \t$ 2,000.00", [20_000, 0, 0, 2_000, 18_000]);
const CALL_2 = letter("May 5, 2026", "Total Amount Due by May 19, 2026 \t$ 3,000", [20_000, 2_000, 0, 3_000, 15_000]);
const EQ_CALL = letter(
  "August 4, 2026",
  `This call comprises the following:
Return of Contribution in accordance with clause 3.5(b) \t$ (800)
Interest on Return of Contribution in accordance with clause 3.5(b) \t$ (20)
Contribution in accordance with clause 3.3 \t$ 1,000
Total Amount Due by August 18, 2026 \t$ 180`,
  [20_000, 5_000, 0, 200, 14_800],
);

// The ILPA template copy of the August notice: values sit apart from their labels.
const EQ_ILPA = `2.01 Fund
2.02 Issue Date (MM-DD-YYYY):
2.03 Due Date (MM-DD-YYYY):
2.20 Cumulative LP Amount (Prior To Current Notice)¹: \t5,000 \t-
2.21 LP Amount (Current Notice): \t180 \t-
2.22 Cumulative LP Amount (Including Current Notice)¹: \t5,180 \t-
20,000
08-18-2026
USD
Start${ID}End
ILPA Capital Call & Distribution Template
${FUND}
08-04-2026
2026-10-01 09:00:00
Contribution \t1,000 \t(1,000) \t1,000
Interest on Return of Contribution \t20 \t- \t(20)
Return of Contribution \t800 \t800 \t(800)`;

const statement = (asOf: string, qtdContrib: number, itdContrib: number, income: number, ending: number) => `Pat Example
Start${ID}End
Statement of Partner's Capital Activity
Quarter To Date Inception To Date
Beginning Capital $ 10 $ -
Contributions ${qtdContrib.toLocaleString()} ${itdContrib.toLocaleString()}
Distributions - -
Management fee expense - -
Total Income/(Loss) 50 ${income.toLocaleString()}
Carried Interest - -
Ending Capital $ ${ending.toLocaleString()} $ ${ending.toLocaleString()}
Commitment Summary
Commitment $ 20,000
Less: Contributions (${itdContrib.toLocaleString()})
Remaining Capital Commitment ${(20_000 - itdContrib).toLocaleString()}
${FUND}
Partner's Capital Statement | ${asOf}`;

const Q1 = statement("March 31, 2026", 2_000, 2_000, 60, 2_060);
const Q2 = statement("June 30, 2026", 3_000, 5_000, 250, 5_250);

describe("fund documents", () => {
  it("reads a plain capital call letter and its commitment summary", () => {
    expect(parseFundDoc(CALL_1, [FUND])).toMatchObject({
      kind: "CALL",
      format: "letter",
      fund: FUND,
      investorId: ID,
      issued: "2026-02-10",
      due: "2026-02-24",
      equalisation: false,
      contributionCents: 200_000,
      netDueCents: 200_000,
      printed: { commitmentCents: 2_000_000, priorContributionsCents: 0, currentContributionCents: 200_000, unfundedCents: 1_800_000 },
    });
  });

  it("splits an equalisation call into the contribution, what was handed back and interest", () => {
    expect(parseFundDoc(EQ_CALL, [FUND])).toMatchObject({ equalisation: true, contributionCents: 100_000, returnedCents: 80_000, interestCents: 2_000, netDueCents: 18_000, printed: { currentContributionCents: 20_000, unfundedCents: 1_480_000 } });
  });

  it("reads the ILPA template copy of the same notice", () => {
    expect(parseFundDoc(EQ_ILPA, [FUND])).toMatchObject({ format: "ilpa", issued: "2026-08-04", due: "2026-08-18", contributionCents: 100_000, returnedCents: 80_000, interestCents: 2_000, netDueCents: 18_000 });
  });

  it("reads a capital statement's inception-to-date column, not the Commitment Summary heading", () => {
    expect(parseFundDoc(Q2, [FUND])).toMatchObject({ kind: "STATEMENT", asOf: "2026-06-30", endingCapitalCents: 525_000, itd: { contributionsCents: 500_000, incomeCents: 25_000 }, commitmentCents: 2_000_000, remainingCommitmentCents: 1_500_000 });
  });

  it("ignores fund paperwork it doesn't use", () => {
    expect(parseFundDoc("QUARTERLY LETTER - Q2 2026")).toBeNull();
  });
});

describe("LP view", () => {
  const src = (n: number) => ({ documentId: `d${n}`, title: `doc ${n}` });
  const docs = [CALL_1, Q1, CALL_2, Q2, EQ_CALL, EQ_ILPA].map((t, i) => ({ source: src(i), doc: parseFundDoc(t, [FUND]) as FundCall | FundStatement }));
  const wire = (id: string, date: string, dollars: number): FundWire => ({ id, date, amountCents: -dollars * 100, accountName: "Checking ••1234", institution: "Example Partners" });
  const wires = [wire("w1", "2026-02-12", 2_000), wire("w2", "2026-05-08", 3_000), wire("w3", "2026-08-06", 180)];
  const [f] = buildLpFunds({ docs, accounts: [{ id: "acct", name: "Example Credit Fund II", institution: "Example Partners", identifiers: [ID] }], wires });

  it("totals commitment, gross and net contributions, everything paid out, interest and unfunded", () => {
    expect(f).toMatchObject({
      manager: "Example Partners",
      accountId: "acct",
      commitmentCents: 2_000_000,
      calledCents: 600_000,
      returnedCents: 80_000,
      netContributedCents: 520_000,
      interestCents: 2_000,
      distributedCents: 82_000,
      unfundedCents: 1_480_000,
      netCashCents: 518_000,
      wiredCents: 518_000,
      latestNotice: "2026-08-04",
      callsSinceStatement: 1,
    });
  });

  it("counts the letter and its ILPA copy as one notice", () => {
    expect(f!.events.filter((e) => e.kind !== "STATEMENT")).toHaveLength(3);
    expect(f!.events[0]!.sources.map((s) => s.documentId)).toEqual(["d4", "d5"]);
  });

  it("prices the latest statement on the money called through its date", () => {
    expect(f!.statement).toMatchObject({ asOf: "2026-06-30", navCents: 525_000, paidInCents: 500_000, distributedCents: 0, gainCents: 25_000, dpi: 0 });
    expect(f!.statement!.tvpi).toBeCloseTo(1.05);
  });

  it("ties every figure to what the manager printed and to the bank's wires", () => {
    expect(f!.checks.filter((c) => !c.ok)).toEqual([]);
    expect(f!.events.find((e) => e.date === "2026-08-04")!.wire).toMatchObject({ date: "2026-08-06", amountCents: 18_000 });
  });

  it("flags a missing notice: the statement counts more than the notices add to", () => {
    const [g] = buildLpFunds({ docs: docs.filter((d) => d.source.documentId !== "d2"), accounts: [], wires: [] });
    expect(g!.checks.some((c) => !c.ok && c.label.includes("statement"))).toBe(true);
  });
});
