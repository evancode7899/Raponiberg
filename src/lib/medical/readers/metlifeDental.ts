import { cents, longDate, zeroTotals } from "../parse.ts";
import type { EobBalance, EobClaim, EobLine, EobStatement } from "../types.ts";

/**
 * MetLife's Explanation of Dental Benefits: one claim per statement. The plain text keeps
 * each service line's amounts in order (submitted, negotiated fee, allowed amount, the share
 * MetLife pays, what it paid, a deductible note, what you owe), so no positions are needed:
 * a line MetLife doesn't cover prints the submitted and negotiated fees, its reason, and
 * what you owe. The plan overview prints the patient's deductible and annual maximum as
 * "remaining"/"available" against the limit; MetLife prints no period for them, so they
 * count for the calendar year of the service (group dental maximums run by calendar year).
 */

export const isMetLifeDentalEob = (text: string) => /Explanation of Dental Benefits/i.test(text) && /MetLife|Metropolitan Life/i.test(text);

const M = String.raw`\$\s?(-?[\d,]*\.\d{2})`;
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const firstName = (full: string) => full.trim().split(/\s+/)[0]!;
const relation = (r: string) => (/^(self|member|subscriber|employee)$/i.test(r.trim()) ? "self" : r.trim().toLowerCase());

/** A label's value: MetLife prints "Label" then its value on the next line. */
function field(text: string, label: string): string | null {
  const m = new RegExp(String.raw`(?:^|\n)${label}\s*\n([^\n]+)`).exec(text);
  return m ? m[1]!.trim() : null;
}

function lineOf(entry: string): EobLine {
  const head = /^(\d{2})\/(\d{2})\/(\d{2}) (D\d{4}),\s*(.*)$/.exec(entry);
  if (!head) throw new Error(`Unreadable dental service line "${entry}"`);
  const date = `20${head[3]}-${head[1]}-${head[2]}`;
  const rest = head[5]!;
  const firstAmount = rest.search(/\$\s?[\d,]*\.\d{2}/);
  if (firstAmount < 0) throw new Error(`A dental service line without amounts "${entry}"`);
  const service = rest.slice(0, firstAmount).trim();
  const tail = rest.slice(firstAmount);
  const amounts = [...tail.matchAll(new RegExp(`${M}( applied to deductible\\.?)?`, "g"))].map((m) => ({ cents: cents(m[1]!), deductible: !!m[2], at: m.index! }));
  const pct = /(\d{1,3})%/.exec(tail);
  const owe = amounts.at(-1)!;
  const line: EobLine = { ...zeroTotals(), service, code: head[4]!, date, dateTo: null, remarks: [], billedCents: amounts[0]!.cents };
  if (pct) {
    // Covered: submitted, negotiated, allowed, [share], paid, [deductible], you owe.
    if (amounts.length < 5) throw new Error(`A covered dental line with too few amounts "${entry}"`);
    const ded = amounts.find((a) => a.deductible)?.cents ?? 0;
    line.memberRateCents = amounts[2]!.cents;
    line.planCents = amounts[3]!.cents;
    line.deductibleCents = ded;
    line.remainingCents = line.memberRateCents - ded;
    line.yourShareCents = owe.cents;
    line.coinsuranceCents = owe.cents - ded;
    if (line.planCents + line.yourShareCents !== line.memberRateCents) throw new Error(`Dental line ${line.code} on ${date}: paid and owed don't add to the allowed amount`);
  } else {
    // Not covered: submitted, negotiated, the reason, you owe.
    if (amounts.length < 3) throw new Error(`A dental line with too few amounts "${entry}"`);
    line.pendingCents = owe.cents;
    line.yourShareCents = owe.cents;
    const why = squash(tail.slice(amounts[1]!.at, owe.at).replace(new RegExp(M), ""));
    if (why) line.note = why;
  }
  return line;
}

