import { parseMoney, parseMonthNameDate } from "../ingest/text.ts";
import type { BillingNotice, InsuranceDoc, PremiumYear, TermPolicy } from "./types.ts";

/**
 * Reads a term life policy packet and the insurer's billing notices from their PDF text.
 * Written against the American General Life (Corebridge Financial) packet: a cover letter,
 * the delivery requirements, the contract with its policy schedule and table of premiums
 * and face amounts, the riders and the application. Other insurers print the same facts
 * under other words; they come back as null (or the document as not insurance) rather
 * than guessed.
 */

/** Bump when the reader changes what it reads: every insurance PDF is then read again. */
export const INSURANCE_READER_VERSION = 1;

export type InsuranceKind = "POLICY" | "BILL";

/** Whether the text is a policy packet or a billing notice, from words every one of them prints. */
export function insuranceKind(text: string): InsuranceKind | null {
  if (/POLICY SCHEDULE/.test(text) && /TABLE OF PREMIUMS AND FACE AMOUNTS/i.test(text) && /Face Amount/i.test(text)) return "POLICY";
  if (/Notice of Payment Due/i.test(text) && /Policy Number/i.test(text) && /Insurance/i.test(text)) return "BILL";
  return null;
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, sixty: 60 };
const count = (s: string | undefined) => (s == null ? null : /^\d+$/.test(s) ? Number(s) : (NUMBER_WORDS[s.toLowerCase()] ?? null));
const money = (s: string | undefined) => (s == null ? null : parseMoney(s));
const pct = (s: string | undefined) => (s == null ? null : Math.round(Number(s) * 100) / 10_000);
const DATE = String.raw`[A-Z][a-z]+\.? \d{1,2}, \d{4}`;
const AMOUNT = String.raw`\$[\d,]+\.\d{2}`;
/** Title case for names printed in capitals ("PAT EXAMPLE" → "Pat Example"). */
const titleCase = (s: string) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s);

function first(re: RegExp, text: string): string | undefined {
  return re.exec(text)?.[1]?.trim();
}

export function parseInsuranceDoc(text: string): InsuranceDoc {
  const kind = insuranceKind(text);
  if (kind === "POLICY") return parsePolicy(text);
  if (kind === "BILL") return parseBill(text);
  throw new Error("Not a life insurance policy or billing notice.");
}

