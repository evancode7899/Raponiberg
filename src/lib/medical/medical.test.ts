import { describe, expect, it } from "vitest";
import { medicalDerived } from "../book/derived/medical.ts";
import type { PositionedItem } from "../statements/pdfLayout.ts";
import { careKind, codeCounts } from "./codes.ts";
import { eobCoverage, parseEob, planDocument, readableEob } from "./parse.ts";
import { planProblem, type HealthPlan } from "./plans.ts";
import { buildMedicalReport, statementChecks } from "./report.ts";
import type { EobStatement } from "./types.ts";

// ---------------------------------------------------------------- a made-up EOB, laid out as the insurer prints it

const LETTERS = "ABCDEFGHI";
const LETTER_X = [146, 191, 245, 297, 335, 375, 429, 492, 549];
const W = 5; // points per character, near enough

type Cell = string | [col: string, text: string];
/** One printed row: words at the left, then amounts right-aligned under their column letter. */
function row(page: number, y: number, cells: Cell[]): PositionedItem[] {
  return cells.map((c) => {
    if (typeof c === "string") return { page, x: 37, y, width: c.length * W, str: c };
    const [col, text] = c;
    if (col === "R") return { page, x: 262, y, width: text.length * W, str: text }; // a remark beside column C
    const center = LETTER_X[LETTERS.indexOf(col)]! + 3;
    return { page, x: center + 20 - text.length * W, y, width: text.length * W, str: text };
  });
}
const at = (page: number, y: number, x: number, str: string): PositionedItem => ({ page, x, y, width: str.length * W, str });
const header = (page: number, y: number) => [at(page, y, 37, "Service type and date"), ...LETTER_X.map((x, i) => at(page, y, x, LETTERS[i]!))];

function claimHead(page: number, y: number, who: string, provider: string | null, id: string) {
  return [at(page, y, 36, `Claim for ${who}`), ...(provider ? [at(page, y - 12, 36, `Provider: ${provider} (In-Network)`)] : []), at(page, y - 24, 37, `Claim ID: ${id}`), at(page, y - 33, 37, "Received on 3/2/25"), ...header(page, y - 50)];
}

