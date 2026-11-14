import type { K1Coded, K1Form } from "../taxdocs/types.ts";
import type { K1Detail, K1DetailLine, K1Expected, K1Treatment } from "./k1DetailStore.ts";

/**
 * A K-1 as the return uses it: the face's boxes and the details file's statement lines,
 * sorted into the places a 1040 has for them. One pure function, so the return, the K-1
 * table on the Income tab and the completeness check all read the same sorting.
 */

export type K1StateItems = { addition: number; subtraction: number; sourceIncome: number; pteCredit: number; withheld: number };

export type K1Items = {
  interest: number;
  ordinaryDividends: number;
  qualifiedDividends: number;
  royalties: number;
  shortTermGain: number;
  /** Net long-term gain, with a net section 1231 gain, 60% of section 1256 gain, and less any section 1061 amount. */
  longTermGain: number;
  /** Parts of the long-term gain taxed at up to 28% and 25%. */
  collectiblesGain: number;
  unrecaptured1250Gain: number;
  /** Boxes 1–3 and the statement lines of the partnership's own activity, net (a section 1231 loss is ordinary). */
  activity: number;
  /** Whether that activity is passive for this partner (Form 8582). */
  passive: boolean;
  /** Other portfolio income: ordinary, and investment income. */
  otherPortfolioIncome: number;
  guaranteedPayments: number;
  seEarnings: number;
  /** Positive cents. */
  investmentInterestExpense: number;
  investmentExpensesNiiOnly: number;
  foreignTax: number;
  foreignSourceIncome: number;
  qbi: { income: number; w2Wages: number; ubia: number; sstb: boolean; reitDividends: number };
  amtAdjustments: number;
  taxExemptInterest: number;
  usObligationInterest: number;
  states: Record<string, K1StateItems>;
};

const sumOf = (lines: K1DetailLine[], t: K1Treatment) => lines.filter((l) => l.treatment === t).reduce((s, l) => s + l.cents, 0);
/** Deductions are positive however the statement signs them. */
const expense = (lines: K1DetailLine[], t: K1Treatment) => lines.filter((l) => l.treatment === t).reduce((s, l) => s + Math.abs(l.cents), 0);

/** Boxes 1–3 are passive for a limited partner, except in a fund that trades for its own account (which is never a passive activity). */
export function k1Passive(form: Pick<K1Form, "limitedPartner">, detail: K1Detail | null): boolean {
  if (detail?.passive != null) return detail.passive;
  if (detail?.activity === "TRADER_FUND") return false;
  if (detail?.activity === "RENTAL") return true;
  return form.limitedPartner;
}