export function parsePolicy(text: string): TermPolicy {
  // Most facts wrap across lines in the extracted text; one run of spaces reads them whole.
  const flat = text.replace(/\s+/g, " ");
  const policyNumber = first(/Policy Number:\s*([A-Z0-9-]{5,})/, text);
  const issueDate = parseMonthNameDate(first(new RegExp(`Date of Issue:\\s*(${DATE})`), text) ?? "");
  const faceCents = money(first(new RegExp(`Initial Face Amount:\\s*(${AMOUNT})`), text));
  const annualPremiumCents =
    money(first(new RegExp(`first Annual premium is (${AMOUNT})`), flat)) ?? money(first(new RegExp(`Total Initial Annual Premium:\\s*(${AMOUNT})`), flat));
  const insured = first(/^Insured:\s*(.+?)(?:\s+Policy Number:.*)?$/m, text);
  if (!policyNumber || !issueDate || faceCents == null || annualPremiumCents == null || !insured) {
    throw new Error("Policy schedule not found: no policy number, date of issue, face amount, premium or insured.");
  }

  const insurer = first(/\b(American General Life Insurance Company|The United States Life Insurance Company in the City of New York)\b/, flat) ?? first(/Policies issued by ([A-Z][A-Za-z ]+?Insurance Company)/, flat) ?? "Unknown insurer";
  const states = [...text.matchAll(/This Is A ([A-Z][A-Za-z ]+?) Policy/g)].map((m) => m[1]!).filter((s) => !/Sex Distinct|Unisex/i.test(s));

  return {
    kind: "TERM_LIFE",
    insurer,
    brand: /Corebridge Financial/.test(flat) ? "Corebridge Financial" : null,
    product: first(/Product Name:\s*(.+)/, text) ?? null,
    policyNumber,
    insured: titleCase(insured),
    owner: ((o) => (o ? titleCase(o) : null))(first(/^Owner:\s*(.+)$/m, text)),
    state: states[0] ?? null,
    issueDate,
    issueAge: count(first(/Insurance Age:\s*(\d+)/, text)),
    premiumClass: first(/Premium Class:\s*(.+)/, text) ?? null,
    faceCents,
    annualPremiumCents,
    policyFeeCents: money(first(new RegExp(`policy fee of (${AMOUNT})`), flat)),
    levelYears: count(first(/(\d+) YEAR LEVEL PREMIUM PERIOD/i, flat)),
    levelEndDate: parseMonthNameDate(first(new RegExp(`(${DATE}) is the Termination Date of the Level Premium Period`), flat) ?? ""),
    finalEndDate: parseMonthNameDate(first(new RegExp(`(${DATE}) is the Termination Date of the Last Renewal Term Period`), flat) ?? ""),
    conversionExpiryDate: parseMonthNameDate(first(new RegExp(`Conversion Expiry Date is (${DATE})`), flat) ?? ""),
    conversionMinFaceCents: money(first(new RegExp(`Minimum Face Amount required for this policy after conversion is (${AMOUNT})`), flat)),
    features: {
      renewable: /\bRENEWABLE\b/.test(flat),
      convertible: /\bCONVERTIBLE\b/.test(flat),
      reEntry: /RE-ENTRY OPTION/.test(flat),
      participating: !/NONPARTICIPATING/.test(flat),
    },
    modal: {
      semiannual: pct(first(/Semi-annual:\s*([\d.]+)%/, text)),
      quarterly: pct(first(/Quarterly:\s*([\d.]+)%/, text)),
      monthly: pct(first(/Monthly[^:\n]*:\s*([\d.]+)%/, text)),
    },
    schedule: premiumTable(text),
    riders: riders(text),
    graceDays: count(first(/Grace Period is the (\d+)-day/, flat)),
    freeLookDays: count(first(/return this policy within (\w+)\*? days/, flat)),
    contestableYears: count(first(/Incontestability\..*?in force during the Insured's lifetime for (\w+) years from the Date of Issue/, flat)),
    suicideYears: count(first(/Suicide Exclusion\. If the Insured takes his or her own life, while sane or insane, within (\w+) years? from the Date of Issue/, flat)),
    paymentOptionsRate: pct(first(/Payment Options Guaranteed Interest Rate:\s*([\d.]+)%/, text)),
    billing: { frequency: first(/Billing Frequency:\s*(.+)/, text) ?? null, type: first(/Billing Type:\s*(.+)/, text) ?? null },
    requirements: {
      items: ((block) => (block ? block.split(/\n/).map((l) => l.trim()).filter(Boolean) : []))(first(/Signatures Required:\s*\n([\s\S]*?)\n\s*Total Modal Premium Due/, text)),
      respondBy: parseMonthNameDate(first(new RegExp(`please respond by (${DATE})`, "i"), flat) ?? ""),
    },
    agent: ((a) => (a ? titleCase(a) : null))(first(/^AGENT:\s*(.+)$/m, text)),
    servicePhone: first(/Contact Center at ([\d-]{12,14}) \(Life Insurance\)/, flat) ?? null,
    packetDate: parseMonthNameDate(first(new RegExp(`^(${DATE})$`, "m"), text) ?? ""),
  };
}

/**
 * The table of premiums and face amounts: "year $premium $face" triples, one or two to a
 * line depending on how the PDF's columns came out, read up to its closing footnote. The
 * heading also shows up in the contract's index and the schedule's cross-references, so
 * the occurrence that holds the most rows is the table.
 */
function premiumTable(text: string): PremiumYear[] {
  let best: PremiumYear[] = [];
  for (const heading of text.matchAll(/TABLE OF PREMIUMS AND FACE AMOUNTS/gi)) {
    const rest = text.slice(heading.index! + heading[0].length);
    const end = rest.search(/See Right To Change Premium|Premium Payment Interval/i);
    const block = end < 0 ? rest : rest.slice(0, end);
    const byYear = new Map<number, PremiumYear>();
    for (const m of block.matchAll(/(?:^|\s)(\d{1,3})\s+(\$[\d,]+\.\d{2})\s+(\$[\d,]+\.\d{2})/g)) {
      const year = Number(m[1]);
      const maxPremiumCents = parseMoney(m[2]!);
      const faceCents = parseMoney(m[3]!);
      if (year >= 1 && year <= 120 && maxPremiumCents != null && faceCents != null) byYear.set(year, { year, maxPremiumCents, faceCents });
    }
    if (byYear.size > best.length) best = [...byYear.values()].sort((a, b) => a.year - b.year);
  }
  return best;
}

/** Riders on the schedule, with the terms printed under each ("Terminal Illness Percentage: 50.00%"). */
function riders(text: string): TermPolicy["riders"] {
  const out: TermPolicy["riders"] = [];
  const schedule = /SCHEDULE OF BENEFITS AND PREMIUMS([\s\S]*?)Total Initial Annual Premium/i.exec(text)?.[1] ?? "";
  for (const m of schedule.matchAll(/^(.*\bRider)\s*$/gm)) {
    const after = schedule.slice(m.index! + m[0].length);
    const terms = [...after.matchAll(/^\s*([A-Z][A-Za-z ]+):\s*([$\d,.]+%?)\s*$/gm)]
      .filter((t) => !/Rider/.test(t[1]!))
      .map((t) => ({ label: t[1]!.trim(), value: t[2]!.trim() }));
    out.push({ name: m[1]!.trim(), terms });
  }
  return out;
}

export function parseBill(text: string): BillingNotice {
  const flat = text.replace(/\s+/g, " ");
  // "2025-03-15 $812.00 001 9900011122 Annual": due date, premium, company code, policy number, mode.
  const row = /(\d{4}-\d{2}-\d{2})\s+(\$[\d,]+\.\d{2})\s+\d{3}\s+([A-Z0-9-]{5,})\s+(Annual|Semi-?annual|Quarterly|Monthly)?/i.exec(flat);
  const premiumCents = row ? parseMoney(row[2]!) : null;
  if (!row || premiumCents == null) throw new Error("Billing notice: no due date, premium and policy number found.");
  return {
    kind: "BILL",
    insurer: first(/Premiums are payable to the ([A-Z][A-Za-z ]+?Insurance Company)/, flat) ?? null,
    policyNumber: row[3]!,
    preparedDate: first(/Prepared Date:\s*(\d{4}-\d{2}-\d{2})/, flat) ?? null,
    dueDate: row[1]!,
    premiumCents,
    mode: row[4] ?? null,
  };
}
