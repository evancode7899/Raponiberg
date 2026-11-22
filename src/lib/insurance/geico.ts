import { parseMonthNameDate, parseSlashDate } from "../ingest/text.ts";
import type { AutoCoverage, AutoPolicy, AutoRenewal, InsuredVehicle, PolicyForm } from "./types.ts";
import { dollarAmounts, titleCase } from "./words.ts";

/**
 * GEICO's auto policy documents, from their plain text (columns come out tab-separated):
 * the declarations page (drivers, vehicles, each coverage's limit and premium per vehicle,
 * the discounts), the renewal letter (new and prior premium), and every other page of the
 * packet (the contract, state notices), kept as reference forms so the statement import
 * doesn't offer them as statements.
 */

const GEICO = /\bGEICO\b/;
const INSURER = /\b(GEICO(?: [A-Z][a-z]+)+ Company|Government Employees Insurance Company)\b/;
const MONEY = String.raw`\$[\d,]+\.\d{2}`;
const SHORT_DATE = String.raw`\d{2}-\d{2}-\d{2,4}`;

export type GeicoKind = "AUTO" | "AUTO_RENEWAL" | "FORM";

export function geicoKind(text: string): GeicoKind | null {
  if (!GEICO.test(text)) return null;
  if (/Declarations Page/.test(text) && /Coverage Period:/.test(text) && new RegExp(`Total [A-Za-z ]+ Premium\\s+${MONEY}`).test(text)) return "AUTO";
  if (/Policy Summary/.test(text) && /Policy Term:/.test(text) && /New Premium:/.test(text)) return "AUTO_RENEWAL";
  // Every page of a GEICO packet is numbered within it ("Renewal Page 14 of 17").
  if (/^(?:Renewal|New Business) Page \d+ of \d+/m.test(text)) return "FORM";
  return null;
}

const first = (re: RegExp, text: string) => re.exec(text)?.[1]?.trim();
const insurerOf = (text: string) => first(INSURER, text) ?? "GEICO";
const policyNumberOf = (text: string) => first(/Policy Number:\s*([\d-]{8,})/, text);

/** The lines between two headings (exclusive), trimmed, blanks dropped. */
function between(lines: string[], start: RegExp, end: RegExp): string[] {
  const i = lines.findIndex((l) => start.test(l));
  if (i < 0) return [];
  const j = lines.findIndex((l, k) => k > i && end.test(l));
  return lines.slice(i + 1, j < 0 ? undefined : j).filter(Boolean);
}

export function parseGeicoDeclarations(text: string): AutoPolicy {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const policyNumber = policyNumberOf(text);
  const period = new RegExp(`Coverage Period:\\s*(${SHORT_DATE}) through (${SHORT_DATE})`).exec(text);
  const total = new RegExp(`Total ([A-Za-z ]+?) Premium\\s+(${MONEY})`).exec(text);
  const periodStart = parseSlashDate(period?.[1] ?? "");
  const periodEnd = parseSlashDate(period?.[2] ?? "");
  const termPremiumCents = dollarAmounts(total?.[2] ?? "")[0];
  if (!policyNumber || !periodStart || !periodEnd || termPremiumCents == null) throw new Error("GEICO declarations: no policy number, coverage period or term premium found.");
  const words = (total![1] ?? "").toLowerCase();
  const months = /six/.test(words) ? 6 : /twelve|annual|year/.test(words) ? 12 : Math.round((Date.parse(periodEnd) - Date.parse(periodStart)) / (30.44 * 86_400_000));

  const people = (start: RegExp, end: RegExp) => between(lines, start, end).filter((l) => !/^None$/i.test(l)).map(titleCase);

  const vehicles: InsuredVehicle[] = between(lines, /^Vehicle\s+VIN/, /^Coverages\*/).flatMap((l) => {
    const m = /^(\d+)\s+(\d{4})?\s*(.+?)\s*\t\s*([A-HJ-NPR-Z0-9]{17})\s*(?:\t\s*([^\t]+?))?\s*(?:\t\s*(.+?))?\s*$/.exec(l);
    return m ? [{ n: Number(m[1]), year: m[2] ? Number(m[2]) : null, make: m[3]!, vin: m[4]!, garaged: m[5] ?? null, lienholder: m[6] ?? null }] : [];
  });

  const coverages: AutoCoverage[] = [];
  let pending: string[] = [];
  for (const l of between(lines, /^Coverages\*/, /^Total [A-Za-z ]+ Premium/)) {
    const parts = l.split("\t").map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) {
      pending.push(l);
      continue;
    }
    // Trailing amounts are the premium per vehicle; what's between the label and them is the limit.
    let k = parts.length;
    while (k > 1 && new RegExp(`^${MONEY}$`).test(parts[k - 1]!) && parts.length - k < Math.max(vehicles.length, 1)) k--;
    const label = parts[0]!;
    const limit = parts.slice(1, k).join(" ") || "Included";
    const qualifier = pending.length > 0 && /^Each\b/i.test(label);
    const named = qualifier ? pending : pending.length ? [...pending, label] : [label];
    const amounts = dollarAmounts(limit);
    const ded = /\bDed\b/i.test(limit);
    coverages.push({
      code: null,
      name: named[0]! + (named.length > 1 ? ` (${named.slice(1).join(", ")})` : ""),
      per: qualifier ? label : null,
      limit,
      limitCents: ded ? [] : amounts,
      deductibleCents: ded ? (amounts[0] ?? null) : null,
      additional: false,
      premiumCents: parts.slice(k).map((p) => dollarAmounts(p)[0] ?? null),
    });
    pending = [];
  }

  const discounts = [...text.matchAll(new RegExp(`^\\s*([A-Za-z][A-Za-z &/'-]+?)[\\s.]*\\.{5,}\\s*(${MONEY}|Included)\\s*$`, "gm"))].map((m) => ({ name: m[1]!.trim(), cents: m[2] === "Included" ? null : (dollarAmounts(m[2]!)[0] ?? null) }));

  return {
    kind: "AUTO",
    insurer: insurerOf(text),
    policyNumber,
    namedInsured: people(/^Named Insured$/, /^Additional Drivers$|^Vehicle\s+VIN/),
    drivers: people(/^Additional Drivers$/, /^Vehicle\s+VIN/),
    issuedDate: parseMonthNameDate(first(/Date Issued:\s*([A-Z][a-z]+ \d{1,2}, \d{4})/, text) ?? ""),
    periodStart,
    periodEnd,
    termMonths: months,
    renewal: /^Renewal Page/m.test(text),
    termPremiumCents,
    vehicles,
    coverages,
    discounts,
    discountTotalCents: dollarAmounts(first(new RegExp(`total value of your discounts is\\s+(${MONEY})`, "i"), text) ?? "")[0] ?? null,
    contractType: first(/Contract Type:\s*(\S+)/, text) ?? null,
    amendments: first(/Contract Amendments:\s*(.+)/, text) ?? null,
    unitEndorsements: first(/Unit Endorsements:\s*(.+)/, text) ?? null,
    servicePhone: first(/Tel:\s*([\d-]{12,14})/, text) ?? null,
  };
}

