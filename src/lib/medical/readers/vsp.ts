import { cents, zeroTotals } from "../parse.ts";
import type { EobClaim, EobLine, EobStatement } from "../types.ts";

/**
 * VSP's Vision Benefit Statement: one claim, each service line with seven amounts in a
 * fixed order (billed, discounts, not covered, allowed, copay/coinsurance, other insurance,
 * paid) and a status (PD paid, DN denied). What you owe on a line is its copay or
 * coinsurance plus what isn't covered. The first page prints the claim's totals (billed,
 * paid, your costs), which the lines are held to. VSP prints no deductible or
 * out-of-pocket limit ("Not Applicable"), so a vision statement has no balances.
 */

export const isVspEob = (text: string) => /Vision Benefit Statement/i.test(text) && /\bVSP\b|Vision Service Plan/.test(text);

const M = String.raw`\$\s?(-?[\d,]*\.\d{2})`;
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const usDate = (s: string) => {
  const m = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(s.trim());
  if (!m) throw new Error(`Unreadable date "${s}"`);
  return `${m[3]}-${m[1]}-${m[2]}`;
};

function lineOf(entry: string): EobLine {
  const m = new RegExp(String.raw`^(\d{2}-\d{2}-\d{4}) (\S+) (.*?) ${M} ${M} ${M} ${M} ${M} ${M} ${M} (PD|DN|[A-Z]{2})\b ?(.*)$`).exec(entry);
  if (!m) throw new Error(`Unreadable vision service line "${entry}"`);
  const [billed, discount, notCovered, allowed, copay, other, paid] = m.slice(4, 11).map((x) => cents(x!));
  void discount;
  return {
    ...zeroTotals(),
    service: m[3]!.trim(),
    code: m[2]!,
    date: usDate(m[1]!),
    dateTo: null,
    remarks: [],
    billedCents: billed!,
    memberRateCents: allowed!,
    pendingCents: notCovered!,
    copayCents: copay!,
    remainingCents: allowed! - copay!,
    planCents: paid!,
    yourShareCents: copay! + notCovered!,
    ...(m[11] !== "PD" || other ? { note: [m[11] === "DN" ? "Denied" : m[11] !== "PD" ? m[11] : "", other ? `other insurance paid ${(other / 100).toFixed(2)}` : "", m[12]?.trim()].filter(Boolean).join("; ") } : {}),
  };
}

export function parseVspEob(text: string): EobStatement {
  const flat = squash(text);
  const notice = /Date of Notice: (\d{2}\/\d{2}\/\d{4})/.exec(flat)?.[1];
  const claimNo = /Claim #: (\S+)/.exec(flat)?.[1];
  const name = /Name: (.+?) Case Number:/.exec(flat)?.[1];
  const provider = /Provider: (.+?)(?= Total Amount| Practice Name|$)/.exec(flat)?.[1]?.trim();
  if (!notice || !claimNo || !name || !provider) throw new Error("No notice date, claim, patient or provider");
  const rel = /Relationship: (\S+)/.exec(flat)?.[1] ?? null;
  const network = /Network: (In|Out of) Network/.exec(flat)?.[1];

  // The header's words wrap onto lines of their own ("Remark" / "Code**"): read from the flattened text.
  const block = /Remark Code\*\*(.*?)Interest Paid:/.exec(flat)?.[1];
  if (!block) throw new Error("No service lines");
  const entries = squash(block).split(/(?=\b\d{2}-\d{2}-\d{4} [A-Z0-9]{5}\b)/).map((s) => s.trim()).filter(Boolean);
  const lines = entries.map(lineOf);
  const interest = new RegExp(`Interest Paid: ${M}`).exec(flat);

  const printed = (re: RegExp) => {
    const m = re.exec(flat);
    return m ? cents(m[1]!) : null;
  };
  const billed = printed(new RegExp(`Total Amount Billed: ${M}`));
  const paid = printed(new RegExp(`Total Amount Paid: ${M}`));
  const costs = printed(new RegExp(`Your Costs:.*?${M}`));
  if (billed == null || paid == null || costs == null) throw new Error("No claim totals");
  const sum = (k: keyof EobLine) => lines.reduce((s, l) => s + (l[k] as number), 0);
  const [id, suffix] = claimNo.split("-");
  const patient = name.trim().split(/\s+/)[0]!;
  const claim: EobClaim = {
    id: claimNo,
    baseId: id!,
    version: suffix ? Number(suffix) || 0 : 0,
    patient,
    relationship: rel ? (/^(member|self|subscriber)$/i.test(rel) ? "self" : rel.toLowerCase()) : null,
    provider,
    inNetwork: network ? network === "In" : null,
    received: null,
    lines,
    // The printed totals: billed, paid and your costs; the rest add from the lines.
    totals: { ...zeroTotals(), billedCents: billed, planCents: paid, yourShareCents: costs, memberRateCents: sum("memberRateCents"), pendingCents: sum("pendingCents"), copayCents: sum("copayCents"), remainingCents: sum("remainingCents") },
    alreadyPaidCents: 0,
    interestCents: interest ? cents(interest[1]!) : 0,
    cob: null,
    remarks: {},
  };
  return {
    kind: "EOB",
    coverage: "VISION",
    insurer: "VSP",
    plan: /Name of Plan: (.+?) For Inquiries/.exec(flat)?.[1]?.trim() ?? "VSP",
    sponsor: null,
    group: null,
    statementDate: usDate(notice),
    claims: [claim],
    payments: [{ patient, relationship: claim.relationship, provider, planCents: paid, sentTo: provider, sentOn: null, yourShareCents: costs }],
    balancesFrom: null,
    balancesTo: null,
    balances: [],
  };
}
