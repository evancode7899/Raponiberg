import { parseMoney, parseMonthNameDate, parseSlashDate } from "../ingest/text.ts";
import { addYears } from "./report.ts";
import type { BillingNotice, InsuranceDoc, PaymentReceipt, PolicyStatus, PremiumYear, TermPolicy } from "./types.ts";

/**
 * Reads a term life policy packet and the insurer's billing notices from their PDF text.
 * Written against the American General Life (Corebridge Financial) packet: a cover letter,
 * the delivery requirements, the contract with its policy schedule and table of premiums
 * and face amounts, the riders and the application. Protective Life's policy, policy
 * summary and emailed payment receipt have their own readers at the end. Other insurers
 * print the same facts under other words; they come back as null (or the document as not insurance) rather
 * than guessed.
 */

/** Bump when the reader changes what it reads: every insurance PDF is then read again. */
export const INSURANCE_READER_VERSION = 2;

export type InsuranceKind = "POLICY" | "BILL" | "RECEIPT" | "STATUS";

/**
 * Text with every space removed. Protective's PDFs break words at random ("Grace P eriod",
 * "S CH EDULE"), so its prose is matched with the spaces gone.
 */
const squash = (s: string) => s.replace(/\s+/g, "");
const isProtective = (squashed: string) => /ProtectiveLifeInsuranceCompany/i.test(squashed);

