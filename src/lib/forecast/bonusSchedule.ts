import type { AwardLetter } from "../bonuses/awardStore.ts";
import type { BonusesReport } from "../book/reports/bonuses.ts";
import type { BonusEstimates } from "../profile/settings.ts";
import { grow } from "../profile/outlook.ts";

/**
 * Every bonus the forecast pays, dated to the month, in three kinds:
 *
 * - PAID: bonus lines on pay stubs dated after the forecast's starting point (real money
 *   the starting balances don't include yet).
 * - LETTER: payments an award letter schedules that haven't come due on the stubs yet
 *   (deferred tranches still vesting).
 * - ESTIMATE: awards no letter or stub shows yet — a share of that year's base salary,
 *   paid on the pattern of the person's latest letter from their current employer (or in
 *   their usual bonus month when there's no letter). Whether these count, and from when, is
 *   the owner's choice (`BonusEstimates`).
 *
 * The part of an award that goes into a deferred compensation plan is listed but never
 * counted: the plan has no statements, so it isn't in net worth. Pure; money is cents.
 */

export type BonusSource = "PAID" | "LETTER" | "ESTIMATE";

/** A letter's payment still to come, per person. */
/** `window`: the letter's vesting window it is paid in (the Bonuses report's window key), so it can link to its proof. */
export type LetterPayment = { personId: string; employer: string; key: string; gross: number; label: string; window?: string };

/** How a person's award is paid out, as a share of the award: month offsets count from January of the year after the award year (2 = February). */
export type BonusPattern = {
  personId: string;
  employer: string;
  /** The award the pattern was read from. */
  fromYear: number;
  /** Latest award year on the letter: estimates start the year after. */
  lastAwardYear: number;
  parts: { offset: number; share: number; plan: boolean; label: string }[];
};

/** The facts about bonuses the forecast stands on, built on the server from the Book and the letters file. */
export type BonusFacts = { scheduled: LetterPayment[]; patterns: BonusPattern[] };

export type ScheduledBonus = {
  key: string;
  personId: string;
  personName: string;
  source: BonusSource;
  gross: number;
  /** In the forecast (false: listed for reference — near-term estimates switched off, or deferred into an untracked plan). */
  counted: boolean;
  label: string;
  /** Why it isn't counted. */
  why?: string;
  /** ESTIMATE: the award year it's part of. */
  awardYear?: number;
  /** LETTER: the letter's vesting window it is paid in (the Bonuses report's window key). */
  window?: string;
  /** PAID: the stub's pay date. */
  date?: string;
  /** ESTIMATE on a letter's pattern: the share of the award this payment is (its label says it as a percent). */
  share?: number;
};

export type SchedulePerson = {
  personId: string;
  name: string;
  /** Base salary at the start; grows with `salaryGrowth` each January. */
  salary: number;
  bonusPct: number;
  /** Usual bonus month (1–12), for people with no letter. */
  bonusMonth: number;
  /** Bonuses on stubs dated after the start. */
  paidSinceStart: { payDate: string; gross: number }[];
};