export function parseGeicoRenewal(text: string): AutoRenewal {
  const policyNumber = policyNumberOf(text);
  const term = new RegExp(`Policy Term:\\s*(${SHORT_DATE})\\s*-\\s*(${SHORT_DATE})`).exec(text);
  const periodStart = parseSlashDate(term?.[1] ?? "");
  const periodEnd = parseSlashDate(term?.[2] ?? "");
  const newPremiumCents = dollarAmounts(first(new RegExp(`New Premium:\\s*(${MONEY})`), text) ?? "")[0];
  if (!policyNumber || !periodStart || !periodEnd || newPremiumCents == null) throw new Error("GEICO renewal letter: no policy number, policy term or new premium found.");
  return {
    kind: "AUTO_RENEWAL",
    insurer: insurerOf(text),
    policyNumber,
    date: parseMonthNameDate(first(/^([A-Z][a-z]+ \d{1,2}, \d{4})$/m, text) ?? ""),
    periodStart,
    periodEnd,
    newPremiumCents,
    priorPremiumCents: dollarAmounts(first(new RegExp(`Prior Premium:\\s*(${MONEY})`), text) ?? "")[0] ?? null,
  };
}

/** A packet page kept for reference: its title and form code, and the policy it belongs to when printed. */
export function parseGeicoForm(text: string): PolicyForm {
  const flat = text.replace(/\s+/g, " ");
  const contract = /([A-Z][a-z]+(?: [A-Z][a-z]+)?) Family Automobile Insurance Policy/.exec(flat);
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^(?:Renewal|New Business) Page \d+ of \d+/, "").replace(/\b[A-Z]{1,3}-?\d{2,4}[A-Z]{0,2}\s?\(\d{1,2}-\d{2}\)/g, "").replace(/\(Page \d+ of \d+\)|Page \d+ of \d+/g, "").trim());
  const heading = lines.find((l) => /^[A-Za-z][A-Za-z ,'&/-]{6,60}$/.test(l) && l.split(" ").length >= 2 && !GEICO.test(l) && !/^(Dear|One|Policy Number)/.test(l));
  return {
    kind: "FORM",
    insurer: insurerOf(text),
    line: "AUTO",
    policyNumber: policyNumberOf(text) ?? null,
    code: first(/\b([A-Z]{1,3}-?\d{2,4}[A-Z]{0,2})\s?\(\d{1,2}-\d{2}\)/, text) ?? null,
    title: contract ? `${contract[1]} Family Automobile Insurance Policy` : heading ? titleCase(heading) : "Policy page",
  };
}
