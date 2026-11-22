import { addDays } from "../dates/isoDate.ts";
import type { ParsedDocument } from "../ingest/types.ts";
import { MEDICAL_READER_VERSION } from "../medical/parse.ts";
import type { HealthPlan, HealthPlansFile } from "../medical/plans.ts";
import type { EobBalance, EobClaim, EobStatement, MedicalDocsFile } from "../medical/types.ts";

/**
 * The demo household's health cover: a made-up high-deductible family plan through Alex's
 * employer, one plan entry a year, and an explanation of benefits for each visit. The
 * urgent-care and lab charges on the demo cards are the visits' payments (so the Medical
 * page finds what paid each claim); three visits are the HSA log's own expenses (one EOB
 * says less was owed than the log has, so the HSA page shows that flag); and one visit has
 * no payment in the statements.
 */

const INSURER = "Northstar Health Plan";
const SPONSOR = "Harborview Capital Partners LP";
const FAMILY_DEDUCTIBLE = 600_000;
const FAMILY_OOP = 1_200_000;

type Visit = { date: string; patient: string; relationship: string; provider: string; service: string; code: string; owed: number };

function plan(year: number): HealthPlan {
  return {
    id: `northstar-hdhp-${year}`,
    coverage: "MEDICAL",
    insurer: INSURER,
    name: "Northstar HSA Choice",
    type: "PPO",
    sponsor: SPONSOR,
    network: "Northstar Open Access",
    coverageFrom: `${year}-01-01`,
    coverageTo: `${year}-12-31`,
    covers: "Employee + Family",
    accumulator: "CALENDAR_YEAR",
    hsaEligible: true,
    embeddedDeductible: false,
    deductible: { inNetwork: { individualCents: 300_000, familyCents: FAMILY_DEDUCTIBLE }, outOfNetwork: { individualCents: 600_000, familyCents: 1_200_000 } },
    outOfPocket: { inNetwork: { individualCents: 600_000, familyCents: FAMILY_OOP }, outOfNetwork: null },
    services: [{ group: "If you visit a provider's office", items: [{ service: "Primary care visit", inNetwork: "20% coinsurance", outOfNetwork: "40% coinsurance" }] }],
    limits: [{ id: "pt", service: "Physical therapy", limit: 30, unit: "visits", per: "CALENDAR_YEAR", codes: ["971"] }],
    excluded: ["Cosmetic surgery"],
    otherCovered: [],
    rules: [],
    sources: [{ file: `Northstar/Plan/${year} Summary of Benefits.pdf`, title: `${year} Summary of Benefits and Coverage` }],
  };
}

/** One visit's claim: the deductible takes what you owe, the plan pays the rest of the network rate. */
function claim(v: Visit, n: number): EobClaim {
  const memberRate = Math.round(v.owed * 2.5);
  const billed = Math.round(memberRate * 1.6);
  const line = { service: v.service, code: v.code, date: v.date, dateTo: null, billedCents: billed, memberRateCents: memberRate, pendingCents: 0, deductibleCents: v.owed, copayCents: 0, remainingCents: memberRate - v.owed, planCents: memberRate - v.owed, coinsuranceCents: 0, yourShareCents: v.owed, remarks: [] };
  const { service: _s, code: _c, date: _d, dateTo: _t, remarks: _r, ...totals } = line;
  const base = `NSH${String(n).padStart(6, "0")}`;
  return { id: `${base}00`, baseId: base, version: 0, patient: v.patient, relationship: v.relationship, provider: v.provider, inNetwork: true, received: addDays(v.date, 4), lines: [line], totals, alreadyPaidCents: 0, interestCents: 0, cob: null, remarks: {} };
}

export function demoMedical(documents: ParsedDocument[]): { docs: MedicalDocsFile; plans: HealthPlansFile } {
  const charges = documents
    .flatMap((d) => d.sections.flatMap((s) => s.transactions))
    .filter((t) => (t.description === "CITYMD URGENT CARE" || t.description === "LABCORP") && t.date >= "2025-01-10" && t.amountCents < 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const visits: Visit[] = charges.map((t, i) => ({
    date: addDays(t.date, -3),
    patient: i % 2 ? "Jordan" : "Alex",
    relationship: i % 2 ? "spouse" : "self",
    provider: t.description === "LABCORP" ? "LABCORP OF AMERICA" : "CITYMD URGENT CARE PC",
    service: t.description === "LABCORP" ? "LAB TESTS" : "OFFICE VISIT",
    code: t.description === "LABCORP" ? "80053" : "99213",
    owed: -t.amountCents,
  }));
  // The HSA log's visits (generate.ts): paid out of pocket, outside the demo's statements.
  visits.push(
    { date: "2025-02-11", patient: "Riley", relationship: "daughter", provider: "RIVERSIDE PEDIATRICS PC", service: "WELL CHILD VISIT", code: "99392", owed: 34_500 },
    { date: "2025-04-03", patient: "Alex", relationship: "self", provider: "HUDSON IMAGING AND ORTHOPEDICS", service: "MRI KNEE", code: "73721", owed: 182_000 },
    { date: "2025-06-19", patient: "Alex", relationship: "self", provider: "BROOKLYN SPORTS PHYSICAL THERAPY", service: "THERAPEUTIC EXERCISE", code: "97110", owed: 60_000 },
    // Seen and billed, but not paid in any statement yet.
    { date: "2026-02-24", patient: "Jordan", relationship: "spouse", provider: "PARK AVENUE DERMATOLOGY", service: "OFFICE VISIT", code: "99203", owed: 21_000 },
  );
  visits.sort((a, b) => a.date.localeCompare(b.date));

  const used = new Map<string, number>();
  const files: MedicalDocsFile["files"] = {};
  visits.forEach((v, i) => {
    const year = v.date.slice(0, 4);
    const c = claim(v, i + 1);
    const before = used.get(year) ?? 0;
    const after = before + v.owed;
    used.set(year, after);
    const balance = (kind: EobBalance["kind"], limit: number): EobBalance => ({ person: null, benefit: "Medical", inNetwork: true, kind, limitCents: limit, usedCents: Math.min(after, limit), remainingCents: Math.max(0, limit - after), includesPharmacy: true });
    const statementDate = addDays(v.date, 14);
    const statement: EobStatement = {
      kind: "EOB",
      coverage: "MEDICAL",
      insurer: INSURER,
      plan: "Northstar HSA Choice",
      sponsor: SPONSOR,
      group: "0099999",
      statementDate,
      claims: [c],
      payments: [{ patient: v.patient, relationship: v.relationship, provider: v.provider, planCents: c.totals.planCents, sentTo: v.provider, sentOn: statementDate, yourShareCents: v.owed }],
      balancesFrom: `${year}-01-01`,
      balancesTo: `${year}-12-31`,
      balances: [balance("DEDUCTIBLE", FAMILY_DEDUCTIBLE), balance("OUT_OF_POCKET", FAMILY_OOP)],
    };
    files[`Northstar/EOBs/EOB ${statementDate} ${c.id}.pdf`] = { stamp: "demo", sha: `demo-eob-${i + 1}`, version: MEDICAL_READER_VERSION, doc: statement };
  });
  return { docs: { version: 1, scannedAt: "2026-06-30T12:00:00.000Z", files }, plans: { version: 1, plans: [plan(2026), plan(2025)] } };
}