export function k1Items(form: K1Form, detail: K1Detail | null): K1Items {
  const lines = detail?.lines ?? [];
  const s = (t: K1Treatment) => sumOf(lines, t);
  const s1256 = s("SECTION_1256");
  const long1256 = Math.round(s1256 * 0.6);
  const recharacterized = s("SECTION_1061_RECHARACTERIZED");
  const states: Record<string, K1StateItems> = {};
  const state = (code: string) => (states[code] ??= { addition: 0, subtraction: 0, sourceIncome: 0, pteCredit: 0, withheld: 0 });
  for (const l of lines) {
    if (!l.state) continue;
    if (l.treatment === "STATE_ADDITION") state(l.state).addition += Math.abs(l.cents);
    if (l.treatment === "STATE_SUBTRACTION") state(l.state).subtraction += Math.abs(l.cents);
    if (l.treatment === "STATE_SOURCE_INCOME") state(l.state).sourceIncome += l.cents;
    if (l.treatment === "PTE_TAX_CREDIT") state(l.state).pteCredit += Math.abs(l.cents);
    if (l.treatment === "STATE_TAX_WITHHELD") state(l.state).withheld += Math.abs(l.cents);
  }
  return {
    interest: form.interest,
    ordinaryDividends: form.ordinaryDividends,
    qualifiedDividends: form.qualifiedDividends,
    royalties: form.royalties,
    shortTermGain: form.shortTermGain + s("SHORT_TERM_GAIN") + (s1256 - long1256) + recharacterized,
    longTermGain: form.longTermGain + Math.max(0, form.section1231) + s("LONG_TERM_GAIN") + long1256 - recharacterized,
    collectiblesGain: form.collectibles28 + s("COLLECTIBLES_GAIN"),
    unrecaptured1250Gain: form.unrecaptured1250 + s("UNRECAPTURED_1250_GAIN"),
    activity: form.ordinaryBusiness + form.rentalRealEstate + form.otherRental + Math.min(0, form.section1231) + s("ORDINARY_ACTIVITY"),
    passive: k1Passive(form, detail),
    otherPortfolioIncome: s("ORDINARY_PORTFOLIO"),
    guaranteedPayments: form.guaranteedTotal || form.guaranteedPayments + form.guaranteedCapital,
    seEarnings: s("SE_EARNINGS"),
    investmentInterestExpense: expense(lines, "INVESTMENT_INTEREST_EXPENSE"),
    investmentExpensesNiiOnly: expense(lines, "INVESTMENT_EXPENSE_NII_ONLY"),
    foreignTax: form.foreignTax + expense(lines, "FOREIGN_TAX"),
    foreignSourceIncome: s("FOREIGN_SOURCE_PASSIVE") + s("FOREIGN_SOURCE_GENERAL"),
    qbi: { income: s("QBI_INCOME"), w2Wages: s("QBI_W2_WAGES"), ubia: s("QBI_UBIA"), sstb: lines.some((l) => l.treatment === "QBI_SSTB" && l.cents !== 0), reitDividends: s("QBI_REIT_DIVIDENDS") },
    amtAdjustments: s("AMT_ADJUSTMENT"),
    taxExemptInterest: s("TAX_EXEMPT_INTEREST"),
    usObligationInterest: s("US_OBLIGATION_INTEREST"),
    states,
  };
}

export type K1Gap = { box: string; code: string; why: string };

const usd = (cents: number) => `${cents < 0 ? "−" : ""}$${Math.abs(Math.round(cents / 100)).toLocaleString("en-US")}`;

/** The details lines for one lettered entry of the face (a bare "see statement" takes any line of its box). */
export function k1LinesFor(detail: K1Detail | null, e: Pick<K1Coded, "box" | "code">): K1DetailLine[] {
  return (detail?.lines ?? []).filter((l) => l.box === e.box && (e.code === "" || (l.code ?? "") === e.code));
}

/**
 * What of a K-1 hasn't been taken in yet: a lettered entry with no line in the details file
 * (its meaning is the year's code list and its statement, which only a reading of the K-1
 * gives), and lines that don't add up to the amount the face prints for their entry.
 */
export function k1Gaps(form: K1Form, detail: K1Detail | null): K1Gap[] {
  const out: K1Gap[] = [];
  for (const e of form.coded) {
    const lines = k1LinesFor(detail, e);
    const name = `Box ${e.box}${e.code ? ` code ${e.code}` : ""}`;
    if (!lines.length) {
      // A bare "see statement" is answered by its box's other entries being read.
      if (e.code === "" && form.coded.some((o) => o.box === e.box && o.code !== "")) continue;
      out.push({ box: e.box, code: e.code, why: `${name}${e.statement ? " points to an attached statement that" : ""} hasn't been read into the K-1 details file.` });
      continue;
    }
    if (e.code === "" || e.cents == null) continue;
    const sum = lines.reduce((s, l) => s + l.cents, 0);
    if (Math.abs(Math.abs(sum) - Math.abs(e.cents)) >= 100) out.push({ box: e.box, code: e.code, why: `${name} prints ${usd(e.cents)}, but its lines in the K-1 details file add to ${usd(sum)}.` });
  }
  return out;
}

