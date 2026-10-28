import { CADENCE_INFO, guessProduct, type Cadence, type PerkUnit } from "./catalog.ts";
import { pointsKey, setupFromProduct, usageKey, type CardPerksSettings, type CardSetup, type Perk } from "./settings.ts";

/**
 * The Card perks page: for each credit card and calendar year, what it cost (the annual
 * fee as the statements charge it), what it gave back (the perk credits used, period by
 * period, and the points earned on its spending, valued at the owner's cents per point),
 * and whether that adds up to more than the fee.
 *
 * Perk credits are the card's statement credits (rows the classifier filed as card perks,
 * or that say CREDIT), matched to a perk by its pattern and to a period by their date. A
 * use marked by hand replaces what the statements show for that period. Points are
 * estimated from each purchase's category or description unless the owner enters the
 * points the issuer actually posted.
 */

/** The ledger row fields this report reads. */
export type PerkRow = {
  id: string;
  date: string;
  amountCents: number;
  lane: string | null;
  accountId: string;
  payee: string;
  detail?: string | null;
  section?: string | null;
  category: string;
  classifiedBy: string | null;
};

export type CardAccount = {
  id: string;
  name: string;
  institution: string | null;
  archived?: boolean;
  /** First day and last day the card's statements cover (null: none on file). */
  from: string | null;
  through: string | null;
};

export type PeriodStatus =
  /** Fully used. */
  | "USED"
  /** Over, and only part of it was used. */
  | "PARTIAL"
  /** Over, statements in, nothing used. */
  | "MISSED"
  /** Under way: still can be used. */
  | "OPEN"
  /** Over, but the statement that would show the credit isn't in yet. */
  | "AWAITING"
  | "FUTURE"
  /** Before the card's first statement or after a closed card's last: not counted. */
  | "NOT_HELD";

export type PerkPeriod = {
  key: string;
  label: string;
  start: string;
  end: string;
  allowance: number;
  used: number;
  /** What the statements show, whatever the source of `used`. */
  detected: number;
  source: "STATEMENTS" | "MANUAL" | "NONE";
  status: PeriodStatus;
  rowIds: string[];
};

export type PerkLine = {
  id: string;
  name: string;
  cadence: Cadence;
  unit: PerkUnit;
  amount: number;
  pattern: string;
  note: string;
  /** The pattern isn't a valid regular expression, so nothing matches it. */
  patternError: boolean;
  periods: PerkPeriod[];
  /** Over the periods the card was held (cents, or points for a POINTS perk). */
  allowance: number;
  used: number;
  missed: number;
  remaining: number;
  /** What `used` is worth in cents (points at the card's cents per point). */
  valueCents: number;
};

export type CreditRow = { id: string; date: string; payee: string; amountCents: number; perkId: string | null; kind: "PERK" | "OTHER" | "REDEMPTION" };
export type EarnLine = { label: string; rate: number; spendCents: number; points: number };

export type CardScore = {
  accountId: string;
  accountName: string;
  setup: CardSetup;
  /** No setup saved: the setup shown is the catalog product the name suggests (or a blank one). */
  guessed: boolean;
  from: string | null;
  through: string | null;
  centsPerPoint: number;
  spend: { chargesCents: number; refundsCents: number; netCents: number };
  earn: EarnLine[];
  points: { estimated: number; entered: number | null; earned: number; valueCents: number };
  perks: PerkLine[];
  credits: CreditRow[];
  fee: { chargedCents: number; termsCents: number; cents: number; source: "STATEMENTS" | "TERMS" | "NONE"; rows: { id: string; date: string; payee: string; amountCents: number }[] };
  /** Perk credits used, at face value (bonus points valued at the card's rate). */
  perksValueCents: number;
  /** Statement credits that match no perk (issuer offers and the like). */
  otherCreditsCents: number;
  /** Perks + other credits: everything the card gave back besides points. */
  creditsCents: number;
  /** Points value + credits: everything the card gave back. */
  returnedCents: number;
  /** Perk value still to be had this year (open, awaiting and future periods). */
  remainingCents: number;
  missedCents: number;
  /** Points value + perks + other credits − annual fee. */
  netCents: number;
};

