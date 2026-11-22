import { describe, expect, it } from "vitest";
import { buildHsaReport, eobOwedOf, reimbursableOf } from "../hsa/report.ts";
import { EMPTY_SETTINGS, type HsaExpense, type HsaFile } from "../hsa/store.ts";
import { hsaPlanYear, linkExpenses, matchClaimPayments, premiumCoverage, providerAccounts, premiumLines, sameProvider, type ClaimLite, type PaymentRowIn } from "./links.ts";
import type { HealthPlan } from "./plans.ts";
import { hsaEligibilityChecks, premiumChecks, standingVersions, type ClaimView } from "./report.ts";

const claim = (id: string, o: Partial<ClaimLite> = {}): ClaimLite => ({
  id,
  coverage: "MEDICAL",
  patient: "Avery",
  provider: "LAKESIDE FAMILY MEDICINE PC",
  firstDate: "2025-03-03",
  lastDate: "2025-03-03",
  statementDate: "2025-03-20",
  file: `eob-${id}.pdf`,
  yourShareCents: 12_500,
  planCents: 30_000,
  ...o,
});
const row = (id: string, o: Partial<PaymentRowIn> = {}): PaymentRowIn => ({ id, date: "2025-04-02", amountCents: -12_500, payee: "LAKESIDE FAMILY MED ONLINE PMT", account: "Card ••0001", fromHsa: false, medical: false, ...o });

const plan = (o: Partial<HealthPlan> = {}): HealthPlan => ({
  id: "test-hdhp-2025",
  coverage: "MEDICAL",
  insurer: "Example Health",
  name: "Example HDHP",
  coverageFrom: "2025-01-01",
  coverageTo: "2025-12-31",
  accumulator: "CALENDAR_YEAR",
  hsaEligible: true,
  deductible: { inNetwork: { individualCents: 300_000, familyCents: 600_000 }, outOfNetwork: null },
  outOfPocket: { inNetwork: { individualCents: 600_000, familyCents: 1_200_000 }, outOfNetwork: null },
  services: [],
  limits: [],
  excluded: [],
  otherCovered: [],
  rules: [],
  sources: [],
  ...o,
});

describe("provider names", () => {
  it("match on a word that tells providers apart, never a generic one", () => {
    expect(sameProvider("LAKESIDE FAMILY MEDICINE PC", "LAKESIDE FAMILY MED ONLINE PMT")).toBe(true);
    expect(sameProvider("NORTH MEDICAL GROUP", "SOUTH MEDICAL GROUP")).toBe(false);
    expect(sameProvider("", "ANYTHING")).toBe(false);
  });
});

describe("matchClaimPayments", () => {
  it("ties a claim to the row of exactly what you owe that names the provider", () => {
    const { byClaim } = matchClaimPayments([claim("A")], [row("r1"), row("r2", { payee: "GROCERY MART", medical: false })]);
    expect(byClaim.get("A")).toMatchObject({ rowId: "r1", how: "NAME", fromHsa: false });
  });

  it("takes an unnamed row only when it's plainly medical and the only one of that amount", () => {
    const one = matchClaimPayments([claim("A")], [row("r1", { payee: "PAYMENTUS CORP", medical: true })]);
    expect(one.byClaim.get("A")?.how).toBe("MEDICAL");
    const two = matchClaimPayments([claim("A")], [row("r1", { payee: "PAYMENTUS CORP", medical: true }), row("r2", { payee: "INSTAMED", medical: true })]);
    expect(two.byClaim.has("A")).toBe(false);
  });

  it("ties an HSA card swipe as the HSA paying directly", () => {
    const { byClaim } = matchClaimPayments([claim("A")], [row("h1", { payee: "CARD PURCHASE", fromHsa: true })]);
    expect(byClaim.get("A")).toMatchObject({ rowId: "h1", fromHsa: true });
  });

  it("ignores rows outside the window, and claims you owe nothing on", () => {
    const { byClaim } = matchClaimPayments([claim("A"), claim("Z", { yourShareCents: 0 })], [row("early", { date: "2025-02-01" }), row("late", { date: "2026-02-01" })]);
    expect(byClaim.size).toBe(0);
  });

  it("ties one bill for several visits to the provider's claims that add up to it", () => {
    const cs = [claim("A", { yourShareCents: 4_000 }), claim("B", { yourShareCents: 6_500, firstDate: "2025-03-10", lastDate: "2025-03-10" }), claim("C", { yourShareCents: 9_900 })];
    const { byClaim } = matchClaimPayments(cs, [row("bill", { amountCents: -10_500 })]);
    expect(byClaim.get("A")?.rowId).toBe("bill");
    expect(byClaim.get("B")?.rowId).toBe("bill");
    expect(byClaim.get("A")?.how).toBe("GROUP");
    expect(byClaim.has("C")).toBe(false);
  });
});