/** A K-1 from a scan made before the reader kept every box: the boxes it lacks read as empty (the scan's version says it's due a rescan). */
export function completeK1(form: K1Form): K1Form {
  return {
    ...form,
    guaranteedCapital: form.guaranteedCapital ?? 0,
    guaranteedTotal: form.guaranteedTotal ?? 0,
    dividendEquivalents: form.dividendEquivalents ?? 0,
    collectibles28: form.collectibles28 ?? 0,
    unrecaptured1250: form.unrecaptured1250 ?? 0,
    coded: form.coded ?? [],
    k3Attached: form.k3Attached ?? false,
    amended: form.amended ?? false,
    generalPartner: form.generalPartner ?? false,
    publiclyTraded: form.publiclyTraded ?? false,
    multipleActivities: form.multipleActivities ?? false,
    share: form.share ?? { profit: null, loss: null, capital: null },
    capital: form.capital ?? { beginning: null, contributed: null, netIncome: null, withdrawals: null, ending: null },
  };
}

/** A K-1 that hasn't come yet, as a form: last year's (when there is one) with the expected figures over it. */
export function expectedK1(base: K1Form | null, partnership: string, ein: string, expected: K1Expected): K1Form {
  const zero: K1Form = {
    partnership,
    ein,
    partner: base?.partner ?? "",
    limitedPartner: base?.limitedPartner ?? true,
    final: false,
    periodStart: null,
    periodEnd: null,
    ordinaryBusiness: 0,
    rentalRealEstate: 0,
    otherRental: 0,
    guaranteedPayments: 0,
    interest: 0,
    ordinaryDividends: 0,
    qualifiedDividends: 0,
    royalties: 0,
    shortTermGain: 0,
    longTermGain: 0,
    section1231: 0,
    foreignTax: 0,
    guaranteedCapital: 0,
    guaranteedTotal: 0,
    dividendEquivalents: 0,
    collectibles28: 0,
    unrecaptured1250: 0,
    coded: [],
    k3Attached: false,
    amended: false,
    generalPartner: base?.generalPartner ?? false,
    publiclyTraded: base?.publiclyTraded ?? false,
    multipleActivities: false,
    share: { profit: null, loss: null, capital: null },
    capital: { beginning: null, contributed: null, netIncome: null, withdrawals: null, ending: null },
  };
  return { ...zero, ...expected };
}

const DAY = 86_400_000;

/**
 * A K-1 that covered only part of its year (the partner joined mid-year), scaled to twelve
 * months: what the same partnership would report for a full year at that rate. Null when
 * the K-1 covered the whole year or prints no period.
 */
export function annualizedK1(form: K1Form): { form: K1Form; days: number } | null {
  if (!form.periodStart || !form.periodEnd) return null;
  const days = Math.round((Date.parse(form.periodEnd) - Date.parse(form.periodStart)) / DAY) + 1;
  if (!(days > 0) || days >= 360) return null;
  const up = (c: number) => Math.round((c * 365) / days);
  return {
    days,
    form: {
      ...form,
      ordinaryBusiness: up(form.ordinaryBusiness),
      rentalRealEstate: up(form.rentalRealEstate),
      otherRental: up(form.otherRental),
      guaranteedPayments: up(form.guaranteedPayments),
      guaranteedCapital: up(form.guaranteedCapital),
      guaranteedTotal: up(form.guaranteedTotal),
      interest: up(form.interest),
      ordinaryDividends: up(form.ordinaryDividends),
      qualifiedDividends: up(form.qualifiedDividends),
      dividendEquivalents: up(form.dividendEquivalents),
      royalties: up(form.royalties),
      shortTermGain: up(form.shortTermGain),
      longTermGain: up(form.longTermGain),
      collectibles28: up(form.collectibles28),
      unrecaptured1250: up(form.unrecaptured1250),
      section1231: up(form.section1231),
      foreignTax: up(form.foreignTax),
    },
  };
}