export type CardPerksReport = {
  year: number;
  years: number[];
  today: string;
  centsPerPoint: number;
  cards: CardScore[];
  /** Cards left off the page by the owner. */
  hidden: { accountId: string; accountName: string }[];
  totals: {
    feesCents: number;
    perksValueCents: number;
    otherCreditsCents: number;
    creditsCents: number;
    pointsValueCents: number;
    points: number;
    netCents: number;
    remainingCents: number;
    missedCents: number;
    spendCents: number;
    /** Cards charging a fee this year. */
    cardsWithFee: number;
    /** Perks with a period under way that isn't used up yet. */
    openPerks: number;
  };
};

const ANNUAL_FEE = /ANNUAL (MEMBERSHIP )?FEE|MEMBERSHIP FEE|ANNUAL CARD FEE|CARD ANNUAL FEE/i;
const REDEMPTION = /POINTS|REWARDS?\b|CASH ?BACK|REDEMPTION|REDEEM|MILES/i;

const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The periods of one cadence in a calendar year, in order. */
export function periodsOf(cadence: Cadence, year: number): { key: string; label: string; start: string; end: string }[] {
  const months = CADENCE_INFO[cadence].months;
  const out = [];
  for (let i = 0; i < 12 / months; i++) {
    const m0 = i * months + 1;
    const m1 = m0 + months - 1;
    const key = cadence === "MONTHLY" ? `${year}-${pad(m0)}` : cadence === "QUARTERLY" ? `${year}-Q${i + 1}` : cadence === "SEMIANNUAL" ? `${year}-H${i + 1}` : `${year}`;
    const label = cadence === "MONTHLY" ? MONTHS[i]! : cadence === "QUARTERLY" ? `Q${i + 1}` : cadence === "SEMIANNUAL" ? (i === 0 ? "Jan–Jun" : "Jul–Dec") : String(year);
    out.push({ key, label, start: `${year}-${pad(m0)}-01`, end: `${year}-${pad(m1)}-${pad(lastDay(year, m1))}` });
  }
  return out;
}

/** The period of `cadence` a date falls in. */
export function periodKey(cadence: Cadence, date: string): string {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  if (cadence === "MONTHLY") return date.slice(0, 7);
  if (cadence === "QUARTERLY") return `${y}-Q${Math.ceil(m / 3)}`;
  if (cadence === "SEMIANNUAL") return `${y}-H${m <= 6 ? 1 : 2}`;
  return y;
}

function regex(pattern: string): RegExp | null | "invalid" {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return "invalid";
  }
}

const textOf = (r: PerkRow) => `${r.payee} ${r.detail ?? ""}`;

/** The setup a card uses: the owner's, or the one its name suggests. */
export function setupFor(settings: CardPerksSettings, account: { id: string; name: string; institution: string | null }): { setup: CardSetup; guessed: boolean } {
  const saved = settings.cards[account.id];
  if (saved) return { setup: saved, guessed: false };
  return { setup: setupFromProduct(guessProduct(account), account.name), guessed: true };
}

