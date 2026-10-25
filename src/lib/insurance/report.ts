import { addDays, ymd } from "../dates/isoDate.ts";
import type { BillingNotice, TermPolicy } from "./types.ts";

/**
 * The Insurance page: each policy read from its packet, laid out by policy year (dates,
 * the insured's age, the guaranteed maximum premium and the face amount), with the
 * premiums found in the statements matched to the year they paid for. The packet is the
 * contract; the statements are the money. Nothing here is estimated: years past the
 * level period show the insurer's guaranteed maximum, which is what the contract
 * promises, not a forecast of what it will charge.
 */

/** A statement row that may be a premium (the Book's rows, trimmed to what matching needs). */
export type PremiumRow = { id: string; date: string; amountCents: number; payee: string; accountId: string };

/**
 * Who a premium is paid to, as card and bank statements print it: the issuing company's
 * merchant name ("AGL*INSURANCE PREMIUM"), the group's name, or the New York company.
 */
const INSURER_PAYEE = /\bAGL\b|AGL\*|AMERICAN GENERAL|COREBRIDGE|US ?LIFE INS|UNITED STATES LIFE/i;

/** A premium paid up to this many days before a due date counts toward that year (paid with the application, or early). */
const PAID_AHEAD_DAYS = 60;

export type PolicyYear = {
  year: number;
  start: string;
  end: string;
  /** The insured's age (nearest birthday, as the policy counts it) during the year. */
  age: number | null;
  maxPremiumCents: number;
  faceCents: number;
  /** Inside the level premium period: the premium is fixed, not a maximum. */
  level: boolean;
};

export type PremiumMode = { mode: string; perPaymentCents: number; payments: number; yearCents: number; extraCents: number };

export type PolicyDate = { key: string; label: string; date: string; note: string; past: boolean };

export type PolicyPayment = { rowId: string; date: string; cents: number; payee: string; accountId: string; year: number };

export type PolicyBill = { file: string; dueDate: string; premiumCents: number; mode: string | null; paidBy: string | null };

export type PolicyView = {
  file: string;
  policy: TermPolicy;
  status: "NOT_STARTED" | "IN_FORCE" | "ENDED";
  years: PolicyYear[];
  currentYear: number | null;
  /** Coverage today (the current year's face amount). */
  faceNowCents: number | null;
  nextDue: { date: string; cents: number; year: number } | null;
  /** Every premium over the level period: fixed by contract, so exact. */
  levelTotalCents: number | null;
  /** What a year costs paid each way the policy allows. */
  modes: PremiumMode[];
  /** Annual premium per $1,000 of coverage. */
  per1000Cents: number;
  dates: PolicyDate[];
  payments: PolicyPayment[];
  paidCents: number;
  bills: PolicyBill[];
};

export type InsuranceReport = { today: string; policies: PolicyView[] };

/** The same day `n` years on; Feb 29 falls back to Feb 28. */
export function addYears(iso: string, n: number): string {
  const y = Number(iso.slice(0, 4)) + n;
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return ymd(y, m, m === 2 && d === 29 && !leap ? 28 : d);
}

function policyYears(p: TermPolicy): PolicyYear[] {
  return p.schedule.map((r) => {
    const start = addYears(p.issueDate, r.year - 1);
    return {
      year: r.year,
      start,
      end: addDays(addYears(p.issueDate, r.year), -1),
      age: p.issueAge == null ? null : p.issueAge + r.year - 1,
      maxPremiumCents: r.maxPremiumCents,
      faceCents: r.faceCents,
      level: p.levelYears != null && r.year <= p.levelYears,
    };
  });
}

/** The policy year a date falls in (1 before the date of issue), or null past the table. */
function yearOf(years: PolicyYear[], date: string): number | null {
  if (!years.length) return null;
  if (date < years[0]!.start) return 1;
  return years.find((y) => date >= y.start && date <= y.end)?.year ?? null;
}

function modes(p: TermPolicy): PremiumMode[] {
  const annual = p.annualPremiumCents;
  const out: PremiumMode[] = [{ mode: "Annual", perPaymentCents: annual, payments: 1, yearCents: annual, extraCents: 0 }];
  const add = (mode: string, share: number | null, payments: number) => {
    if (share == null) return;
    const per = Math.round(annual * share);
    out.push({ mode, perPaymentCents: per, payments, yearCents: per * payments, extraCents: per * payments - annual });
  };
  add("Semi-annual", p.modal.semiannual, 2);
  add("Quarterly", p.modal.quarterly, 4);
  add("Monthly", p.modal.monthly, 12);
  return out;
}