/** The face's boxes, with where each lands on the return. */
export const K1_FACE_ROWS: readonly [keyof K1Form & string, string, string][] = [
  ["ordinaryBusiness", "Box 1 · Ordinary business income", "Schedule E"],
  ["rentalRealEstate", "Box 2 · Net rental real estate income", "Schedule E"],
  ["otherRental", "Box 3 · Other net rental income", "Schedule E"],
  ["guaranteedPayments", "Box 4a · Guaranteed payments for services", "Schedule E"],
  ["guaranteedCapital", "Box 4b · Guaranteed payments for capital", "Schedule E"],
  ["interest", "Box 5 · Interest income", "Interest"],
  ["ordinaryDividends", "Box 6a · Ordinary dividends", "Ordinary dividends"],
  ["qualifiedDividends", "Box 6b · Qualified dividends", "Qualified dividends"],
  ["dividendEquivalents", "Box 6c · Dividend equivalents", "Information"],
  ["royalties", "Box 7 · Royalties", "Schedule E"],
  ["shortTermGain", "Box 8 · Net short-term capital gain", "Schedule D, short-term"],
  ["longTermGain", "Box 9a · Net long-term capital gain", "Schedule D, long-term"],
  ["collectibles28", "Box 9b · Collectibles gain", "Part of the long-term gain"],
  ["unrecaptured1250", "Box 9c · Unrecaptured section 1250 gain", "Part of the long-term gain"],
  ["section1231", "Box 10 · Net section 1231 gain", "Form 4797"],
  ["foreignTax", "Box 21 · Foreign taxes paid", "Foreign tax credit"],
];

/** What the return does with a statement line, in a few words (no figures: these are drawn as words). */
export const K1_TREATMENT_LABEL: Record<K1Treatment, string> = {
  ORDINARY_PORTFOLIO: "Other income",
  ORDINARY_ACTIVITY: "Schedule E",
  SHORT_TERM_GAIN: "Schedule D, short-term",
  LONG_TERM_GAIN: "Schedule D, long-term",
  SECTION_1256: "Schedule D, split long and short",
  SECTION_1061_RECHARACTERIZED: "Long-term taxed as short-term",
  COLLECTIBLES_GAIN: "Part of the long-term gain",
  UNRECAPTURED_1250_GAIN: "Part of the long-term gain",
  INVESTMENT_INTEREST_EXPENSE: "Investment interest (itemized)",
  INVESTMENT_EXPENSE_NII_ONLY: "Lowers investment income tax only",
  PORTFOLIO_DEDUCTION_NOT_DEDUCTIBLE: "Not deductible",
  SE_EARNINGS: "Self-employment tax",
  QBI_INCOME: "Business income deduction",
  QBI_W2_WAGES: "Business income deduction limit",
  QBI_UBIA: "Business income deduction limit",
  QBI_SSTB: "Business income deduction limit",
  QBI_REIT_DIVIDENDS: "Business income deduction",
  FOREIGN_SOURCE_PASSIVE: "Foreign tax credit limit",
  FOREIGN_SOURCE_GENERAL: "Foreign tax credit limit",
  FOREIGN_TAX: "Foreign tax credit",
  AMT_ADJUSTMENT: "Alternative minimum tax",
  TAX_EXEMPT_INTEREST: "Tax-exempt interest",
  US_OBLIGATION_INTEREST: "Not taxed by the states",
  STATE_ADDITION: "State addition",
  STATE_SUBTRACTION: "State subtraction",
  STATE_SOURCE_INCOME: "State source income",
  PTE_TAX_CREDIT: "State credit",
  STATE_TAX_WITHHELD: "State tax paid",
  INFORMATION_ONLY: "Information only",
};

export type K1Row = { id: string; label: string; cents: number; where: string };

/** A K-1's rows for the Income tab: each face box with an amount, each lettered entry the face prints an amount for, and each statement line of the details file. */
export function k1Rows(form: K1Form, detail: K1Detail | null): K1Row[] {
  const out: K1Row[] = [];
  for (const [key, label, where] of K1_FACE_ROWS) {
    const cents = form[key] as number;
    if (cents) out.push({ id: `face:${key}`, label, cents, where });
  }
  form.coded.forEach((e, i) => {
    if (e.cents == null || e.code === "" || k1LinesFor(detail, e).length) return;
    out.push({ id: `coded:${i}`, label: `Box ${e.box} · code ${e.code}`, cents: e.cents, where: "Not read yet" });
  });
  (detail?.lines ?? []).forEach((l, i) => out.push({ id: `line:${i}`, label: `Box ${l.box}${l.code ? ` ${l.code}` : ""} · ${l.label}`, cents: l.cents, where: `${K1_TREATMENT_LABEL[l.treatment]}${l.state ? ` (${l.state})` : ""}` }));
  return out;
}