function scoreCard(account: CardAccount, setup: CardSetup, guessed: boolean, rows: PerkRow[], settings: CardPerksSettings, year: number, today: string): CardScore {
  const cpp = setup.centsPerPoint ?? settings.centsPerPoint;
  const inYear = rows.filter((r) => r.accountId === account.id && r.date.startsWith(`${year}-`)).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  // The annual fee, net of any reversal, as the statements charge it.
  const feeRows = inYear.filter((r) => ANNUAL_FEE.test(textOf(r)));
  const feeIds = new Set(feeRows.map((r) => r.id));
  const chargedCents = -feeRows.reduce((t, r) => t + r.amountCents, 0);

  // Statement credits, each to the first matching perk with room left in its period.
  const perkRes = setup.perks.map((p) => ({ perk: p, re: p.unit === "USD" ? regex(p.pattern) : null }));
  const allocated = new Map<string, { cents: number; rowIds: string[] }>();
  const credits: CreditRow[] = [];
  const creditIds = new Set<string>();
  for (const r of inYear) {
    if (r.lane !== "EXPENSE" || r.amountCents <= 0 || feeIds.has(r.id)) continue;
    const perkCredit = r.classifiedBy === "card-perk-credit";
    if (!perkCredit && !/CREDIT/i.test(r.payee)) continue;
    const matches = perkRes.filter((x): x is { perk: Perk; re: RegExp } => x.re instanceof RegExp && x.re.test(textOf(r)));
    const room = (p: Perk) => p.amount - (allocated.get(usageKey(account.id, p.id, periodKey(p.cadence, r.date)))?.cents ?? 0);
    const perk = (matches.find((x) => room(x.perk) > 0) ?? matches[0])?.perk;
    if (perk) {
      const k = usageKey(account.id, perk.id, periodKey(perk.cadence, r.date));
      const a = allocated.get(k) ?? { cents: 0, rowIds: [] };
      allocated.set(k, { cents: a.cents + r.amountCents, rowIds: [...a.rowIds, r.id] });
      credits.push({ id: r.id, date: r.date, payee: r.payee, amountCents: r.amountCents, perkId: perk.id, kind: "PERK" });
      creditIds.add(r.id);
    } else if (perkCredit) {
      // Points cashed in are the points already counted, not a perk: shown, never added.
      credits.push({ id: r.id, date: r.date, payee: r.payee, amountCents: r.amountCents, perkId: null, kind: REDEMPTION.test(textOf(r)) ? "REDEMPTION" : "OTHER" });
      creditIds.add(r.id);
    }
    // Anything else that says CREDIT is a merchant's refund: it counts against spending.
  }

  const heldFrom = account.from;
  const heldThrough = account.archived ? account.through : null;
  const perks: PerkLine[] = perkRes.map(({ perk, re }) => {
    const periods = periodsOf(perk.cadence, year).map((p): PerkPeriod => {
      const k = usageKey(account.id, perk.id, p.key);
      const det = allocated.get(k);
      const manual = settings.usage[k];
      const detected = det?.cents ?? 0;
      const used = manual ?? detected;
      const source = manual != null ? "MANUAL" : det ? "STATEMENTS" : "NONE";
      const notHeld = !used && ((heldFrom != null && p.end < heldFrom) || heldFrom == null || (heldThrough != null && p.start > heldThrough));
      const over = p.end < today;
      const status: PeriodStatus = notHeld
        ? "NOT_HELD"
        : used >= perk.amount
          ? "USED"
          : p.start > today
            ? "FUTURE"
            : !over
              ? "OPEN"
              : manual != null || (account.through != null && p.end <= account.through)
                ? used > 0
                  ? "PARTIAL"
                  : "MISSED"
                : "AWAITING";
      return { ...p, allowance: perk.amount, used, detected, source, status, rowIds: det?.rowIds ?? [] };
    });
    const counted = periods.filter((p) => p.status !== "NOT_HELD");
    const short = (p: PerkPeriod) => Math.max(0, p.allowance - p.used);
    const used = counted.reduce((t, p) => t + p.used, 0);
    return {
      id: perk.id,
      name: perk.name,
      cadence: perk.cadence,
      unit: perk.unit,
      amount: perk.amount,
      pattern: perk.pattern,
      note: perk.note,
      patternError: re === "invalid",
      periods,
      allowance: counted.reduce((t, p) => t + p.allowance, 0),
      used,
      missed: counted.filter((p) => p.status === "MISSED" || p.status === "PARTIAL").reduce((t, p) => t + short(p), 0),
      remaining: counted.filter((p) => p.status === "OPEN" || p.status === "AWAITING" || p.status === "FUTURE").reduce((t, p) => t + short(p), 0),
      valueCents: perk.unit === "USD" ? used : Math.round(used * cpp),
    };
  });
  const toCents = (p: PerkLine, n: number) => (p.unit === "USD" ? n : Math.round(n * cpp));

  // Spending and the points it earns: purchases less merchant refunds, never fees,
  // interest or the card's own credits.
  const rules = setup.earnRules.map((r) => ({ rule: r, re: regex(r.pattern) }));
  const earn = new Map<string, EarnLine>();
  let charges = 0;
  let refunds = 0;
  let estimated = 0;
  for (const r of inYear) {
    if (r.lane !== "EXPENSE" || feeIds.has(r.id) || creditIds.has(r.id) || r.section === "Fees" || r.section === "Interest") continue;
    if (r.amountCents < 0) charges -= r.amountCents;
    else refunds += r.amountCents;
    const hit = rules.find(({ rule, re }) => rule.categories.includes(r.category) || (re instanceof RegExp && re.test(textOf(r))));
    const label = hit?.rule.label ?? "Everything else";
    const rate = hit?.rule.rate ?? setup.baseRate;
    const points = (-r.amountCents / 100) * rate;
    const line = earn.get(label) ?? { label, rate, spendCents: 0, points: 0 };
    earn.set(label, { ...line, spendCents: line.spendCents - r.amountCents, points: line.points + points });
    estimated += points;
  }
  const entered = settings.pointsEarned[pointsKey(account.id, year)] ?? null;
  const earned = entered ?? Math.max(0, Math.round(estimated));
  const pointsValue = Math.round(earned * cpp);

  // The fee the statements charged this year; else the card's terms if it was held this year.
  const heldThisYear = account.from != null && account.from <= `${year}-12-31` && (account.through == null || account.through >= `${year}-01-01`);
  const feeSource = feeRows.length ? "STATEMENTS" : heldThisYear && setup.annualFeeCents > 0 ? "TERMS" : "NONE";
  const feeCents = feeSource === "STATEMENTS" ? chargedCents : feeSource === "TERMS" ? setup.annualFeeCents : 0;

  const perksValue = perks.reduce((t, p) => t + p.valueCents, 0);
  const otherCredits = credits.filter((c) => c.kind === "OTHER").reduce((t, c) => t + c.amountCents, 0);
  return {
    accountId: account.id,
    accountName: account.name,
    setup,
    guessed,
    from: account.from,
    through: account.through,
    centsPerPoint: cpp,
    spend: { chargesCents: charges, refundsCents: refunds, netCents: charges - refunds },
    earn: [...earn.values()].map((l) => ({ ...l, points: Math.round(l.points) })).sort((a, b) => b.points - a.points),
    points: { estimated: Math.max(0, Math.round(estimated)), entered, earned, valueCents: pointsValue },
    perks,
    credits,
    fee: { chargedCents, termsCents: setup.annualFeeCents, cents: feeCents, source: feeSource, rows: feeRows.map((r) => ({ id: r.id, date: r.date, payee: r.payee, amountCents: r.amountCents })) },
    perksValueCents: perksValue,
    otherCreditsCents: otherCredits,
    creditsCents: perksValue + otherCredits,
    returnedCents: pointsValue + perksValue + otherCredits,
    remainingCents: perks.reduce((t, p) => t + toCents(p, p.remaining), 0),
    missedCents: perks.reduce((t, p) => t + toCents(p, p.missed), 0),
    netCents: pointsValue + perksValue + otherCredits - feeCents,
  };
}

