import { grow } from "../../profile/outlook.ts";
import { readAwards, type PaymentKind } from "../../bonuses/awardStore.ts";
import { readReviews } from "../../bonuses/reviewStore.ts";
import { formatUsdFromCents } from "../../formatMoney.ts";
import type { Forecast } from "../../forecast/forecast.ts";
import { monthKey, type BonusFacts } from "../../forecast/bonusSchedule.ts";
import { employerKey } from "../../ingest/payroll/types.ts";
import type { OutlookSeeds } from "../../profile/basePay.ts";
import type { Book } from "../load.ts";
import { buildBonuses, type AwardRow, type BonusesReport, type BonusPayment, type Tranche, type VestWindow, type WindowStatus } from "../reports/bonuses.ts";
import { checksFor, perBook, sumCheck } from "./common.ts";
import { PAY_CHECKS, type PayDescriptor } from "./payProof.ts";
import type { ChainLine, Proof, ProofBlock, ProofEstimate, ProofKind, ProofLink } from "./types.ts";

/**
 * The proof behind a figure on the Bonuses page. An award letter is the plan and the pay
 * stubs are the proof (book/reports/bonuses.ts), so every figure here is a chain: what
 * the letter prints (proven: transcribed from the letter), each payment the stubs show
 * (linking to the pay proof of the stub that paid it), and what is still to come
 * (estimates, with their scheduled dates). Everything is re-derived through buildBonuses,
 * as the page builds it, from the same letters and review files.
 *
 *  - window: one payment date on a letter: everything it schedules, or what the stubs paid.
 *  - tranche: one scheduled payment of one award (cash up front, a deferred tranche…).
 *  - award: one award year on a letter: its headline, its parts, what was paid, forfeited
 *    or is still to vest.
 *  - letter: a letter's payment dates added up (scheduled, or on the stubs).
 *  - totals: the page's headline figures, award by award.
 *  - reconcile: a year's bonus paychecks from one employer: which a letter explains.
 *  - estimate: a bonus the forecast expects that no letter or stub shows yet: the past
 *    bonuses its share of base pay is read from, through the arithmetic, to the estimate.
 *
 * The part of an award deferred into a deferred compensation plan is never paid on the
 * stubs and has no statements, so it's shown as a line naming the plan and saying so.
 */

export type AwardMeasure = "scheduled" | "headline" | "totalComp" | "upfront" | "deferred" | "paid" | "deferredPaid" | "forfeited" | "outstanding";
export type TotalsMeasure = "headline" | "upfront" | "deferred" | "deferredPaid" | "forfeited" | "outstanding";

export type BonusesDescriptor = { report: "bonuses" } & (
  | { figure: "window"; window: string; measure: "scheduled" | "paid" }
  | { figure: "tranche"; letterId: string; year: number; window: string; kind: PaymentKind }
  | { figure: "award"; letterId: string; year: number; measure: AwardMeasure }
  | { figure: "letter"; letterId: string; measure: "scheduled" | "paid" }
  | { figure: "totals"; measure: TotalsMeasure }
  | { figure: "reconcile"; year: number; personId: string; employer: string }
  /** `part`: the payout part as the forecast labels it ("75% as cash", "usual bonus month"…). */
  | { figure: "estimate"; personId: string; awardYear: number; month: string; part: string }
);

const AWARD_MEASURES: AwardMeasure[] = ["scheduled", "headline", "totalComp", "upfront", "deferred", "paid", "deferredPaid", "forfeited", "outstanding"];
const TOTALS_MEASURES: TotalsMeasure[] = ["headline", "upfront", "deferred", "deferredPaid", "forfeited", "outstanding"];
const KINDS: PaymentKind[] = ["UPFRONT", "DEFERRED", "SIGNING", "MAKEWHOLE"];

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const year = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1900 && v <= 2999;

export function parseBonusesDescriptor(d: Record<string, unknown>): BonusesDescriptor | { error: string } {
  switch (d.figure) {
    case "window":
      if (!str(d.window) || (d.measure !== "scheduled" && d.measure !== "paid")) return { error: "window needs a window key and measure scheduled or paid." };
      return { report: "bonuses", figure: "window", window: d.window, measure: d.measure };
    case "tranche":
      if (!str(d.letterId) || !year(d.year) || !str(d.window) || !KINDS.includes(d.kind as PaymentKind)) return { error: "tranche needs letterId, year, window and kind." };
      return { report: "bonuses", figure: "tranche", letterId: d.letterId, year: d.year, window: d.window, kind: d.kind as PaymentKind };
    case "award":
      if (!str(d.letterId) || !year(d.year) || !AWARD_MEASURES.includes(d.measure as AwardMeasure)) return { error: `award needs letterId, year and measure (${AWARD_MEASURES.join(", ")}).` };
      return { report: "bonuses", figure: "award", letterId: d.letterId, year: d.year, measure: d.measure as AwardMeasure };
    case "letter":
      if (!str(d.letterId) || (d.measure !== "scheduled" && d.measure !== "paid")) return { error: "letter needs letterId and measure scheduled or paid." };
      return { report: "bonuses", figure: "letter", letterId: d.letterId, measure: d.measure };
    case "totals":
      if (!TOTALS_MEASURES.includes(d.measure as TotalsMeasure)) return { error: `totals needs measure (${TOTALS_MEASURES.join(", ")}).` };
      return { report: "bonuses", figure: "totals", measure: d.measure as TotalsMeasure };
    case "reconcile":
      if (!year(d.year) || !str(d.personId) || !str(d.employer)) return { error: "reconcile needs year, personId and employer." };
      return { report: "bonuses", figure: "reconcile", year: d.year, personId: d.personId, employer: d.employer };
    case "estimate":
      if (!str(d.personId) || !year(d.awardYear) || !str(d.month) || !/^\d{4}-\d{2}$/.test(d.month) || !str(d.part)) return { error: "estimate needs personId, awardYear, month (YYYY-MM) and part." };
      return { report: "bonuses", figure: "estimate", personId: d.personId, awardYear: d.awardYear, month: d.month, part: d.part };
    default:
      return { error: "figure must be window, tranche, award, letter, totals, reconcile or estimate." };
  }
}