function dates(p: TermPolicy, today: string): PolicyDate[] {
  const out: Omit<PolicyDate, "past">[] = [{ key: "issue", label: "Date of issue", date: p.issueDate, note: "Coverage starts; policy years and premium due dates count from here." }];
  if (p.requirements.respondBy && p.requirements.items.length) {
    out.push({ key: "requirements", label: "Delivery requirements due", date: p.requirements.respondBy, note: `Return: ${p.requirements.items.join("; ")}. The packet says the policy may be cancelled if they don't arrive.` });
  }
  const contest = p.contestableYears != null ? addYears(p.issueDate, p.contestableYears) : null;
  const suicide = p.suicideYears != null ? addYears(p.issueDate, p.suicideYears) : null;
  if (contest && contest === suicide) {
    out.push({ key: "contestable", label: "Contestable and suicide periods end", date: contest, note: "After this the insurer can't contest a claim over the application, and the suicide exclusion no longer applies." });
  } else {
    if (contest) out.push({ key: "contestable", label: "Contestable period ends", date: contest, note: "After this the insurer can't contest a claim over the application." });
    if (suicide) out.push({ key: "suicide", label: "Suicide exclusion ends", date: suicide, note: "Before this, a suicide pays back only the premiums." });
  }
  if (p.levelEndDate) {
    const dropsTo = p.schedule.some((r) => p.levelYears != null && r.year === p.levelYears + 1 && r.faceCents < p.faceCents);
    out.push({
      key: "level",
      label: "Level premium period ends",
      date: p.levelEndDate,
      note: dropsTo ? "Premiums stop being fixed and the face amount drops to the table's renewal amount." : "Premiums stop being fixed.",
    });
  }
  if (p.conversionExpiryDate) {
    out.push({ key: "conversion", label: "Conversion option expires", date: p.conversionExpiryDate, note: "Before this date the policy can be converted to a permanent one with no medical questions; not on or after it." });
  }
  if (p.features.reEntry && p.levelEndDate) {
    out.push({ key: "reentry", label: "Re-entry option", date: p.levelEndDate, note: "Only on this anniversary: exchange for a new level term policy at then-current rates, with new evidence of insurability." });
  }
  if (p.finalEndDate) out.push({ key: "final", label: "Coverage ends for good", date: p.finalEndDate, note: "The last renewal term ends; the policy can't be renewed past it." });
  return out.sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({ ...d, past: d.date <= today }));
}

export function buildInsuranceReport(input: {
  policies: { file: string; policy: TermPolicy }[];
  bills: { file: string; bill: BillingNotice }[];
  rows: PremiumRow[];
  today: string;
}): InsuranceReport {
  const { today } = input;
  const charges = input.rows.filter((r) => r.amountCents < 0 && INSURER_PAYEE.test(r.payee)).sort((a, b) => a.date.localeCompare(b.date));
  const many = input.policies.length > 1;
  const claimed = new Set<string>();

  const policies = input.policies.map(({ file, policy: p }): PolicyView => {
    const years = policyYears(p);
    const first = years[0];
    const last = years.at(-1);
    const status = !first || today < first.start ? "NOT_STARTED" : last && today > last.end ? "ENDED" : "IN_FORCE";
    const currentYear = status === "IN_FORCE" ? yearOf(years, today) : null;
    const current = years.find((y) => y.year === currentYear);
    const nextYear = years.find((y) => y.start > today);
    const ms = modes(p);

    // With one policy every premium to its insurer is its own; with more, only charges of one of its payment amounts.
    const amounts = new Set(ms.map((m) => m.perPaymentCents));
    const payments: PolicyPayment[] = [];
    for (const r of charges) {
      if (claimed.has(r.id) || (many && !amounts.has(-r.amountCents))) continue;
      const year = yearOf(years, addDays(r.date, PAID_AHEAD_DAYS));
      if (year == null) continue;
      claimed.add(r.id);
      payments.push({ rowId: r.id, date: r.date, cents: -r.amountCents, payee: r.payee, accountId: r.accountId, year });
    }

    const bills = input.bills
      .filter((b) => b.bill.policyNumber === p.policyNumber)
      .map(({ file: f, bill: b }): PolicyBill => {
        const year = yearOf(years, b.dueDate);
        return { file: f, dueDate: b.dueDate, premiumCents: b.premiumCents, mode: b.mode, paidBy: payments.find((x) => x.year === year)?.rowId ?? null };
      })
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

    return {
      file,
      policy: p,
      status,
      years,
      currentYear,
      faceNowCents: current?.faceCents ?? null,
      nextDue: nextYear && status !== "ENDED" ? { date: nextYear.start, cents: nextYear.maxPremiumCents, year: nextYear.year } : null,
      levelTotalCents: p.levelYears == null ? null : p.annualPremiumCents * p.levelYears,
      modes: ms,
      per1000Cents: (p.annualPremiumCents * 100_000) / p.faceCents,
      dates: dates(p, today),
      payments,
      paidCents: payments.reduce((s, x) => s + x.cents, 0),
      bills,
    };
  });
  return { today, policies };
}