export function buildCardPerks(input: { settings: CardPerksSettings; accounts: CardAccount[]; rows: PerkRow[]; today: string; year?: number }): CardPerksReport {
  const { settings, accounts, rows, today } = input;
  const thisYear = Number(today.slice(0, 4));
  const year = input.year ?? thisYear;
  const cardIds = new Set(accounts.map((a) => a.id));
  const years = [...new Set([thisYear, ...rows.filter((r) => cardIds.has(r.accountId)).map((r) => Number(r.date.slice(0, 4)))])].sort((a, b) => b - a);

  const inYear = (a: CardAccount) => a.from != null && a.from <= `${year}-12-31` && (a.through == null || a.through >= `${year}-01-01`);
  const shown = accounts.filter(inYear).sort((a, b) => a.name.localeCompare(b.name));
  const cards: CardScore[] = [];
  const hidden: CardPerksReport["hidden"] = [];
  for (const a of shown) {
    const { setup, guessed } = setupFor(settings, a);
    if (setup.hidden) hidden.push({ accountId: a.id, accountName: a.name });
    else cards.push(scoreCard(a, setup, guessed, rows, settings, year, today));
  }
  const sum = (f: (c: CardScore) => number) => cards.reduce((t, c) => t + f(c), 0);
  return {
    year,
    years,
    today,
    centsPerPoint: settings.centsPerPoint,
    cards,
    hidden,
    totals: {
      feesCents: sum((c) => c.fee.cents),
      perksValueCents: sum((c) => c.perksValueCents),
      otherCreditsCents: sum((c) => c.otherCreditsCents),
      creditsCents: sum((c) => c.creditsCents),
      pointsValueCents: sum((c) => c.points.valueCents),
      points: sum((c) => c.points.earned),
      netCents: sum((c) => c.netCents),
      remainingCents: sum((c) => c.remainingCents),
      missedCents: sum((c) => c.missedCents),
      spendCents: sum((c) => c.spend.netCents),
      cardsWithFee: cards.filter((c) => c.fee.cents > 0).length,
      openPerks: sum((c) => c.perks.filter((p) => p.periods.some((x) => x.status === "OPEN")).length),
    },
  };
}