export function parseMetLifeDentalEob(text: string): EobStatement {
  const processed = field(text, "Date processed");
  if (!processed) throw new Error("No date processed");
  const who = field(text, "Name/Relationship");
  const claimId = field(text, "Claim");
  const dentist = field(text, "Dentist");
  if (!who || !claimId || !dentist) throw new Error("No patient, claim or dentist");
  const [patientName, rel] = who.split("/");
  const patient = firstName(patientName!);

  const detail = /Claim detail([\s\S]*?)\bTotals\S*\s+([^\n]+)/.exec(text);
  if (!detail) throw new Error("No claim detail");
  const body = squash(detail[1]!.replace(/^[\s\S]*?You owe your\s+dentist/, ""));
  const entries = body.split(/(?=\b\d{2}\/\d{2}\/\d{2} D\d{4},)/).map((s) => s.trim()).filter(Boolean);
  const lines = entries.map(lineOf);
  const t = [...detail[2]!.matchAll(new RegExp(M, "g"))].map((m) => cents(m[1]!));
  if (t.length !== 5) throw new Error(`Unreadable totals row "${detail[2]}"`);
  const sum = (k: keyof EobLine) => lines.reduce((s, l) => s + (l[k] as number), 0);
  const totals = { ...zeroTotals(), billedCents: t[0]!, memberRateCents: t[2]!, planCents: t[3]!, yourShareCents: t[4]!, pendingCents: sum("pendingCents"), deductibleCents: sum("deductibleCents"), remainingCents: sum("remainingCents"), coinsuranceCents: sum("coinsuranceCents"), copayCents: 0 };

  const id = squash(claimId);
  const claim: EobClaim = {
    id,
    baseId: id,
    version: 0,
    patient,
    relationship: rel ? relation(rel) : null,
    provider: dentist,
    inNetwork: /part of the Preferred Dentist Program/i.test(text) ? true : /not (?:part of|in) the Preferred Dentist Program|out-of-network/i.test(text) ? false : null,
    received: null,
    lines,
    totals,
    alreadyPaidCents: 0,
    interestCents: 0,
    cob: null,
    remarks: {},
  };

  const year = lines.map((l) => l.date).sort()[0]!.slice(0, 4);
  const balances: EobBalance[] = [];
  for (const block of squash(text).split(/(?=\b(?:Individual|Family) - )/).slice(1)) {
    const holder = /^(Individual|Family) - ([^/]+)/.exec(block);
    const person = holder?.[1] === "Family" ? null : holder ? firstName(holder[2]!) : null;
    const ded = new RegExp(`Plan deductible ${M} remaining ${M} deductible`).exec(block);
    const max = new RegExp(`Plan maximum ${M} available ${M} maximum`).exec(block);
    const row = (kind: EobBalance["kind"], m: RegExpExecArray) => ({ person, benefit: "Dental", inNetwork: true, kind, limitCents: cents(m[2]!), usedCents: cents(m[2]!) - cents(m[1]!), remainingCents: cents(m[1]!), includesPharmacy: false });
    if (ded) balances.push(row("DEDUCTIBLE", ded));
    if (max) balances.push(row("ANNUAL_MAXIMUM", max));
    if (ded || max) break; // the overview prints once; the rest of the text repeats names
  }

  const summary = (label: string) => {
    const m = new RegExp(`${label} ${M}`).exec(squash(text));
    return m ? cents(m[1]!) : null;
  };
  const plan = summary("MetLife paid your dentist");
  const owe = summary("You owe your dentist");
  return {
    kind: "EOB",
    coverage: "DENTAL",
    insurer: "MetLife",
    plan: "MetLife Dental (PDP)",
    sponsor: field(text, "Employer"),
    group: field(text, "Group"),
    statementDate: longDate(processed),
    claims: [claim],
    payments: plan != null && owe != null ? [{ patient, relationship: claim.relationship, provider: dentist, planCents: plan, sentTo: dentist, sentOn: null, yourShareCents: owe }] : [],
    balancesFrom: balances.length ? `${year}-01-01` : null,
    balancesTo: balances.length ? `${year}-12-31` : null,
    balances,
  };
}