// ---------------------------------------------------------------- shared pieces

const money = (c: number) => (c === 0 ? "$0.00" : formatUsdFromCents(c));

const KIND: Record<PaymentKind, string> = { UPFRONT: "Up-front cash", DEFERRED: "Deferred tranche", SIGNING: "Sign-on bonus", MAKEWHOLE: "Make-whole bonus" };
const PAID: WindowStatus[] = ["PAID", "PAID_DIFFERENT"];
const OUTSTANDING: WindowStatus[] = ["UPCOMING", "DUE", "NOT_ON_STUBS", "NO_STUBS"];

/** One pay date's bonus lines from one employer: what a pay proof of that date re-adds. */
type PayDay = { personId: string; employer: string; employerKey: string; date: string; cents: number; lines: string[]; payments: BonusPayment[] };

function payDays(ps: BonusPayment[]): PayDay[] {
  const out = new Map<string, PayDay>();
  for (const p of ps) {
    const k = `${p.personId}|${p.employerKey}|${p.date}`;
    const d = out.get(k) ?? { personId: p.personId, employer: p.employer, employerKey: p.employerKey, date: p.date, cents: 0, lines: [], payments: [] };
    d.cents += p.amountCents;
    d.lines.push(`${p.line} ${money(p.amountCents)}`);
    d.payments.push(p);
    out.set(k, d);
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** The pay proof of one day's bonus lines from one employer. */
function payLink(d: PayDay): ProofLink {
  const descriptor: PayDescriptor = { report: "pay", basis: "paid", personId: d.personId, employerKeys: [d.employerKey], lines: ["bonus"], start: d.date, end: d.date };
  return { label: `${d.date} stub, ${d.employer}`, descriptor };
}

const windowLink = (w: VestWindow, measure: "scheduled" | "paid"): ProofLink => ({
  label: `${w.label}: ${measure === "paid" ? "on the stubs" : "scheduled"}`,
  descriptor: { report: "bonuses", figure: "window", window: w.key, measure },
});

const awardLink = (a: AwardRow, measure: AwardMeasure): ProofLink => ({ label: `${a.year} award, ${a.employer}`, descriptor: { report: "bonuses", figure: "award", letterId: a.letterId, year: a.year, measure } });

const trancheLink = (a: AwardRow, t: Tranche): ProofLink => ({
  label: `${a.year} ${KIND[t.kind].toLowerCase()}, ${t.label}`,
  descriptor: { report: "bonuses", figure: "tranche", letterId: a.letterId, year: a.year, window: t.window, kind: t.kind },
});

/** The letter a figure comes from, as the chain's first line. */
function letterLine(letter: BonusesReport["letters"][number]): ChainLine {
  return {
    label: `Award letter: ${letter.title}`,
    value: { text: letter.employer },
    source: "proven",
    note: ["Typed into the bonus letters file exactly as the letter prints it.", letter.terms ?? ""].filter(Boolean).join(" "),
  };
}

/** The plan deferral: part of the headline bonus, never on the stubs, in no tracked account. */
function planLine(a: AwardRow, op: ChainLine["op"]): ChainLine {
  return {
    op,
    label: `Deferred into ${a.employer}'s deferred compensation plan`,
    value: { cents: a.planDeferredCents },
    source: "proven",
    note: "As the letter prints it. Paid out under the plan's own terms, never on the pay stubs. The plan's fund has no account or statements here, so it isn't in any tracked account (or net worth).",
  };
}

/** Warnings about these letters, windows or award years: open ones, and the ones the owner reviewed (with their note and date). */
function warningBlocks(r: BonusesReport, prefixes: string[]): ProofBlock[] {
  const hit = (id: string) => prefixes.some((p) => id.startsWith(p));
  const blocks: ProofBlock[] = [];
  const open = r.warnings.filter((w) => hit(w.id));
  const reviewed = r.reviewed.filter((w) => hit(w.id));
  if (open.length)
    blocks.push({
      kind: "breakdown",
      title: "Open warnings",
      items: open.map((w) => ({ label: w.text, value: { cents: w.gapCents }, sub: "Not reviewed: the page shows it as “Check this”." })),
      note: "Each figure is the gap: what the stubs or the letter's parts come to, less what the letter prints.",
    });
  if (reviewed.length)
    blocks.push({
      kind: "breakdown",
      title: "Warnings you reviewed",
      items: reviewed.map((w) => ({ label: w.text, value: { cents: w.gapCents }, sub: `Reviewed ${w.reviewedAt.slice(0, 10)}: “${w.note}”` })),
      note: "You accepted each at the gap shown. If the letters or stubs change that gap, the warning opens again.",
    });
  return blocks;
}

/** A tranche's chain line: proven from the letter, paid ones linking to the stub(s) that paid them, future ones estimates. */
function trancheLine(r: BonusesReport, a: AwardRow, t: Tranche, value: "amount" | "paid", op: ChainLine["op"]): ChainLine {
  const w = r.windows.find((x) => x.key === t.window)!;
  const label = `${a.year} award · ${KIND[t.kind]}, ${t.label}`;
  if (value === "paid") {
    const days = payDays(w.payments);
    const shared = w.parts.length > 1;
    return {
      op,
      label,
      value: { cents: t.paidCents },
      source: "proven",
      note: `${shared ? `Its share (${money(t.amountCents)} of ${money(w.scheduledCents)} scheduled) of the ${money(w.paidCents)} paid in ${w.label}` : `Paid in ${w.label}`}: ${days.map((d) => `${d.date} ${money(d.cents)}`).join(" + ")}.`,
      link: days.length === 1 ? payLink(days[0]!) : windowLink(w, "paid"),
    };
  }
  if (PAID.includes(t.status)) {
    const days = payDays(w.payments);
    return {
      op,
      label,
      value: { cents: t.amountCents },
      source: "proven",
      note: `As the letter schedules it. ${w.detail}`,
      link: days.length === 1 && w.parts.length === 1 ? payLink(days[0]!) : windowLink(w, "paid"),
    };
  }
  if (t.status === "UPCOMING" || t.status === "DUE")
    return { op, label, value: { cents: t.amountCents }, source: "estimate", note: `Scheduled ${t.from} – ${t.to} (${t.label}), if still employed then. ${w.detail}` };
  return { op, label, value: { cents: t.amountCents }, source: "proven", note: `As the letter schedules it. ${t.status === "FORFEITED" ? "Forfeited: " : ""}${w.detail}` };
}

type Ctx = { book: Book; r: BonusesReport };

function base(ctx: Ctx, d: BonusesDescriptor, describes: string, figureCents: number, partsCents: number, explain: string, blocks: ProofBlock[], scope: { personId?: string; from: string; to: string }, estimates: ProofEstimate[] = []): Proof {
  const to = scope.to < ctx.book.today ? scope.to : ctx.book.today;
  const { checks, withheld } = checksFor(ctx.book, { affects: "PAY", from: scope.from, to: to < scope.from ? scope.from : to, ...(scope.personId ? { personId: scope.personId } : {}) }, PAY_CHECKS);
  return {
    report: "bonuses",
    descriptor: d,
    describes,
    figure: { cents: figureCents },
    selfCheck: sumCheck(figureCents, partsCents, explain),
    withheld,
    blocks,
    checks,
    estimates,
    through: to,
    today: ctx.book.today,
  };
}

function missing(book: Book, d: BonusesDescriptor, why: string): Proof {
  return { report: "bonuses", descriptor: d, describes: why, figure: { text: "—" }, selfCheck: null, withheld: false, blocks: [], checks: [], estimates: [], through: book.today, today: book.today };
}

const EARLY_DAYS = 14;
const LATE_DAYS = 31;
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
/** The stub dates a letter's windows look at ("on or about": a little before each opens, a month after it closes). */
const span = (ws: VestWindow[]) => ({ from: shift(ws.map((w) => w.from).sort()[0]!, -EARLY_DAYS), to: shift(ws.map((w) => w.to).sort().at(-1)!, LATE_DAYS) });

const upcomingEstimates = (r: BonusesReport, ts: { a: AwardRow; t: Tranche }[]): ProofEstimate[] =>
  ts
    .filter(({ t }) => t.status === "UPCOMING" || t.status === "DUE")
    .map(({ a, t }) => ({
      id: `${t.window}|${a.year}|${t.kind}`,
      title: `${a.year} award · ${KIND[t.kind]}: ${money(t.amountCents)} scheduled ${t.label}`,
      detail: `Not paid yet: ${r.windows.find((w) => w.key === t.window)?.detail ?? ""} The letter's terms decide whether it vests.`,
    }));

// ---------------------------------------------------------------- the figures

function windowProof(ctx: Ctx, d: Extract<BonusesDescriptor, { figure: "window" }>): Proof {
  const { r } = ctx;
  const w = r.windows.find((x) => x.key === d.window);
  if (!w) return missing(ctx.book, d, "That payment date is no longer on any letter.");
  const letter = r.letters.find((l) => l.id === w.letterId)!;
  const personId = letter.employment?.personId;
  const blocks: ProofBlock[] = [];
  const days = payDays(w.payments);
  const paidSum = days.reduce((t, x) => t + x.cents, 0);
  const warn = warningBlocks(r, [`${w.key}|`]);
  if (d.measure === "scheduled") {
    const awardOf = (y: number) => r.awards.find((a) => a.letterId === w.letterId && a.year === y)!;
    const lines: ChainLine[] = [letterLine(letter)];
    w.parts.forEach((p, i) => {
      const a = awardOf(p.awardYear);
      const t = a.tranches.find((x) => x.window === w.key && x.kind === p.kind)!;
      lines.push({ ...trancheLine(r, a, t, "amount", i ? "+" : undefined), link: trancheLink(a, t) });
    });
    lines.push({ op: "=", label: `Scheduled for ${w.label}`, value: { cents: w.scheduledCents }, source: "proven", note: "Everything due from one employer in the same window is paid together." });
    blocks.push({ kind: "chain", title: `${letter.title}: ${w.label}`, lines });
    blocks.push({
      kind: "chain",
      title: "Against the stubs",
      lines: [
        { label: "Scheduled", value: { cents: w.scheduledCents }, source: "proven" },
        { op: "−", label: "On the stubs", value: { cents: w.paidCents }, source: "proven", link: windowLink(w, "paid") },
        { op: "=", label: "Difference", value: { cents: w.scheduledCents - w.paidCents }, source: "derived", note: w.detail },
      ],
    });
    blocks.push(...warn);
    const sum = w.parts.reduce((t, p) => t + p.amountCents, 0);
    return base(ctx, d, `${letter.title} · ${w.label}, scheduled`, w.scheduledCents, sum, `The ${w.parts.length} scheduled payment${w.parts.length === 1 ? "" : "s"} below add up to ${money(sum)}`, blocks, { personId, from: w.from, to: w.to }, upcomingEstimates(r, w.parts.map((p) => ({ a: awardOf(p.awardYear), t: awardOf(p.awardYear).tranches.find((x) => x.window === w.key && x.kind === p.kind)! }))));
  }
  const lines: ChainLine[] = days.map((x, i) => ({ op: i ? "+" : undefined, label: `${x.date} stub · ${x.employer}`, value: { cents: x.cents }, source: "proven", note: x.lines.join(", "), link: payLink(x) }));
  lines.push({ op: "=", label: `On the stubs for ${w.label}`, value: { cents: w.paidCents }, source: "proven", note: w.detail });
  blocks.push({ kind: "chain", title: `${letter.title}: ${w.label}, paid`, lines, note: `Bonus lines from ${letter.employer} paid from ${EARLY_DAYS} days before the window opens to ${LATE_DAYS} days after it closes count toward it.` });
  blocks.push({
    kind: "chain",
    title: "Against the letter",
    lines: [
      { label: "On the stubs", value: { cents: w.paidCents }, source: "proven" },
      { op: "−", label: "Scheduled", value: { cents: w.scheduledCents }, source: "proven", link: windowLink(w, "scheduled") },
      { op: "=", label: "Difference", value: { cents: w.paidCents - w.scheduledCents }, source: "derived", note: `Within a dollar per scheduled payment counts as paid (letters print whole dollars).` },
    ],
  });
  blocks.push(...warn);
  return base(ctx, d, `${letter.title} · ${w.label}, on the stubs`, w.paidCents, paidSum, `The ${days.length} stub${days.length === 1 ? "" : "s"} below add up to ${money(paidSum)}`, blocks, { personId, ...span([w]) });
}

function trancheProof(ctx: Ctx, d: Extract<BonusesDescriptor, { figure: "tranche" }>): Proof {
  const { r } = ctx;
  const a = r.awards.find((x) => x.letterId === d.letterId && x.year === d.year);
  const t = a?.tranches.find((x) => x.window === d.window && x.kind === d.kind);
  if (!a || !t) return missing(ctx.book, d, "That payment is no longer on the letter.");
  const letter = r.letters.find((l) => l.id === a.letterId)!;
  const w = r.windows.find((x) => x.key === t.window)!;
  const lines: ChainLine[] = [letterLine(letter), trancheLine(r, a, t, "amount", undefined), { op: "=", label: `${KIND[t.kind]} due ${t.label}`, value: { cents: t.amountCents }, source: PAID.includes(t.status) || t.status === "FORFEITED" ? "proven" : "estimate" }];
  const blocks: ProofBlock[] = [{ kind: "chain", title: `${a.year} award · ${KIND[t.kind]}`, lines }];
  if (w.parts.length > 1)
    blocks.push({
      kind: "breakdown",
      title: `Paid together in ${w.label}`,
      items: w.parts.map((p) => ({ label: `${p.awardYear} award · ${KIND[p.kind]}`, value: { cents: p.amountCents } })),
      note: "Every payment due in the same window is paid together, so the stubs are matched against the window as a whole.",
    });
  blocks.push({
    kind: "breakdown",
    title: "The window it's paid in",
    items: [
      { label: `${w.label}: scheduled`, value: { cents: w.scheduledCents }, link: windowLink(w, "scheduled") },
      { label: `${w.label}: on the stubs`, value: { cents: w.paidCents }, sub: w.detail, link: windowLink(w, "paid") },
    ],
  });
  blocks.push(...warningBlocks(r, [`${w.key}|`]));
  return base(ctx, d, `${letter.title} · ${a.year} award, ${KIND[t.kind].toLowerCase()} ${t.label}`, t.amountCents, t.amountCents, `As the letter prints it: ${money(t.amountCents)}`, blocks, { personId: a.personId, from: w.from, to: w.to }, upcomingEstimates(r, [{ a, t }]));
}

function awardProof(ctx: Ctx, d: Extract<BonusesDescriptor, { figure: "award" }>): Proof {
  const { r } = ctx;
  const a = r.awards.find((x) => x.letterId === d.letterId && x.year === d.year);
  if (!a) return missing(ctx.book, d, "That award is no longer on the letter.");
  const letter = r.letters.find((l) => l.id === a.letterId)!;
  const ws = r.windows.filter((w) => a.tranches.some((t) => t.window === w.key));
  const scope = { personId: a.personId === "?" ? undefined : a.personId, ...(ws.length ? span(ws) : { from: `${a.year}-01-01`, to: `${a.year + 3}-12-31` }) };
  const warn = warningBlocks(r, [`${a.letterId}|${a.year}|`, ...ws.map((w) => `${w.key}|`)]);
  const title = `${letter.title}: ${a.year} award${a.partial ? " (part)" : ""}`;
  const describes = (what: string) => `${letter.title} · ${a.year} award, ${what}`;

  if (d.measure === "headline" || d.measure === "totalComp") {
    const lines: ChainLine[] = [letterLine(letter)];
    let figure: number;
    let parts: number;
    if (d.measure === "headline") {
      figure = a.totalBonusCents ?? a.upfrontCents + a.deferredCents;
      if (a.totalBonusCents != null) lines.push({ label: "Headline bonus", value: { cents: a.totalBonusCents }, source: "proven", note: "As the letter prints it." });
      parts = a.totalBonusCents ?? 0;
      if (a.totalBonusCents == null) {
        lines.push({ label: "Up front", value: { cents: a.upfrontCents }, source: "proven", link: awardLink(a, "upfront") }, { op: "+", label: "Deferred", value: { cents: a.deferredCents }, source: "proven", link: awardLink(a, "deferred") });
        parts = a.upfrontCents + a.deferredCents;
      }
      lines.push({ op: "=", label: `${a.year} headline bonus`, value: { cents: figure }, source: "proven" });
    } else {
      if (!a.totalComp) return missing(ctx.book, d, "The letter gives no total compensation for that year, and its base isn't known.");
      figure = a.totalComp.cents;
      if (a.totalComp.from === "LETTER") {
        lines.push({ label: "Total compensation", value: { cents: figure }, source: "proven", note: "As the letter prints it." });
        parts = figure;
      } else {
        const b = a.base!;
        lines.push({
          label: b.from === "LETTER" ? "Base salary (letter)" : `Base pay on the ${a.year} stubs`,
          value: { cents: b.cents },
          source: "proven",
          note: b.from === "STUBS" ? `The letter prints no base salary: ${b.parts.map((p) => `${p.employer} ${money(p.cents)}`).join(" + ")}.` : undefined,
          ...(b.from === "STUBS" ? { link: { label: `Base pay ${a.year}`, descriptor: { report: "pay", basis: "ytd", personId: a.personId, year: a.year, lines: ["base"] } satisfies PayDescriptor } } : {}),
        });
        lines.push({ op: "+", label: "Headline bonus", value: { cents: a.totalBonusCents! }, source: "proven", link: awardLink(a, "headline") });
        if (a.oneOffCents) lines.push({ op: "+", label: "Sign-on / make-whole", value: { cents: a.oneOffCents }, source: "proven" });
        parts = b.cents + a.totalBonusCents! + a.oneOffCents;
      }
      lines.push({ op: "=", label: "Total compensation", value: { cents: figure }, source: a.totalComp.from === "LETTER" ? "proven" : "derived" });
    }
    const blocks: ProofBlock[] = [{ kind: "chain", title, lines }];
    if (d.measure === "headline") {
      const items = [
        { label: "Up front", value: { cents: a.upfrontCents }, link: awardLink(a, "upfront") },
        { label: "Deferred (tranches)", value: { cents: a.deferredCents }, link: awardLink(a, "deferred") },
        ...(a.planDeferredCents ? [{ label: "Deferred comp plan (in no tracked account)", value: { cents: a.planDeferredCents } }] : []),
      ];
      blocks.push({ kind: "breakdown", title: "How the letter splits it", items, note: a.partial ? "This letter shows only some of the year's payments." : "Sign-on and make-whole payments are outside the headline bonus." });
    }
    blocks.push(...warn);
    return base(ctx, d, describes(d.measure === "headline" ? "headline bonus" : "total compensation"), figure, parts, `The lines below come to ${money(parts)}`, blocks, scope);
  }

  const pick: Record<Exclude<AwardMeasure, "headline" | "totalComp">, { what: string; take: (t: Tranche) => boolean; value: "amount" | "paid" }> = {
    scheduled: { what: "everything scheduled", take: () => true, value: "amount" },
    upfront: { what: "paid up front", take: (t) => t.kind === "UPFRONT", value: "amount" },
    deferred: { what: "deferred", take: (t) => t.kind === "DEFERRED", value: "amount" },
    paid: { what: "paid so far", take: (t) => t.paidCents !== 0, value: "paid" },
    deferredPaid: { what: "deferred, paid out", take: (t) => t.kind === "DEFERRED" && t.paidCents !== 0, value: "paid" },
    forfeited: { what: "forfeited", take: (t) => t.status === "FORFEITED", value: "amount" },
    outstanding: { what: "still to vest", take: (t) => OUTSTANDING.includes(t.status), value: "amount" },
  };
  const m = pick[d.measure];
  const ts = a.tranches.filter(m.take);
  const lines: ChainLine[] = [letterLine(letter), ...ts.map((t, i) => trancheLine(r, a, t, m.value, i ? "+" : undefined))];
  let parts = ts.reduce((t, x) => t + (m.value === "paid" ? x.paidCents : x.amountCents), 0);
  let figure = parts;
  if (d.measure === "deferred" && a.planDeferredCents) {
    lines.push(planLine(a, ts.length ? "+" : undefined));
    parts += a.planDeferredCents;
    figure += a.planDeferredCents;
  }
  // The page's figures, as AwardRow carries them.
  const shown: Partial<Record<AwardMeasure, number>> = {
    scheduled: a.upfrontCents + a.deferredCents + a.oneOffCents,
    upfront: a.upfrontCents,
    deferred: a.deferredCents + a.planDeferredCents,
    paid: a.paidCents,
    forfeited: a.forfeitedCents,
    outstanding: a.outstandingCents,
  };
  figure = shown[d.measure] ?? figure;
  lines.push({ op: "=", label: `${a.year} award, ${m.what}`, value: { cents: figure }, source: d.measure === "outstanding" && ts.some((t) => t.status === "UPCOMING" || t.status === "DUE") ? "estimate" : "proven" });
  const rest = a.tranches.length - ts.length;
  const blocks: ProofBlock[] = [
    {
      kind: "chain",
      title,
      lines,
      note: [
        m.value === "paid" ? "A payment date that pays several awards at once is shared out in proportion to what each award scheduled." : "",
        rest ? `${rest} other scheduled payment${rest === 1 ? "" : "s"} on this award ${rest === 1 ? "isn't" : "aren't"} part of this figure.` : "",
      ]
        .filter(Boolean)
        .join(" "),
    },
    ...warn,
  ];
  const n = ts.length + (d.measure === "deferred" && a.planDeferredCents ? 1 : 0);
  return base(ctx, d, describes(m.what), figure, parts, `The ${n} payment${n === 1 ? "" : "s"} below add up to ${money(parts)}`, blocks, scope, upcomingEstimates(r, ts.map((t) => ({ a, t }))));
}

function letterProof(ctx: Ctx, d: Extract<BonusesDescriptor, { figure: "letter" }>): Proof {
  const { r } = ctx;
  const letter = r.letters.find((l) => l.id === d.letterId);
  if (!letter) return missing(ctx.book, d, "That letter is no longer on file.");
  const ws = r.windows.filter((w) => w.letterId === letter.id);
  const val = (w: VestWindow) => (d.measure === "paid" ? w.paidCents : w.scheduledCents);
  const figure = ws.reduce((t, w) => t + val(w), 0);
  const lines: ChainLine[] = [
    letterLine(letter),
    ...ws.map((w, i): ChainLine => ({ op: i ? "+" : undefined, label: w.label, value: { cents: val(w) }, source: d.measure === "paid" || PAID.includes(w.status) || w.status === "FORFEITED" ? "proven" : "estimate", note: w.detail, link: windowLink(w, d.measure) })),
    { op: "=", label: d.measure === "paid" ? "On the stubs, every payment date" : "Due, every payment date", value: { cents: figure }, source: "proven" },
  ];
  const blocks: ProofBlock[] = [{ kind: "chain", title: letter.title, lines }, ...warningBlocks(r, [`${letter.id}|`])];
  return base(ctx, d, `${letter.title} · ${d.measure === "paid" ? "on the stubs" : "scheduled"}`, figure, figure, `The ${ws.length} payment date${ws.length === 1 ? "" : "s"} below add up to ${money(figure)}`, blocks, {
    personId: letter.employment?.personId,
    ...(ws.length ? span(ws) : { from: ctx.book.today, to: ctx.book.today }),
  });
}

function totalsProof(ctx: Ctx, d: Extract<BonusesDescriptor, { figure: "totals" }>): Proof {
  const { r } = ctx;
  const full = r.awards.filter((a) => !a.partial);
  const of: Record<TotalsMeasure, { what: string; v: (a: AwardRow) => number; link: AwardMeasure }> = {
    headline: { what: "Headline bonuses", v: (a) => a.totalBonusCents ?? a.upfrontCents + a.deferredCents, link: "headline" },
    upfront: { what: "Paid up front", v: (a) => a.upfrontCents, link: "upfront" },
    deferred: { what: "Deferred", v: (a) => a.deferredCents, link: "deferred" },
    deferredPaid: { what: "Deferred paid out", v: (a) => a.tranches.filter((t) => t.kind === "DEFERRED").reduce((s, t) => s + t.paidCents, 0), link: "deferredPaid" },
    forfeited: { what: "Forfeited", v: (a) => a.forfeitedCents, link: "forfeited" },
    outstanding: { what: "Still to vest", v: (a) => a.outstandingCents, link: "outstanding" },
  };
  const m = of[d.measure];
  const shown: Record<TotalsMeasure, number> = {
    headline: r.totals.headlineCents,
    upfront: r.totals.upfrontCents,
    deferred: r.totals.deferredCents,
    deferredPaid: r.totals.deferredPaidCents,
    forfeited: r.totals.forfeitedCents,
    outstanding: r.totals.outstandingCents,
  };
  const parts = full.reduce((t, a) => t + m.v(a), 0);
  const lines: ChainLine[] = full.map((a, i) => ({
    op: i ? "+" : undefined,
    label: `${a.year} award · ${a.employer}`,
    value: { cents: m.v(a) },
    source: d.measure === "outstanding" && a.tranches.some((t) => t.status === "UPCOMING" || t.status === "DUE") ? "estimate" : "proven",
    note: d.measure === "deferred" && a.planDeferredCents ? `Not counting ${money(a.planDeferredCents)} deferred into the deferred compensation plan (in no tracked account).` : undefined,
    link: awardLink(a, m.link),
  }));
  lines.push({ op: "=", label: m.what, value: { cents: shown[d.measure] }, source: "proven" });
  const partial = r.awards.filter((a) => a.partial);
  const blocks: ProofBlock[] = [
    {
      kind: "chain",
      title: `${m.what}, award by award`,
      lines,
      note: partial.length ? `Not counted: ${partial.map((a) => `${a.year} (${a.employer})`).join(", ")}, which the letters show only in part (the headline is on another letter).` : undefined,
    },
    ...warningBlocks(r, [""]),
  ];
  const ws = r.windows;
  return base(ctx, d, `Bonuses · ${m.what.toLowerCase()}, every award on file`, shown[d.measure], parts, `The ${full.length} award${full.length === 1 ? "" : "s"} below add up to ${money(parts)}`, blocks, ws.length ? span(ws) : { from: ctx.book.today, to: ctx.book.today });
}

function reconcileProof(ctx: Ctx, d: Extract<BonusesDescriptor, { figure: "reconcile" }>): Proof {
  const { r } = ctx;
  const y = r.byYear.find((x) => x.year === d.year && x.personId === d.personId && x.employer === d.employer);
  if (!y) return missing(ctx.book, d, "No bonus paychecks match that year, person and employer any more.");
  const ps = r.payments.filter((p) => Number(p.date.slice(0, 4)) === d.year && p.personId === d.personId && p.employer === d.employer);
  const windowOf = (p: BonusPayment) => r.windows.find((w) => w.payments.some((q) => q.stubId === p.stubId && q.line === p.line));
  const explained = ps.filter((p) => p.explains);
  const unexplained = ps.filter((p) => !p.explains);
  const sum = (xs: BonusPayment[]) => xs.reduce((t, p) => t + p.amountCents, 0);
  const keys = r.letters.map((l) => employerKey(l.employer));
  const lettered = ps.some((p) => keys.some((k) => p.employerKey === k || p.employerKey.startsWith(`${k} #`)));
  const stubOnly = r.stubOnly.some((s) => s.employer === d.employer);
  const dayLines = (xs: BonusPayment[], explainedSide: boolean): ChainLine[] =>
    payDays(xs).map((x, i) => {
      const w = explainedSide ? windowOf(x.payments[0]!) : undefined;
      const letter = w && r.letters.find((l) => l.id === w.letterId);
      return {
        op: i ? "+" : undefined,
        label: `${x.date} stub${w ? ` · pays ${w.label}` : ""}`,
        value: { cents: x.cents },
        source: "proven",
        note: [x.lines.join(", "), letter ? `on the letter “${letter.title}” (${w!.detail})` : stubOnly ? `${d.employer} issues no bonus letters: the stub is the whole story` : "no letter on file explains it"].join(" · "),
        link: payLink(x),
      };
    });
  const blocks: ProofBlock[] = [];
  if (explained.length) blocks.push({ kind: "chain", title: "Explained by a letter", lines: [...dayLines(explained, true), { op: "=", label: "Explained", value: { cents: sum(explained) }, source: "proven" }] });
  if (unexplained.length)
    blocks.push({
      kind: "chain",
      title: stubOnly ? "From an employer with no bonus letters" : "Not on any letter",
      lines: [...dayLines(unexplained, false), { op: "=", label: "Not explained by a letter", value: { cents: sum(unexplained) }, source: "proven" }],
      note: stubOnly
        ? undefined
        : lettered
          ? "Paid outside every payment date on the employer's letter (on or about each window)."
          : "No letter from this employer is on file: add it to the bonus letters file to see its schedule.",
    });
  const yearPay: PayDescriptor = { report: "pay", basis: "paid", personId: y.personId, employerKeys: y.employerKeys, lines: ["bonus"], start: `${y.year}-01-01`, end: `${y.year}-12-31` };
  blocks.push({
    kind: "chain",
    title: `${y.personName} · ${y.employer}, bonus paid in ${y.year}`,
    lines: [
      { label: "Explained by a letter", value: { cents: sum(explained) }, source: "proven" },
      { op: "+", label: "Not explained", value: { cents: sum(unexplained) }, source: "proven" },
      { op: "=", label: `Bonus paid in ${y.year}`, value: { cents: y.cents }, source: "proven", link: { label: `Bonus paid in ${y.year}`, descriptor: yearPay } },
    ],
  });
  const ws = [...new Set(explained.map(windowOf).filter((w): w is VestWindow => !!w))];
  blocks.push(...warningBlocks(r, ws.map((w) => `${w.key}|`)));
  const e = sum(explained);
  return base(ctx, d, `${y.personName} · ${y.employer}, bonus paid in ${y.year} that a letter explains`, y.explainedCents, e, `The ${explained.length} letter payment${explained.length === 1 ? "" : "s"} below add up to ${money(e)}, of ${money(sum(ps))} bonus paid that year`, blocks, {
    personId: d.personId === "?" ? undefined : d.personId,
    from: `${d.year}-01-01`,
    to: `${d.year}-12-31`,
  });
}

// ---------------------------------------------------------------- the forecast's estimates

/** What an estimated bonus is built from: the forecast on the saved assumptions, its seeds, and the letters' facts. */
export type EstimateInputs = { forecast: Forecast; seeds: OutlookSeeds; facts: BonusFacts };

export function buildEstimateProof(book: Book, x: EstimateInputs, d: Extract<BonusesDescriptor, { figure: "estimate" }>): Proof {
  const entry = x.forecast.schedule.find((b) => b.source === "ESTIMATE" && b.personId === d.personId && b.awardYear === d.awardYear && b.key === d.month && b.label === `${d.awardYear} award (estimate) · ${d.part}`);
  const person = x.forecast.pay.people.find((p) => p.personId === d.personId);
  const seed = x.seeds.people.find((p) => p.personId === d.personId);
  if (!entry || !person || !seed) return missing(book, d, "The forecast no longer expects that bonus.");
  const pattern = x.facts.patterns.find((q) => q.personId === d.personId) ?? null;
  const parts = pattern?.parts ?? [{ offset: person.bonusMonth, share: 1, plan: false, label: "usual bonus month" }];
  const part = parts.find((p) => p.label === d.part && monthKey(d.awardYear + 1, p.offset) === d.month)!;
  const startYear = x.seeds.start.year;
  const years = Math.max(0, d.awardYear - startYear);
  const growth = grow(1, x.forecast.assumptions.salaryGrowth, years);
  const award = Math.round(grow(person.salary, x.forecast.assumptions.salaryGrowth, years) * person.bonusPct);
  const gross = Math.round(award * part.share);
  const blocks: ProofBlock[] = [];

  // The share of base pay: typed, or the lowest of the last three complete years.
  const used = seed.bonusHistory.filter((h) => !h.partial && h.salary > 0 && h.pct != null).slice(-3);
  if (person.bonusPctTyped) {
    blocks.push({ kind: "chain", title: "Bonus as a share of base", lines: [{ label: "Bonus ÷ base salary", value: { ratio: person.bonusPct }, source: "assumption", note: "You set it on the Forecast page." }] });
  } else {
    const lines: ChainLine[] = [];
    for (const h of used) {
      const pay = (lines_: PayDescriptor["lines"]): PayDescriptor => ({ report: "pay", basis: "ytd", personId: d.personId, year: h.year, lines: lines_ });
      lines.push(
        { label: `${h.year} bonus`, value: { cents: h.bonus }, source: "proven", note: "Bonus lines on that year's pay stubs.", link: { label: `${seed.name} · bonus ${h.year}`, descriptor: pay(["bonus"]) } },
        { op: "÷", label: `${h.year} base pay`, value: { cents: h.salary }, source: "proven", link: { label: `${seed.name} · base pay ${h.year}`, descriptor: pay(["base"]) } },
        { op: "=", label: `${h.year} bonus ÷ base`, value: { ratio: h.pct! }, source: "derived" },
      );
    }
    lines.push({ op: "=", label: "Lowest of those years (conservative)", value: { ratio: person.bonusPct }, source: "derived", note: person.bonusDefault.label });
    blocks.push({ kind: "chain", title: "Bonus as a share of base, from past bonuses", lines });
  }

  const paycheck = person.paycheck;
  const salaryLine: ChainLine = person.salaryTyped
    ? { label: "Base salary", value: { cents: person.salary }, source: "assumption", note: "You set it on the Forecast page." }
    : {
        label: "Base salary",
        value: { cents: person.salary },
        source: "derived",
        note: paycheck ? `Regular pay ${money(paycheck.regular)} on the ${paycheck.payDate} stub × ${person.perYear} paychecks a year.` : "No paycheck on file.",
        ...(paycheck
          ? { link: { label: `${seed.name} · base pay ${paycheck.payDate}`, descriptor: { report: "pay", basis: "paid", personId: d.personId, lines: ["base"], start: paycheck.payDate, end: paycheck.payDate } satisfies PayDescriptor } }
          : {}),
      };
  const lines: ChainLine[] = [salaryLine];
  if (years > 0) lines.push({ op: "×", label: `Salary growth, ${years} year${years === 1 ? "" : "s"}`, value: { ratio: growth }, source: "assumption", note: `${(x.forecast.assumptions.salaryGrowth * 100).toFixed(1)}% a year from ${startYear}, your assumption.` });
  lines.push({ op: "×", label: "Bonus ÷ base salary", value: { ratio: person.bonusPct }, source: person.bonusPctTyped ? "assumption" : "derived" });
  lines.push({ op: "=", label: `${d.awardYear} award`, value: { cents: award }, source: "estimate" });
  lines.push({
    op: "×",
    label: part.plan ? "Share into the deferred compensation plan" : `Share paid ${d.month}`,
    value: { ratio: part.share },
    source: pattern ? "proven" : "derived",
    note: pattern
      ? `How ${pattern.employer}'s ${pattern.fromYear} award letter splits the bonus: ${part.label}.`
      : `The month of the latest year's largest bonus check on the stubs.`,
  });
  lines.push({
    op: "=",
    label: entry.label,
    value: { cents: entry.gross },
    source: "estimate",
    note: part.plan
      ? `Paid into ${pattern?.employer ?? "the employer"}'s deferred compensation plan: the plan's fund has no account or statements here, so it isn't in any tracked account and the forecast leaves it out.`
      : entry.counted
        ? "Counted in the forecast."
        : `Listed, not counted: ${entry.why}.`,
  });
  blocks.push({ kind: "chain", title: `${seed.name} · ${d.awardYear} award (estimate)`, lines, note: pattern ? undefined : "No award letter from the current employer: the whole award is expected in the usual bonus month." });

  const from = used.length ? `${used[0]!.year}-01-01` : `${startYear}-01-01`;
  const { checks, withheld } = checksFor(book, { affects: "PAY", personId: d.personId, from, to: book.today }, PAY_CHECKS);
  return {
    report: "bonuses",
    descriptor: d,
    describes: `${seed.name} · ${entry.label}`,
    figure: { cents: entry.gross },
    selfCheck: sumCheck(entry.gross, gross, `The arithmetic below comes to ${money(gross)}`),
    withheld,
    blocks,
    checks,
    estimates: [{ id: `estimate:${d.personId}:${d.awardYear}`, title: `${d.awardYear} award: a forecast, not a payment`, detail: "No letter or pay stub shows this award yet. It's a share of base pay, read off past bonuses (or typed), paid on the pattern of the latest letter." }],
    through: book.today,
    today: book.today,
  };
}

// ---------------------------------------------------------------- the kind

/** A figure on the Bonuses page from the report it was built from (the forecast's estimates excepted). */
export function buildBonusesProof(book: Book, r: BonusesReport, d: Exclude<BonusesDescriptor, { figure: "estimate" }>): Proof {
  const ctx: Ctx = { book, r };
  switch (d.figure) {
    case "window":
      return windowProof(ctx, d);
    case "tranche":
      return trancheProof(ctx, d);
    case "award":
      return awardProof(ctx, d);
    case "letter":
      return letterProof(ctx, d);
    case "totals":
      return totalsProof(ctx, d);
    case "reconcile":
      return reconcileProof(ctx, d);
  }
}

/** The report exactly as /api/bonuses builds it: the letters and the owner's reviews from their files. */
export const bonusesReport = (book: Book): BonusesReport => buildBonuses(book, readAwards(), book.today, readReviews().reviews);

export const bonusesKind: ProofKind<BonusesDescriptor> = {
  report: "bonuses",
  parse: parseBonusesDescriptor,
  build: async (ctx, d) => {
    const { book, db } = ctx;
    if (d.figure === "estimate") {
      // The forecast on the saved assumptions, as /api/forecast's data runs it (loaded lazily: it reads settings).
      const { loadForecast } = await import("../../forecast/load.ts");
      const { forecast, data } = await perBook(ctx, "forecast", () => loadForecast(db, book));
      if (!forecast || !data.profile.seeds) return missing(book, d, "The forecast has no proven starting point, so it expects no bonuses yet.");
      return buildEstimateProof(book, { forecast, seeds: data.profile.seeds, facts: data.bonusFacts }, d);
    }
    return buildBonusesProof(book, await perBook(ctx, "bonuses-report", () => bonusesReport(book)), d);
  },
};