/** Whether the text is a policy packet, a billing notice, a payment receipt or a policy summary, from words every one of them prints. */
export function insuranceKind(text: string): InsuranceKind | null {
  if (/POLICY SCHEDULE/.test(text) && /TABLE OF PREMIUMS AND FACE AMOUNTS/i.test(text) && /Face Amount/i.test(text)) return "POLICY";
  if (/Notice of Payment Due/i.test(text) && /Policy Number/i.test(text) && /Insurance/i.test(text)) return "BILL";
  const sq = squash(text);
  if (isProtective(sq) && /SCHEDULEOFGUARANTEEDANNUALPREMIUMSANDFACEAMOUNTS/i.test(sq)) return "POLICY";
  if (isProtective(sq) && /PolicySummary/.test(sq) && /PaidtoDateofPolicy:/i.test(sq)) return "STATUS";
  if (/@protective\.com/i.test(text) && /Thankyouforyourrecentpayment/i.test(sq) && /PolicyNumber:/.test(sq) && /PaymentAmount:/.test(sq)) return "RECEIPT";
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
  if (kind === "POLICY") return /POLICY SCHEDULE/.test(text) ? parsePolicy(text) : parseProtectivePolicy(text);
  if (kind === "BILL") return parseBill(text);
  if (kind === "RECEIPT") return parseProtectiveReceipt(text);
  if (kind === "STATUS") return parseProtectiveSummary(text);
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
    conversionThroughExpiry: false,
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

// ---------------------------------------------------------------------------- Protective Life

const PROTECTIVE = "Protective Life Insurance Company";
/** "OCTOBER 20, 2026" (the schedule) or "October 20, 2026" (the summary sheet). */
const ANY_DATE = String.raw`[A-Za-z]+ \d{1,2}, \d{4}`;
const DOLLARS = String.raw`\$[\d,]+(?:\.\d{2})?`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Money with or without cents: the schedule prints face amounts whole ("$500,000"). */
const anyMoney = (s: string | undefined) => (s != null && /^\$?[\d,]+$/.test(s) ? Number(s.replace(/[$,]/g, "")) * 100 : money(s));

/**
 * A Protective Life policy as delivered electronically: a summary sheet, the contract
 * with its policy schedule (page S1) and schedule of guaranteed annual premiums and face
 * amounts (page S2), its endorsements, and a statement of policy cost. The schedule
 * pages print their values in one block ahead of their labels, so they're read by
 * position; the contract's prose is read with the spaces squashed out.
 */
export function parseProtectivePolicy(text: string): TermPolicy {
  const flat = text.replace(/\s+/g, " ");
  const sq = squash(text);
  // Page S1: number, insured, age, sex, class; effective, end and conversion dates; face
  // and minimum face; owner and state department of insurance; the benefit line; the
  // policy fee; then the total premium per payment and per year, annual, semi-annual,
  // quarterly, monthly.
  const s1 = new RegExp(
    `([A-Z]{0,3}\\d{5,}) ([A-Z][A-Z .'-]*?) (\\d{1,3}) (?:MALE|FEMALE) (.+?) (${ANY_DATE}) (${ANY_DATE}) (${ANY_DATE}) (${DOLLARS}) ${DOLLARS} OWNER: (.+?) \\(\\d{3}\\) \\d{3}-\\d{4} .+? ${DOLLARS} ${DOLLARS} \\* (\\d+) YEARS (${DOLLARS}) (${DOLLARS}) (${DOLLARS}) (${DOLLARS}) (${DOLLARS}) ${DOLLARS} ${DOLLARS} ${DOLLARS} ${DOLLARS} \\S+ PAGE S1`,
  ).exec(flat);
  if (!s1) throw new Error("Policy schedule not found: no policy number, date of issue, face amount, premium or insured on page S1.");
  const [, policyNumber, insuredRaw, age, premiumClass, effective, end, conversion, faceRaw, ownerAndState, levelYearsRaw, feeRaw, annualRaw, semiRaw, quarterlyRaw, monthlyRaw] = s1 as unknown as string[];
  const issueDate = parseMonthNameDate(effective!);
  const faceCents = anyMoney(faceRaw);
  const annualPremiumCents = anyMoney(annualRaw);
  if (!issueDate || faceCents == null || !annualPremiumCents) throw new Error("Policy schedule not found: no date of issue, face amount or premium on page S1.");
  const insured = titleCase(insuredRaw!.trim());
  const issueAge = Number(age);
  const levelYears = Number(levelYearsRaw);

  // The summary sheet prints the insured then the owner, run together: the owner is what follows the insured.
  const sheet = new RegExp(`${DOLLARS} (Annually|Semi-?annually|Quarterly|Monthly) ${DOLLARS} \\d+ Years \\d+ Years .+? ${ANY_DATE} ${ANY_DATE} (.+?) \\d{1,3} (?:Male|Female) `, "i").exec(flat);
  const names = sheet?.[2]?.trim() ?? "";
  const owner = names.toLowerCase().startsWith(`${insured.toLowerCase()} `) ? titleCase(names.slice(insured.length + 1)) : null;
  // Page S1 runs the owner into the state whose department of insurance oversees the policy.
  const state = owner && ownerAndState!.toLowerCase().startsWith(`${owner.toLowerCase()} `) ? titleCase(ownerAndState!.slice(owner.length + 1).trim()) : null;

  // Page S2, two columns of year, age, premium, face: a row whose age doesn't follow from its year is something else.
  const s2Start = flat.indexOf("PAGE S1");
  const s2End = flat.indexOf("PAGE S2");
  const s2 = flat.slice(s2Start, s2End > s2Start ? s2End : undefined);
  const byYear = new Map<number, PremiumYear>();
  for (const m of s2.matchAll(/(?:^| )(\d{1,3}) (\d{1,3}) \$?([\d,]+\.\d{2}) \$?([\d,]{5,})(?= |$)/g)) {
    const year = Number(m[1]);
    const maxPremiumCents = anyMoney(m[3]!);
    const rowFace = anyMoney(m[4]!);
    if (year >= 1 && Number(m[2]) === issueAge + year - 1 && maxPremiumCents != null && rowFace != null) byYear.set(year, { year, maxPremiumCents, faceCents: rowFace });
  }

  // Paying other than yearly, as a share of the annual premium, from the schedule's own
  // per-payment amounts: the round factor (52%) when it gives the printed amount back.
  const share = (s: string | undefined) => {
    const c = money(s);
    if (c == null) return null;
    const round = Math.round((c / annualPremiumCents) * 10_000) / 10_000;
    return Math.round(annualPremiumCents * round) === c ? round : c / annualPremiumCents;
  };
  const accelerated = /Thelesserof(\d+)%ofthecurrentfaceamountofthePolicyor(\$[\d,]+)/i.exec(sq);
  // The statement of policy cost names the owner, then the agent, then their street addresses.
  const agent = owner ? new RegExp(`${escapeRe(owner.toUpperCase())} ([A-Z][A-Z.' -]*?[A-Z]) \\d+ [A-Z]`).exec(flat)?.[1] : undefined;

  return {
    kind: "TERM_LIFE",
    insurer: PROTECTIVE,
    brand: null,
    product: null,
    policyNumber: policyNumber!,
    insured,
    owner,
    state,
    issueDate,
    issueAge,
    premiumClass: titleCase(premiumClass!.trim()),
    faceCents,
    annualPremiumCents,
    policyFeeCents: money(feeRaw),
    levelYears,
    levelEndDate: addYears(issueDate, levelYears),
    finalEndDate: parseMonthNameDate(end!),
    conversionExpiryDate: parseMonthNameDate(conversion!),
    conversionThroughExpiry: /OnorbeforetheStandardLatestConversionDate/i.test(sq),
    conversionMinFaceCents: null,
    features: {
      renewable: /RENEWABLETERMCOVERAGE/i.test(sq),
      convertible: /POLICYISCONVERTIBLE/i.test(sq),
      reEntry: false,
      participating: !/NON-?PARTICIPATING/i.test(sq),
    },
    modal: { semiannual: share(semiRaw), quarterly: share(quarterlyRaw), monthly: share(monthlyRaw) },
    schedule: [...byYear.values()].sort((a, b) => a.year - b.year),
    riders: /TERMINALILLNESSACCELERATEDDEATHBENEFITENDORSEMENT/i.test(sq)
      ? [
          {
            name: "Terminal Illness Accelerated Death Benefit Endorsement",
            terms: accelerated ? [{ label: "Most paid early", value: `${accelerated[1]}% of the face amount, up to ${accelerated[2]}` }] : [],
          },
        ]
      : [],
    graceDays: count(first(/A(\d+)-dayGracePeriod/i, sq)),
    freeLookDays: count(first(/within\w*?\((\d+)\)daysafteritisfirstdelivered/i, sq)),
    contestableYears: count(first(/inforcefor(\w+?)yearsduringthelifeoftheInsured/i, sq)),
    suicideYears: count(first(/commitssuicidewithin(\w+?)years?of/i, sq)),
    paymentOptionsRate: null,
    billing: { frequency: sheet?.[1] ?? null, type: null },
    requirements: { items: [], respondBy: null },
    agent: agent ? titleCase(agent) : null,
    servicePhone: first(/Birmingham, Alabama \d{5}; (\(\d{3}\) \d{3}-\d{4})/, flat) ?? null,
    // The statement of policy cost is dated the day the policy was printed.
    packetDate: parseMonthNameDate(first(new RegExp(`${escapeRe(policyNumber!)} (${ANY_DATE}) 1 \\$`), flat) ?? ""),
  };
}

/** Protective's policy summary: the current premium and mode, and the date premiums are paid to, as of a day. */
export function parseProtectiveSummary(text: string): PolicyStatus {
  const flat = text.replace(/\s+/g, " ");
  const policyNumber = first(/Policy Number:\s*([A-Z0-9-]{5,})/, flat);
  const asOf = parseSlashDate(first(/as of (\d{1,2}\/\d{1,2}\/\d{4})/i, flat) ?? "");
  if (!policyNumber || !asOf) throw new Error("Policy summary: no policy number or as-of date found.");
  return {
    kind: "STATUS",
    insurer: PROTECTIVE,
    policyNumber,
    asOf,
    paidToDate: parseSlashDate(first(/Paid to Date of Policy:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i, flat) ?? ""),
    premiumCents: money(first(new RegExp(`Current Premium Amount:\\s*(${AMOUNT})`, "i"), flat)),
    mode: first(/Mode of Payment:\s*([A-Za-z-]+)/i, flat) ?? null,
  };
}

/** Protective's emailed "Thank you for your recent payment": the policy, the day, the amount and the confirmation number. */
export function parseProtectiveReceipt(text: string): PaymentReceipt {
  const flat = text.replace(/\s+/g, " ");
  const policyNumber = first(/Policy Number:\s*([A-Z0-9-]{5,})/, flat);
  const date = parseMonthNameDate(first(new RegExp(`payable to .+? on (${DATE}) for the following polic`, "i"), flat) ?? "");
  const amountCents = money(first(new RegExp(`Payment Amount:\\s*(${AMOUNT})`), flat));
  if (!policyNumber || !date || amountCents == null) throw new Error("Payment receipt: no policy number, payment date or amount found.");
  return {
    kind: "RECEIPT",
    insurer: PROTECTIVE,
    policyNumber,
    date,
    amountCents,
    confirmation: first(/Confirmation Number:\s*([A-Z0-9]+)/, flat) ?? null,
    method: first(/electronic payment from your (.+?) that is payable/i, flat) ?? null,
  };
}