describe("matchClaimPayments: the EOB names the clinician, the card the billing office", () => {
  // A therapist whose visits are billed by the practice, and paid at the desk on the day.
  const pt = (id: string, date: string, owed: number) => claim(id, { provider: "Morgan Q Ellery", firstDate: date, lastDate: date, statementDate: addDays(date, 10), yourShareCents: owed });
  const desk = (id: string, date: string, cents: number, o: Partial<PaymentRowIn> = {}) => row(id, { date, amountCents: -cents, payee: "BRIGHTWAY PHYSICAL THERAPY ELMTON ST", medical: true, ...o });
  function addDays(d: string, n: number) {
    const t = new Date(`${d}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  }

  it("learns the billing name from a match of exactly the share, then ties the desk payments of other visits", () => {
    const cs = [pt("A", "2025-05-01", 3_300), pt("B", "2025-05-08", 1_160), pt("C", "2025-05-15", 1_160)];
    const rows = [desk("exact", "2025-05-20", 3_300), desk("v1", "2025-05-08", 1_200), desk("v2", "2025-05-15", 1_200)];
    const { byClaim, billingNames } = matchClaimPayments(cs, rows);
    expect(byClaim.get("A")).toMatchObject({ rowId: "exact", how: "MEDICAL" });
    expect(byClaim.get("B")).toMatchObject({ rowId: "v1", how: "VISIT", amountCents: 1_200 });
    expect(byClaim.get("C")).toMatchObject({ rowId: "v2", how: "VISIT" });
    expect(billingNames.get("MORGAN Q ELLERY")).toEqual([["BRIGHTWAY", "ELMTON", "PHYSICAL", "THERAPY"]]);
  });

  it("never takes a payee sharing only its town with a learned billing name", () => {
    const cs = [pt("A", "2025-05-01", 3_300), pt("B", "2025-05-08", 1_160)];
    // Not medical and weeks after the visit: only a billing name could tie it.
    const rows = [desk("exact", "2025-05-20", 3_300), desk("town", "2025-06-20", 1_160, { payee: "ELMTON HARDWARE ELMTON ST", medical: false })];
    expect(matchClaimPayments(cs, rows).byClaim.has("B")).toBe(false);
  });

  it("ties a rounded bill from the provider's billing name, never an unnamed one", () => {
    const cs = [pt("A", "2025-05-01", 3_300), pt("B", "2025-06-02", 125_040)];
    const named = matchClaimPayments(cs, [desk("exact", "2025-05-20", 3_300), desk("bill", "2025-07-01", 125_000)]);
    expect(named.byClaim.get("B")).toMatchObject({ rowId: "bill", how: "NEAR" });
    const unnamed = matchClaimPayments([claim("Z", { yourShareCents: 5_610 })], [row("strips", { payee: "NASAL STRIPS CO", medical: true, amountCents: -5_640 })]);
    expect(unnamed.byClaim.has("Z")).toBe(false);
  });

  it("ties a same-day desk copay from an unnamed office, and the balance billed after", () => {
    const c = claim("A", { provider: "Riley P Ostrander", yourShareCents: 3_480, firstDate: "2025-06-10", lastDate: "2025-06-10" });
    const rows = [row("copay", { date: "2025-06-10", amountCents: -3_000, payee: "OBGYN ASSOCIATES ELMTON", medical: true }), row("rest", { date: "2025-07-05", amountCents: -480, payee: "WOMENS CARE ONLINE", medical: true })];
    const { allByClaim } = matchClaimPayments([c], rows);
    expect(allByClaim.get("A")?.map((p) => [p.rowId, p.how])).toEqual([
      ["copay", "VISIT"],
      ["rest", "BALANCE"],
    ]);
  });

  it("never ties a pharmacy or shop charge on the day of care, nor a row naming another visit that day", () => {
    const c = claim("A", { provider: "Riley P Ostrander", yourShareCents: 2_750, firstDate: "2025-06-10", lastDate: "2025-06-10" });
    const pharmacy = matchClaimPayments([c], [row("rx", { date: "2025-06-10", amountCents: -1_650, payee: "CVS/PHARMACY #0001", medical: true })]);
    expect(pharmacy.byClaim.has("A")).toBe(false);
    const other = claim("B", { yourShareCents: 1_040, firstDate: "2025-06-10", lastDate: "2025-06-10" });
    const theirs = matchClaimPayments([c, other], [row("lk", { date: "2025-06-10", amountCents: -1_280, payee: "LAKESIDE FAMILY MED", medical: true })]);
    expect(theirs.byClaim.get("B")?.rowId).toBe("lk");
    expect(theirs.byClaim.has("A")).toBe(false);
  });

  it("ties a hospital bill to its claims and the same patient's doctors seen there, adding up exactly", () => {
    const cs = [
      claim("H", { provider: "Elmton Hospital", yourShareCents: 61_000, firstDate: "2025-04-01", lastDate: "2025-04-01" }),
      claim("D", { provider: "Casey R Wu", yourShareCents: 7_350, firstDate: "2025-04-01", lastDate: "2025-04-01" }),
      claim("X", { provider: "Casey R Wu", patient: "Rowan", yourShareCents: 7_350, firstDate: "2025-04-01", lastDate: "2025-04-01" }),
    ];
    const { allByClaim } = matchClaimPayments(cs, [row("bill", { date: "2025-05-01", amountCents: -68_350, payee: "ELMTON HOSPITAL PATIENT PMT", medical: true })]);
    expect(allByClaim.get("H")?.[0]).toMatchObject({ rowId: "bill", how: "GROUP", claimIds: ["H", "D"] });
    expect(allByClaim.has("X")).toBe(false);
  });

  it("never lets a shop in the hospital's town pay its claims together", () => {
    const cs = [claim("H", { provider: "Elmton Hospital", yourShareCents: 4_200 }), claim("D", { provider: "Casey R Wu", yourShareCents: 1_310 })];
    const { byClaim } = matchClaimPayments(cs, [row("shop", { amountCents: -5_510, payee: "GROCER #12 ELMTON ST", medical: false })]);
    expect(byClaim.size).toBe(0);
  });
});

describe("matchClaimPayments: bills paid in parts, before a reprocess, or not in full", () => {
  it("ties a bill to the claim's two parts on one EOB and the doctors seen that day", () => {
    const cs = [
      claim("H0", { provider: "Elmton Hospital", yourShareCents: 41_200 }),
      claim("H1", { provider: "Elmton Hospital", yourShareCents: 3_310 }),
      claim("D1", { provider: "Casey R Wu", yourShareCents: 233 }),
      claim("D2", { provider: "Jo B Park", yourShareCents: 187 }),
    ];
    const { allByClaim } = matchClaimPayments(cs, [row("bill", { amountCents: -44_930, payee: "ELMTON HOSPITAL PATIENT PMT", medical: true })]);
    for (const id of ["H0", "H1", "D1", "D2"]) expect(allByClaim.get(id)?.[0]?.rowId).toBe("bill");
  });

  it("ties a bill paid at what a claim said before the insurer reprocessed it", () => {
    const cs = [claim("A", { yourShareCents: 0, earlierShares: [6_420] }), claim("B", { yourShareCents: 2_710 })];
    const { allByClaim } = matchClaimPayments(cs, [row("bill", { amountCents: -9_130, medical: true })]);
    const pay = allByClaim.get("A")?.[0];
    expect(pay).toMatchObject({ rowId: "bill", how: "GROUP" });
    expect(pay?.shares).toEqual(expect.arrayContaining([{ claimId: "A", cents: 6_420 }, { claimId: "B", cents: 2_710 }]));
    // Only what the EOBs say now was owed can be reimbursed: the reprocessed part is the provider's to refund.
    expect(eobOwedOf(pay!, cs)).toBe(2_710);
  });

  it("ties installments to one office adding up to the claim, starting at the visit", () => {
    const c = claim("A", { provider: "Dana K Moss", yourShareCents: 31_150, firstDate: "2025-03-03", lastDate: "2025-03-03" });
    const pt = (id: string, date: string, cents: number) => row(id, { date, amountCents: -cents, payee: "PT *RIVERBEND CLINIC 0001 ELMTON ST", medical: true });
    const { allByClaim } = matchClaimPayments([c], [pt("i1", "2025-03-03", 3_000), pt("i2", "2025-04-10", 21_300), pt("i3", "2025-07-01", 6_850)]);
    expect([...(allByClaim.get("A") ?? [])].sort((a, b) => a.date.localeCompare(b.date)).map((p) => [p.rowId, p.how])).toEqual([
      ["i1", "INSTALLMENT"],
      ["i2", "INSTALLMENT"],
      ["i3", "INSTALLMENT"],
    ]);
  });

  it("ties a provider's payment for less than the claim as part of it, to the latest EOB before it", () => {
    const cs = [claim("A", { yourShareCents: 52_000, statementDate: "2025-03-20" }), claim("B", { yourShareCents: 8_000, firstDate: "2025-04-01", lastDate: "2025-04-01", statementDate: "2025-04-20" })];
    const { allByClaim } = matchClaimPayments(cs, [row("p", { date: "2025-04-25", amountCents: -5_000, medical: true })]);
    expect(allByClaim.get("B")?.[0]).toMatchObject({ rowId: "p", how: "PARTIAL" });
    expect(allByClaim.has("A")).toBe(false);
  });

  it("takes a health-filed payee for exactly the share, never an insurer's", () => {
    const c = claim("A", { provider: "Morgan Q Ellery", yourShareCents: 2_390 });
    expect(matchClaimPayments([c], [row("u", { payee: "UNIV MED SCHOOL WEB", health: true })]).byClaim.size).toBe(0);
    expect(matchClaimPayments([c], [row("u", { payee: "UNIV MED SCHOOL WEB", health: true, amountCents: -2_390 })]).byClaim.get("A")?.how).toBe("MEDICAL");
    expect(matchClaimPayments([c], [row("i", { payee: "ACME AUTO INSURANCE", health: true, amountCents: -2_390 })]).byClaim.size).toBe(0);
  });

  it("takes all of one office's charges on the day of care, never the hospital garage", () => {
    const c = claim("A", { provider: "", yourShareCents: 70_000, firstDate: "2025-05-01", lastDate: "2025-05-01" });
    const eye = (id: string, cents: number) => row(id, { date: "2025-05-02", amountCents: -cents, payee: "Card: Elmton Eye Associates, ST", fromHsa: true });
    const { allByClaim } = matchClaimPayments([c], [eye("e1", 41_000), eye("e2", 12_000), row("park", { date: "2025-05-01", amountCents: -300, payee: "SELF PARKING 1 HOSPITAL PLAZA", medical: true })]);
    expect(allByClaim.get("A")?.map((p) => p.rowId).sort()).toEqual(["e1", "e2"]);
  });
});

describe("standingVersions", () => {
  const v = (id: string, version: number, statementDate: string, o: Partial<ClaimView> = {}) => ({ id, version, statementDate, planCents: 0, alreadyPaidCents: 0, yourShareCents: 0, ...o }) as ClaimView;
  it("keeps versions on one EOB as parts, and lets a later one replace the version it reprocessed", () => {
    const out = standingVersions([v("X00", 0, "2025-02-01", { planCents: 7_700, yourShareCents: 6_420 }), v("X01", 1, "2025-02-01", { yourShareCents: 2_710 }), v("X02", 2, "2025-06-01", { alreadyPaidCents: 7_700 })]);
    expect(out.map((x) => [x.claim.id, x.replaced.map((r) => r.id)])).toEqual([
      ["X02", ["X00"]],
      ["X01", []],
    ]);
  });
  it("replaces the latest version when the reprocess doesn't say which", () => {
    const out = standingVersions([v("Y00", 0, "2025-02-01"), v("Y01", 1, "2025-05-01")]);
    expect(out.map((x) => x.claim.id)).toEqual(["Y01"]);
  });
});

describe("linkExpenses", () => {
  it("links by the claim's payment, by exact amount, or flags a visit logged above what was owed", () => {
    const cs = [claim("A"), claim("B", { patient: "Rowan", yourShareCents: 8_000, firstDate: "2025-05-05", lastDate: "2025-05-05", statementDate: "2025-05-20" }), claim("C", { patient: "Avery", provider: "HARBOR PHYSICAL THERAPY", yourShareCents: 20_000, firstDate: "2025-07-07", lastDate: "2025-07-07" })];
    const { payments } = matchClaimPayments(cs, [row("r1")]);
    const links = linkExpenses(
      [
        { id: "e1", date: "2025-04-02", amountCents: 12_500, patient: "", provider: "Lakeside", paidRowId: "r1" },
        { id: "e2", date: "2025-05-06", amountCents: 8_000, patient: "Rowan", provider: "Checkup", paidRowId: null },
        { id: "e3", date: "2025-07-07", amountCents: 35_000, patient: "Avery", provider: "Harbor physical therapy", paidRowId: null },
        { id: "e4", date: "2025-05-06", amountCents: 8_000, patient: "Avery", provider: "Other", paidRowId: null },
      ],
      cs,
      payments,
    );
    expect(links.get("e1")).toMatchObject({ claimIds: ["A"], how: "PAYMENT", over: false });
    expect(links.get("e2")).toMatchObject({ claimIds: ["B"], how: "AMOUNT", over: false });
    expect(links.get("e3")).toMatchObject({ claimIds: ["C"], how: "VISIT", over: true, owedCents: 20_000 });
    // A different patient's claim of the same amount, already taken, backs nothing.
    expect(links.has("e4")).toBe(false);
  });
});

describe("provider balances: a set charge at the desk, netted later", () => {
  // A clinic charges $12.40 at each visit the EOB later says cost $12.00; the fourth visit's
  // desk charge is $1.20 short, using up the three 40¢ credits.
  const visit = (id: string, date: string) => claim(id, { provider: "Jordan Q Lee", firstDate: date, lastDate: date, statementDate: addDays(date, 3), yourShareCents: 1_200, planCents: 10_800 });
  const desk = (id: string, date: string, cents: number) => row(id, { date, amountCents: -cents, payee: "HARBOR PHYSICAL THERAPY ANYTOWN", medical: true });
  const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const cs = [visit("V1", "2025-06-02"), visit("V2", "2025-06-09"), visit("V3", "2025-06-16"), visit("V4", "2025-06-23")];
  const rows = [desk("d1", "2025-06-02", 1_240), desk("d2", "2025-06-09", 1_240), desk("d3", "2025-06-16", 1_240), desk("d4", "2025-06-23", 1_080)];
  const exp = (id: string, rowId: string, cents: number, date: string) => ({ id, date, amountCents: cents, patient: "", provider: "Harbor Physical Therapy", paidRowId: rowId });

  it("puts one office's visits in one account, netting over- and underpaid visits", () => {
    const { payments } = matchClaimPayments(cs, rows);
    expect(payments.map((p) => p.how)).toEqual(["VISIT", "VISIT", "VISIT", "VISIT"]);
    const { accounts } = providerAccounts(cs, payments);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ visits: 4, owedCents: 4_800, paidCents: 4_800, balanceCents: 0, providers: ["Jordan Q Lee"], payees: ["HARBOR PHYSICAL THERAPY ANYTOWN"] });
  });

  it("doesn't flag a visit paid over its EOB when the office put the extra toward later care", () => {
    const { payments } = matchClaimPayments(cs, rows);
    const links = linkExpenses([exp("e1", "d1", 1_240, "2025-06-02"), exp("e4", "d4", 1_080, "2025-06-23")], cs, payments);
    expect(links.get("e1")).toMatchObject({ over: false, creditCents: 40, heldCents: 0, owedCents: 1_200 });
    expect(links.get("e4")).toMatchObject({ over: false, creditCents: 0 });
  });

  it("flags only what the office still holds, on the latest visits paid over", () => {
    const three = cs.slice(0, 3);
    const { payments } = matchClaimPayments(three, rows.slice(0, 3));
    const links = linkExpenses([exp("e1", "d1", 1_240, "2025-06-02"), exp("e2", "d2", 1_240, "2025-06-09"), exp("e3", "d3", 1_240, "2025-06-16")], three, payments);
    // No later visit yet: all $1.20 is held, 40¢ on each.
    expect([...links.values()].map((l) => [l.over, l.heldCents])).toEqual([[true, 40], [true, 40], [true, 40]]);
    // A fourth visit charged in full (nothing netted yet) still owes $12.00 the credit can go toward.
    const withNext = [...three, cs[3]!];
    const later = linkExpenses([exp("e3", "d3", 1_240, "2025-06-16")], withNext, matchClaimPayments(withNext, rows.slice(0, 3)).payments);
    expect(later.get("e3")).toMatchObject({ over: false, creditCents: 40 });
  });

  it("still flags an expense logged above the charge that paid it", () => {
    const { payments } = matchClaimPayments(cs, rows);
    expect(linkExpenses([exp("e1", "d1", 1_500, "2025-06-02")], cs, payments).get("e1")?.over).toBe(true);
  });

  it("suggests logging the whole desk charge when the office didn't keep the extra", () => {
    const { payments } = matchClaimPayments(cs, rows);
    const pay = payments.find((p) => p.rowId === "d1")!;
    expect(eobOwedOf(pay, cs)).toBe(1_200);
    expect(reimbursableOf(pay, cs, 0)).toBe(1_240);
    expect(reimbursableOf(pay, cs, 25)).toBe(1_215);
  });
});

describe("premiums", () => {
  it("reads which cover a pre-tax line pays for, leaving FSAs and commuter benefits out", () => {
    expect(premiumCoverage("Medical Pre-Tax")).toBe("MEDICAL");
    expect(premiumCoverage("DENTAL PRETAX")).toBe("DENTAL");
    expect(premiumCoverage("VSP VISION")).toBe("VISION");
    expect(premiumCoverage("HEALTH CARE FSA")).toBeNull();
    expect(premiumCoverage("COMMUTER TRANSIT")).toBeNull();
  });

  it("holds each premium to a plan on file, from the first plan of that cover on", () => {
    const stubs = ["2024-12-15", "2025-06-15", "2026-01-15"].map((payDate) => ({ payDate, personId: "p1", employer: "Example Co", documentTitle: `stub ${payDate}`, lines: [{ name: "Medical Pre-Tax", kind: "SECTION125", current: 9_000 }] }));
    const lines = premiumLines(stubs);
    expect(lines).toHaveLength(3);
    const [check] = premiumChecks(lines, [plan()], "2026-02-01");
    expect(check).toMatchObject({ id: "medical.premiums:MEDICAL", ok: false, date: "2026-01-15" });
    expect(premiumChecks(lines, [plan(), plan({ id: "test-hdhp-2026", coverageFrom: "2026-01-01", coverageTo: "2026-12-31" })], "2026-02-01")[0]!.ok).toBe(true);
  });
});

describe("HSA eligibility", () => {
  it("fails HSA money from pay while only a plan that isn't HSA-eligible is in force", () => {
    const pay = [{ payDate: "2025-03-15", employer: "Example Co", cents: 20_000 }, { payDate: "2024-06-15", employer: "Example Co", cents: 20_000 }];
    expect(hsaEligibilityChecks(pay, [plan()])[0]).toMatchObject({ ok: true });
    const bad = hsaEligibilityChecks(pay, [plan({ hsaEligible: false })])[0]!;
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain("2025-03-15");
    expect(bad.detail).not.toContain("2024-06-15");
  });

  it("reads the year's coverage, months and the last-month rule from the plans", () => {
    const fam = hsaPlanYear([plan({ covers: "Employee + Family" })], 2025, () => []);
    expect(fam).toMatchObject({ coverage: "FAMILY", eligibleMonths: 12, ineligibleMonths: 0, december: true });
    const halfYear = hsaPlanYear([plan({ covers: "Employee only", coverageTo: "2025-06-30" }), plan({ id: "ppo", hsaEligible: false, coverageFrom: "2025-07-01" })], 2025, () => []);
    expect(halfYear).toMatchObject({ coverage: "SELF", eligibleMonths: 6, ineligibleMonths: 6, december: false });
    expect(hsaPlanYear([plan()], 2025, () => ["Avery", "Rowan"])?.coverage).toBe("FAMILY");
    expect(hsaPlanYear([plan()], 2023, () => [])).toBeNull();
  });
});

describe("the HSA page and the EOBs", () => {
  const expense = (o: Partial<HsaExpense>): HsaExpense => ({
    id: "x",
    date: "2025-03-03",
    amountCents: 12_500,
    provider: "Lakeside",
    patient: "Avery",
    kind: "MEDICAL",
    notes: "",
    receipt: false,
    receiptRef: "",
    source: "MANUAL",
    paidWith: null,
    reimbursement: null,
    createdAt: "2025-03-04T00:00:00.000Z",
    updatedAt: "2025-03-04T00:00:00.000Z",
    ...o,
  });
  const file = (expenses: HsaExpense[]): HsaFile => ({ version: 1, expenses, dismissed: [], ignoredMerchants: [], settings: { ...EMPTY_SETTINGS } });
  const accounts = [
    { id: "card", name: "Card ••0001", institution: "EXAMPLE", group: "Credit cards", identifiers: ["0001"] },
    { id: "hsa", name: "HSA ••0002", institution: "EXAMPLE", group: "Health savings", identifiers: ["0002"] },
  ];
  const base = { today: "2025-12-31", accounts, hsaAccounts: [], persons: [], marginalRate: null };
  const ledgerRow = (id: string, accountId: string, payee: string, amountCents: number, date: string) => ({ id, date, amountCents, lane: "EXPENSE", accountId, payee, merchantKey: null, category: "Shopping", classifiedBy: null });

  it("counts an EOB that says you owed exactly the expense as its receipt, and flags one logged above it", () => {
    const cs = [claim("A"), claim("C", { provider: "HARBOR PHYSICAL THERAPY", yourShareCents: 20_000, firstDate: "2025-07-07", lastDate: "2025-07-07" })];
    const r = buildHsaReport({
      ...base,
      rows: [],
      file: file([expense({ id: "ok" }), expense({ id: "over", date: "2025-07-07", amountCents: 35_000, provider: "Harbor physical therapy" })]),
      eob: { claims: cs, payments: [] },
    });
    const ok = r.expenses.find((e) => e.id === "ok")!;
    expect(ok.hasReceipt).toBe(true);
    expect(ok.flags).not.toContain("NO_RECEIPT");
    const over = r.expenses.find((e) => e.id === "over")!;
    expect(over.flags).toContain("OVER_EOB");
    expect(over.hasReceipt).toBe(false);
    expect(over.doubt).toContain("you owed $200.00");
  });

  it("suggests a charge that paid an EOB's claim even when its name doesn't look medical, with the EOB's patient", () => {
    const rows = [ledgerRow("r1", "card", "LAKESIDE ONLINE PMT", -12_500, "2025-04-02")];
    const { payments } = matchClaimPayments([claim("A")], [row("r1", { payee: "LAKESIDE ONLINE PMT" })]);
    const r = buildHsaReport({ ...base, rows, file: file([]), eob: { claims: [claim("A")], payments } });
    expect(r.suggestions).toEqual([expect.objectContaining({ rowId: "r1", tier: "LIKELY", patient: "Avery", provider: "LAKESIDE FAMILY MEDICINE PC" })]);
  });

  it("says which claims an HSA card swipe paid", () => {
    const rows = [ledgerRow("h1", "hsa", "CARD PURCHASE LAKESIDE", -12_500, "2025-03-25")];
    const { payments } = matchClaimPayments([claim("A")], [row("h1", { payee: "CARD PURCHASE LAKESIDE", fromHsa: true })]);
    const r = buildHsaReport({ ...base, rows, file: file([]), eob: { claims: [claim("A")], payments } });
    expect(r.withdrawals[0]).toMatchObject({ kind: "DIRECT", claims: [expect.objectContaining({ id: "A" })] });
  });
});