function fixture(): { text: string; items: PositionedItem[] } {
  const items: PositionedItem[] = [
    at(1, 780, 36, "Example Health Insurance Company"),
    at(1, 770, 300, "Statement date: March 20, 2025"),
    at(1, 760, 36, "Group #: 0000000-00-001 XX"),
    at(1, 750, 36, "Group name: EXAMPLE EMPLOYER CO"),
    at(1, 700, 36, "Explanation of Benefits (EOB) - This is not a bill"),
    at(1, 690, 36, "Example Choice® Plan"),
    // payment summary: a provider's name wraps onto a second row
    ...["Patient", "Provider", "Amount", "Sent to", "Send date", "Amount"].map((s, i) => at(1, 650, [40, 130, 272, 310, 419, 541][i]!, s)),
    at(1, 638, 40, "Pat (self)"),
    at(1, 638, 130, "Springfield Physical"),
    at(1, 638, 281, "$64.80"),
    at(1, 638, 310, "Springfield Physical"),
    at(1, 638, 424, "3/18/25"),
    at(1, 638, 544, "$27.20"),
    at(1, 628, 130, "Therapy"),
    at(1, 628, 310, "Therapy"),
    at(1, 616, 40, "Sam (spouse)"),
    at(1, 616, 130, "Example Labs"),
    at(1, 616, 281, "$0.00"),
    at(1, 616, 544, "$12.00"),
    at(1, 604, 40, "Total:"),
    at(1, 590, 36, "Your claims up close"),
    // claim 1: two lines; the second's share is in two tiers (90% then 100%)
    ...claimHead(1, 560, "Pat (self)", "Springfield Physical Therapy", "EXA11AA1B00"),
    ...row(1, 495, ["THERAPEUTIC", ["A", "150.00"], ["B", "60.00"], ["D", "20.00"], ["F", "40.00"], ["G", "36.00"], ["H", "4.00"], ["I", "24.00"]]),
    ...row(1, 485, ["EXERCISES 97110 on"]),
    ...row(1, 475, ["3/1/25"]),
    ...row(1, 460, ["MANUAL THERAPY", ["A", "100.00"], ["B", "32.00"], ["C", "68.00"], ["R", "(1)"], ["F", "20.00"], ["G", "18.00"], ["H", "2.00"], ["I", "2.00"]]),
    ...row(1, 450, ["97140 on 3/1/25"]),
    ...row(1, 440, [["F", "10.80"], ["G", "10.80"], ["I", "1.20"]]),
    at(1, 400, 37, "Continued on next page"),
    // page 2: the claim carries on under a repeated header
    ...claimHead(2, 760, "Pat (self)", "Springfield Physical Therapy", "EXA11AA1B00"),
    ...row(2, 695, ["Refer to Remarks Section (2)"]),
    ...row(2, 680, ["Totals:", ["A", "250.00"], ["B", "92.00"], ["C", "68.00"], ["D", "20.00"], ["E", "0.00"], ["F", "70.80"], ["G", "64.80"], ["H", "6.00"], ["I", "$27.20"]]),
    at(2, 668, 37, "You can find all numbered claim remarks in 'Your Claim Remarks' section."),
    // claim 2: an adjustment, another plan paid first (COB), no provider printed
    ...claimHead(2, 640, "Sam (spouse)", null, "EXA22BB2C01"),
    ...row(2, 575, ["LAB PANEL 80053 on", ["A", "90.00"], ["B", "40.00"], ["C", "50.00"], ["D", "40.00"], ["I", "*See below"]]),
    ...row(2, 565, ["2/20/25 - 2/21/25"]),
    ...row(2, 550, ["Totals:", ["A", "90.00"], ["B", "40.00"], ["C", "50.00"], ["D", "40.00"], ["G", "0.00"], ["I", "$40.00"]]),
    at(2, 540, 37, "Less Amount Already Paid $5.00"),
    at(2, 530, 37, "You can find all numbered claim remarks in 'Your Claim Remarks' section."),
    at(2, 520, 37, "COB fast facts"),
    at(2, 510, 37, "Your share Other plan(s) paid Our payment after COB"),
    at(2, 500, 37, "$12.00 $28.00 $0.00"),
    at(2, 480, 37, "Your Claim Remarks"),
    at(2, 470, 37, "(1) You don't owe this amount. It is part of another"),
    at(2, 460, 37, "service on the same day."),
    at(2, 450, 37, "(2) Diagnosis codes may have been sent."),
    at(2, 430, 37, "Your benefit balances to date for 1/1/25 to 12/31/25"),
    at(2, 420, 37, "Pat (self)"),
    at(2, 410, 37, "Medical In Network Deductible"),
    at(2, 410, 200, "*"),
    at(2, 410, 356, "$2,000.00"),
    at(2, 410, 453, "$60.00"),
    at(2, 410, 535, "$1,940.00"),
    at(2, 400, 37, "Family Balances Annual"),
    at(2, 390, 37, "Medical In Network Out of Pocket Maximum *"),
    at(2, 390, 356, "$8,000.00"),
    at(2, 390, 453, "$72.00"),
    at(2, 390, 535, "$7,928.00"),
    at(2, 380, 37, "*Limit includes both Medical and Pharmacy"),
  ];
  const text = items.map((i) => i.str).join("\n");
  return { text, items };
}

