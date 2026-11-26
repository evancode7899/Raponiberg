import { INSURANCE_READER_VERSION } from "../insurance/parse.ts";
import type { AutoCoverage, AutoPolicy, Coverage, InsuranceDocsFile, PropertyPolicy } from "../insurance/types.ts";

/**
 * The demo household's home and auto cover, as if read off their declarations pages: a renters
 * policy renewed each March, paid once a year from checking ("STATE FARM INSURANCE PREM",
 * generate.ts), and the 2023 Volvo XC60 on six-month auto terms paid monthly ("GEICO AUTO
 * INSURANCE"). Policy numbers, names and the address are made up. The Insurance page reads
 * them from data/demo/insurance-documents.json, as it reads a real folder's scan.
 */
export const DEMO_RENTERS_PREMIUM = 21_800;
export const DEMO_AUTO_MONTHLY = 28_640;

const cover = (code: string | null, name: string, limit: string, limitCents: number[], extra: Partial<Coverage> = {}): Coverage => ({ code, name, per: null, limit, limitCents, deductibleCents: null, additional: false, ...extra });

function renters(year: number): PropertyPolicy {
  return {
    kind: "PROPERTY",
    line: "RENTERS",
    form: "Renters Policy",
    insurer: "State Farm Fire and Casualty Company",
    policyNumber: "99-EX-1234-5",
    namedInsured: ["Alex Rivera", "Jordan Rivera"],
    premises: ["100 Example Street Apt 4", "Springfield, CT 06000"],
    periodStart: `${year}-03-01`,
    periodEnd: `${year + 1}-03-01`,
    termMonths: 12,
    renewal: year > 2025,
    autoRenews: true,
    annualPremiumCents: DEMO_RENTERS_PREMIUM,
    totalPremiumCents: DEMO_RENTERS_PREMIUM,
    discounts: ["Home/Auto", "Claim Record"],
    property: [cover("B", "Personal Property", "$60,000", [6_000_000]), cover(null, "Loss of Use", "Actual Loss Sustained", [])],
    liability: [cover("L", "Personal Liability", "$300,000 Each Occurrence", [30_000_000], { per: "Each Occurrence" }), cover("M", "Medical Payments to Others", "$2,000 Each Person", [200_000], { per: "Each Person" })],
    deductibles: [{ name: "Basic", cents: 50_000, text: "$500" }],
    lossSettlement: ["B1 Limited Replacement Cost - Coverage B"],
    forms: [{ code: "FP-7956", name: "Renters Policy", isNew: false }],
    inflationIndex: null,
    billing: "Billed annually",
    amountDue: null,
    agent: { name: "Example Agency", phone: null },
    preparedDate: `${year}-01-20`,
  };
}

const autoCoverage = (name: string, limit: string, limitCents: number[], premium: number, extra: Partial<Coverage> = {}): AutoCoverage => ({ ...cover(null, name, limit, limitCents, extra), premiumCents: [premium] });

function auto(start: string, end: string, renewal: boolean): AutoPolicy {
  return {
    kind: "AUTO",
    insurer: "GEICO General Insurance Company",
    policyNumber: "4000-12-34-56",
    namedInsured: ["Alex Rivera"],
    drivers: ["Alex Rivera", "Jordan Rivera"],
    issuedDate: start,
    periodStart: start,
    periodEnd: end,
    termMonths: 6,
    renewal,
    termPremiumCents: DEMO_AUTO_MONTHLY * 6,
    vehicles: [{ n: 1, year: 2023, make: "VOLVO XC60", vin: null, garaged: "Springfield, CT", lienholder: null }],
    coverages: [
      autoCoverage("Bodily Injury Liability", "$100,000/$300,000", [10_000_000, 30_000_000], 52_000, { per: "Each Person/Each Occurrence" }),
      autoCoverage("Property Damage Liability", "$100,000", [10_000_000], 31_000, { per: "Each Occurrence" }),
      autoCoverage("Comprehensive", "$500 Ded", [], 24_000, { deductibleCents: 50_000 }),
      autoCoverage("Collision", "$500 Ded", [], 64_840, { deductibleCents: 50_000 }),
    ],
    discounts: [{ name: "Multi-Vehicle", cents: null }, { name: "Good Driver", cents: null }],
    discountTotalCents: null,
    contractType: null,
    amendments: null,
    unitEndorsements: null,
    servicePhone: null,
  };
}

/** Six-month auto terms from `from` until the demo's last month is covered. */
function autoTerms(from: string, through: string): [string, string][] {
  const out: [string, string][] = [];
  let [y, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  const day = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, "0")}-05`;
  while (day(y, m) <= `${through}-28`) {
    const start = day(y, m);
    m += 6;
    if (m > 12) [y, m] = [y + 1, m - 12];
    out.push([start, day(y, m)]);
  }
  return out;
}

export function demoInsurance(from: string, through: string): InsuranceDocsFile {
  const files: InsuranceDocsFile["files"] = {};
  const entry = (rel: string, doc: PropertyPolicy | AutoPolicy) => (files[rel] = { stamp: "demo", sha: `demo-${rel}`, version: INSURANCE_READER_VERSION, doc });
  for (let y = Number(from.slice(0, 4)); `${y}-03` <= through; y++) entry(`State Farm/renters-${y}.pdf`, renters(y));
  autoTerms(`${from.slice(0, 7)}`, through).forEach(([s, e], i) => entry(`GEICO/auto-${s}.pdf`, auto(s, e, i > 0)));
  return { version: 1, scannedAt: `${through}-28T12:00:00.000Z`, files };
}