const pad = (m: number) => String(m).padStart(2, "0");
export const monthKey = (year: number, month: number) => {
  const i = year * 12 + (month - 1);
  return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`;
};

export function bonusSchedule(x: {
  /** YYYY-MM of the starting balances (payments after it count). */
  startKey: string;
  startYear: number;
  people: SchedulePerson[];
  facts: BonusFacts;
  salaryGrowth: number;
  estimates: BonusEstimates;
  nearTermThrough: number;
  /** Last year to generate estimates through. */
  throughYear: number;
}): ScheduledBonus[] {
  const out: ScheduledBonus[] = [];
  for (const p of x.people) {
    const lastPaid = p.paidSinceStart.map((b) => b.payDate.slice(0, 7)).sort().at(-1) ?? null;
    for (const b of p.paidSinceStart) {
      out.push({ key: b.payDate.slice(0, 7), personId: p.personId, personName: p.name, source: "PAID", gross: b.gross, counted: true, label: `Paid ${b.payDate} (pay stub)`, date: b.payDate });
    }
    for (const l of x.facts.scheduled.filter((s) => s.personId === p.personId && s.key > x.startKey)) {
      // A letter payment already on a stub after the start is counted as PAID.
      if (lastPaid && l.key <= lastPaid) continue;
      out.push({ key: l.key, personId: p.personId, personName: p.name, source: "LETTER", gross: l.gross, counted: true, label: l.label, ...(l.window ? { window: l.window } : {}) });
    }

    if (!(p.bonusPct > 0)) continue;
    const pattern = x.facts.patterns.find((q) => q.personId === p.personId) ?? null;
    const parts = pattern?.parts ?? [{ offset: p.bonusMonth, share: 1, plan: false, label: "usual bonus month" }];
    const floor = [x.startKey, lastPaid ?? ""].sort().at(-1)!;
    for (let year = pattern ? pattern.lastAwardYear + 1 : x.startYear - 1; year <= x.throughYear; year++) {
      // Without a letter, an award whose payout is already behind the latest stub or the start was paid or missed.
      if (!pattern && monthKey(year + 1, parts[0]!.offset) <= floor) continue;
      const award = Math.round(grow(p.salary, x.salaryGrowth, Math.max(0, year - x.startYear)) * p.bonusPct);
      for (const part of parts) {
        const key = monthKey(year + 1, part.offset);
        if (key <= x.startKey) continue;
        const gross = Math.round(award * part.share);
        const base = { key, personId: p.personId, personName: p.name, source: "ESTIMATE" as const, gross, awardYear: year, ...(pattern ? { share: part.share } : {}) };
        const label = `${year} award (estimate) · ${part.label}`;
        if (part.plan) out.push({ ...base, counted: false, label, why: "into the deferred comp plan, which has no statements, so it isn't in net worth" });
        else if (x.estimates === "NONE") continue;
        else if (x.estimates === "AFTER_NEAR_TERM" && Number(key.slice(0, 4)) <= x.nearTermThrough) {
          out.push({ ...base, counted: false, label, why: `near term: estimated bonuses start in ${x.nearTermThrough + 1}` });
        } else out.push({ ...base, counted: true, label });
      }
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key) || a.personName.localeCompare(b.personName));
}

// ---------------------------------------------------------------- facts from the letters

const KIND_LABEL = { UPFRONT: "cash", DEFERRED: "a deferred tranche" } as const;

/**
 * From the Bonuses report and the letters: each still-vesting window (per person), and
 * each current employer's payout pattern from its latest complete award. A letter whose
 * person has moved to another employer gives neither (its unpaid tranches are forfeited).
 */
export function bonusFacts(report: BonusesReport, letters: AwardLetter[]): BonusFacts {
  const scheduled: LetterPayment[] = [];
  const patterns: BonusPattern[] = [];
  for (const l of report.letters) {
    const emp = l.employment;
    if (!emp || emp.nextEmployer) continue;
    for (const w of report.windows.filter((v) => v.letterId === l.id && (v.status === "UPCOMING" || v.status === "DUE"))) {
      scheduled.push({ personId: emp.personId, employer: l.employer, key: w.to.slice(0, 7), gross: w.scheduledCents, label: `${l.title}: ${w.label} (letter)`, window: w.key });
    }
    const letter = letters.find((x) => x.id === l.id);
    const awards = (letter?.awards ?? []).filter((a) => !a.partial).sort((a, b) => b.year - a.year);
    const latest = awards[0];
    if (!latest) continue;
    const pays = latest.payments.filter((p) => p.kind === "UPFRONT" || p.kind === "DEFERRED");
    const plan = latest.planDeferral ?? 0;
    const total = latest.totalBonus ?? pays.reduce((s, p) => s + p.amount, 0) + plan;
    if (!(total > 0)) continue;
    const parts: BonusPattern["parts"] = pays.map((p) => {
      const [y, m] = p.to.split("-").map(Number) as [number, number];
      return { offset: (y - (latest.year + 1)) * 12 + m, share: p.amount / total, plan: false, label: `${Math.round((p.amount / total) * 100)}% as ${KIND_LABEL[p.kind as keyof typeof KIND_LABEL]}` };
    });
    if (plan > 0) parts.push({ offset: parts[0]?.offset ?? 2, share: plan / total, plan: true, label: `${Math.round((plan / total) * 100)}% deferred comp plan` });
    patterns.push({ personId: emp.personId, employer: l.employer, fromYear: latest.year, lastAwardYear: Math.max(...(letter?.awards ?? []).map((a) => a.year)), parts });
  }
  return { scheduled, patterns };
}