describe("parseEob", () => {
  const { text, items } = fixture();
  const s = parseEob(text, items);

  it("recognizes a medical EOB in the layout it reads", () => {
    expect(eobCoverage(text)).toBe("MEDICAL");
    expect(readableEob(text)).toBe(true);
    expect(s).toMatchObject({ insurer: "Example Health", statementDate: "2025-03-20", group: "0000000-00-001", sponsor: "EXAMPLE EMPLOYER CO", plan: "Example Choice® Plan", balancesFrom: "2025-01-01", balancesTo: "2025-12-31" });
  });

  it("puts each amount in the column its letter heads, and carries a claim across pages", () => {
    const c = s.claims.find((x) => x.id === "EXA11AA1B00")!;
    expect(c).toMatchObject({ baseId: "EXA11AA1B", version: 0, patient: "Pat", relationship: "self", provider: "Springfield Physical Therapy", inNetwork: true, received: "2025-03-02" });
    expect(c.lines).toHaveLength(2);
    expect(c.lines[0]).toMatchObject({ service: "THERAPEUTIC EXERCISES", code: "97110", date: "2025-03-01", billedCents: 15_000, memberRateCents: 6_000, deductibleCents: 2_000, remainingCents: 4_000, planCents: 3_600, coinsuranceCents: 400, yourShareCents: 2_400 });
    // The second tier of the same line adds to it.
    expect(c.lines[1]).toMatchObject({ service: "MANUAL THERAPY", code: "97140", pendingCents: 6_800, remarks: [1], remainingCents: 3_080, planCents: 2_880, yourShareCents: 320 });
    expect(c.totals).toMatchObject({ billedCents: 25_000, planCents: 6_480, yourShareCents: 2_720 });
    expect(c.remarks[1]).toMatch(/You don't owe this amount\. It is part of another service on the same day\./);
    expect(Object.keys(c.remarks)).toEqual(["1", "2"]);
  });

  it("reads a claim with no provider, a stay's date range, an earlier payment and the COB facts", () => {
    const c = s.claims.find((x) => x.id === "EXA22BB2C01")!;
    expect(c).toMatchObject({ provider: "", version: 1, alreadyPaidCents: 500, cob: { yourShareCents: 1_200, otherPlanCents: 2_800, planAfterCobCents: 0 } });
    expect(c.lines[0]).toMatchObject({ code: "80053", date: "2025-02-20", dateTo: "2025-02-21", yourShareCents: 0 });
  });

  it("joins a payment summary name that wraps onto the next row", () => {
    expect(s.payments).toEqual([
      { patient: "Pat", relationship: "self", provider: "Springfield Physical Therapy", planCents: 6_480, sentTo: "Springfield Physical Therapy", sentOn: "2025-03-18", yourShareCents: 2_720 },
      { patient: "Sam", relationship: "spouse", provider: "Example Labs", planCents: 0, sentTo: null, sentOn: null, yourShareCents: 1_200 },
    ]);
  });

  it("reads the benefit balances, a person's and the family's", () => {
    expect(s.balances).toEqual([
      { person: "Pat", benefit: "Medical", inNetwork: true, kind: "DEDUCTIBLE", limitCents: 200_000, usedCents: 6_000, remainingCents: 194_000, includesPharmacy: true },
      { person: null, benefit: "Medical", inNetwork: true, kind: "OUT_OF_POCKET", limitCents: 800_000, usedCents: 7_200, remainingCents: 792_800, includesPharmacy: true },
    ]);
  });

  it("holds a statement to itself: lines to totals, and the payment summary to its claims", () => {
    const checks = statementChecks("eob.pdf", s);
    // The summary names the lab; the no-provider claim can't be matched to it, so the tie fails and says so.
    expect(checks.find((c) => c.id.startsWith("medical.lines"))).toMatchObject({ ok: true });
    expect(checks.find((c) => c.id.startsWith("medical.summary"))!.detail).toMatch(/Sam at Example Labs: the summary says 12, the claims 0/);
    const broken: EobStatement = { ...s, claims: s.claims.map((c, i) => (i ? c : { ...c, totals: { ...c.totals, planCents: c.totals.planCents + 1 } })) };
    expect(statementChecks("eob.pdf", broken)[0]).toMatchObject({ ok: false });
  });

  it("refuses a table it can't follow rather than guess", () => {
    const { text, items } = fixture();
    const extra = [...items, at(1, 495, LETTER_X[8]! + 3 + 20 - 20, "9.99")];
    expect(() => parseEob(text, extra)).toThrow(/Two amounts in column I/);
  });
});

describe("planDocument", () => {
  it("names a plan's own documents and its coverage", () => {
    expect(planDocument("Summary of Benefits and Coverage: What this Plan Covers Coverage Period: 01/01/2025 - 12/31/2025\nExample Health Insurance Company")).toMatchObject({ kind: "PLAN_DOC", coverage: "MEDICAL", title: "Summary of Benefits and Coverage", periodFrom: "2025-01-01", periodTo: "2025-12-31" });
    expect(planDocument("Example Dental PPO Plan\nCERTIFICATE OF COVERAGE\nbenefits")).toMatchObject({ coverage: "DENTAL", title: "Certificate of Coverage" });
    expect(planDocument("Example Bank statement, account summary")).toBeNull();
  });
});

describe("codes", () => {
  it("groups procedure codes into kinds of care", () => {
    expect(careKind("97110")).toBe("Physical therapy & rehab");
    expect(careKind("80053")).toBe("Lab tests");
    expect(careKind("99213")).toBe("Office & telehealth visits");
    expect(careKind("72148")).toBe("Imaging");
    expect(careKind("122")).toBe("Hospital stay");
    expect(careKind(null)).toBe("Other");
    expect(codeCounts("97813", ["97"], ["978"])).toBe(false);
    expect(codeCounts("97530", ["975"])).toBe(true);
  });
});

// ---------------------------------------------------------------- the report

const PLAN: HealthPlan = {
  id: "example-hdhp-2025",
  coverage: "MEDICAL",
  insurer: "Example Health Insurance Company",
  name: "Example Choice HDHP",
  coverageFrom: "2025-01-01",
  coverageTo: "2025-12-31",
  accumulator: "CALENDAR_YEAR",
  hsaEligible: true,
  deductible: { inNetwork: { individualCents: 200_000, familyCents: 400_000 }, outOfNetwork: null },
  outOfPocket: { inNetwork: { individualCents: 400_000, familyCents: 800_000 }, outOfNetwork: null },
  services: [],
  limits: [{ id: "rehab", service: "Therapy", limit: 20, unit: "visits", per: "CALENDAR_YEAR", codes: ["971"] }],
  excluded: [],
  otherCovered: [],
  rules: [],
  sources: [{ file: "Example/sbc.pdf", title: "Summary of Benefits and Coverage" }],
};

describe("buildMedicalReport", () => {
  const { text, items } = fixture();
  const s = parseEob(text, items);
  // An earlier statement printed version 00 of the lab claim, which the fixture's 01 replaces.
  const earlier: EobStatement = { ...s, statementDate: "2025-03-05", claims: [{ ...s.claims[1]!, id: "EXA22BB2C00", version: 0, cob: null, totals: { ...s.claims[1]!.totals, yourShareCents: 4_000, planCents: 500 } }], payments: [], balances: [] };
  const r = buildMedicalReport({ statements: [{ file: "b.pdf", statement: s }, { file: "a.pdf", statement: earlier }], pending: [], planDocs: [{ file: "Example/sbc.pdf", doc: { kind: "PLAN_DOC", coverage: "MEDICAL", title: "Summary of Benefits and Coverage", insurer: null, periodFrom: null, periodTo: null } }], plans: [PLAN], today: "2025-06-30" });

  it("lets an adjustment replace the claim's earlier version", () => {
    expect(r.claims.map((c) => c.id).sort()).toEqual(["EXA11AA1B00", "EXA22BB2C01"]);
    const lab = r.claims.find((c) => c.id === "EXA22BB2C01")!;
    expect(lab.earlier).toEqual([{ id: "EXA22BB2C00", file: "a.pdf", statementDate: "2025-03-05", yourShareCents: 4_000, planCents: 500 }]);
    // COB: you owe the COB figure, the other plan's share is its own, and the rest is written off.
    expect(lab).toMatchObject({ yourShareCents: 1_200, otherPlanCents: 2_800, planCents: 0, writeOffCents: 9_000 - 2_800 - 1_200, firstDate: "2025-02-20", lastDate: "2025-02-21", kind: "Lab tests" });
  });

  it("sums the year, by person, provider and kind of care", () => {
    const y = r.years[0]!;
    expect(y).toMatchObject({ coverage: "MEDICAL", year: 2025, plan: { id: PLAN.id } });
    expect(y.totals).toMatchObject({ claims: 2, billedCents: 34_000, planCents: 6_480, otherPlanCents: 2_800, yourShareCents: 3_920 });
    expect(y.totals.writeOffCents).toBe(34_000 - 6_480 - 2_800 - 3_920);
    expect(y.people.map((p) => [p.key, p.yourShareCents, p.visits])).toEqual([["Pat", 2_720, 1], ["Sam", 1_200, 1]]);
    expect(y.providers.map((p) => p.key)).toContain("Provider not printed");
    expect(y.balances).toMatchObject({ asOf: "2025-03-20", file: "b.pdf" });
    expect(y.months).toEqual([{ month: "2025-02", planCents: 0, yourShareCents: 1_200 }, { month: "2025-03", planCents: 6_480, yourShareCents: 2_720 }]);
  });

  it("counts a limit's visits from the claims' procedure codes, covered services only", () => {
    expect(r.years[0]!.limits[0]).toMatchObject({ tracked: true, from: "2025-01-01", to: "2025-12-31", people: [{ person: "Pat", used: 1, dates: ["2025-03-01"], nextOn: null }] });
    const refused: EobStatement = { ...s, claims: [{ ...s.claims[0]!, id: "EXA33CC3D00", baseId: "EXA33CC3D", lines: [{ ...s.claims[0]!.lines[0]!, date: "2025-04-01", memberRateCents: 0, deductibleCents: 0, remainingCents: 0, planCents: 0, coinsuranceCents: 0, pendingCents: 15_000 }] }] };
    const r2 = buildMedicalReport({ statements: [{ file: "b.pdf", statement: s }, { file: "c.pdf", statement: refused }], pending: [], plans: [PLAN], today: "2025-06-30" });
    expect(r2.years[0]!.limits[0]!.people).toEqual([{ person: "Pat", used: 1, dates: ["2025-03-01"], nextOn: null }]);
  });

  it("holds the plan's limits to the ones its EOBs count against", () => {
    expect(r.checks.find((c) => c.id === `medical.plan:${PLAN.id}`)).toMatchObject({ ok: true });
    const wrong = buildMedicalReport({ statements: [{ file: "b.pdf", statement: s }], pending: [], plans: [{ ...PLAN, deductible: { inNetwork: { individualCents: 150_000, familyCents: 400_000 }, outOfNetwork: null } }], today: "2025-06-30" });
    expect(wrong.checks.find((c) => c.id.startsWith("medical.plan"))).toMatchObject({ ok: false, detail: expect.stringMatching(/^deductible: the plan file says 1500, the EOB of 2025-03-20 2000 \(Pat\)/) });
  });

  it("says which plan documents the plan file was read from, and counts each coverage", () => {
    expect(r.planDocs[0]).toMatchObject({ file: "Example/sbc.pdf", read: true });
    expect(r.coverages).toEqual([
      { coverage: "MEDICAL", statements: 2, pending: 0, plans: 1, planDocs: 1 },
      { coverage: "DENTAL", statements: 0, pending: 0, plans: 0, planDocs: 0 },
      { coverage: "VISION", statements: 0, pending: 0, plans: 0, planDocs: 0 },
    ]);
  });

  it("lists every figure the page draws, and each sum's chain re-adds", () => {
    const figures = medicalDerived(r);
    const keys = figures.map((f) => `${f.figure}|${f.key}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(figures.find((f) => f.figure === "you-owe")).toMatchObject({ key: "MEDICAL|2025", value: { cents: 3_920 } });
    expect(figures.find((f) => f.figure === "claim-you" && f.key === "EXA22BB2C01")!.note).toMatch(/Replaces claim EXA22BB2C00/);
    expect(figures.find((f) => f.figure === "plan-deductible" && f.key === `${PLAN.id}|in|family`)).toMatchObject({ value: { cents: 400_000 } });
    for (const f of figures) {
      let acc = 0;
      for (const l of f.lines) {
        if (!("cents" in l.value)) continue;
        if (l.op === "=") expect(l.value.cents, `${f.figure} ${f.key}`).toBe(acc);
        else acc = l.op === "−" ? acc - l.value.cents : l.op === "+" ? acc + l.value.cents : l.value.cents;
      }
    }
  });
});

describe("planProblem", () => {
  it("accepts a whole plan and names what a half-written one lacks", () => {
    expect(planProblem(PLAN)).toBeNull();
    expect(planProblem({ ...PLAN, coverage: "LIFE" as never })).toMatch(/coverage must be one of/);
    expect(planProblem({ ...PLAN, coverageTo: "2024-12-31" })).toMatch(/in order/);
    expect(planProblem({ ...PLAN, limits: [{ ...PLAN.limits[0]!, limit: 0 }] })).toMatch(/limit above 0/);
  });
});
