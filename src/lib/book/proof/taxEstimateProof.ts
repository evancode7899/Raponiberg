import { formatUsdFromCents } from "../../formatMoney.ts";
import { taxLink } from "../../forecast/forecast.ts";
import { loadForecast } from "../../forecast/load.ts";
import { buildTaxReport, type AccountIncome, type InvestmentFigures, type PersonReport, type TaxReport } from "../../tax/buildTaxReport.ts";
import type { PersonIncome, W2 } from "../../tax/computeReturn.ts";
import { yearDocs } from "../../tax/documents.ts";
import {
  ESTIMATE_LINES,
  estimateColumns,
  estimateRows,
  isEstimateKey,
  lineValue,
  type EstimateBasis,
  type EstimateColumn,
  type EstimateKey,
} from "../../tax/estimateLines.ts";
import type { TaxAuthority } from "../../tax/facts/payments.ts";
import { ZERO_AMOUNTS, type PayrollAmounts } from "../../tax/facts/payroll.ts";
import { asFiled } from "../../tax/filedCheck.ts";
import { FILING_STATUS_LABEL, TAX_YEARS, taxYearParams, type TaxYearParams } from "../../tax/params.ts";
import { returnSchedules } from "../../tax/schedules.ts";
import { taxBlockers, taxYearThrough } from "../blockers.ts";
import type { Book, BookRow } from "../load.ts";
import { personPayYear } from "../pay.ts";
import type { CheckId } from "../types.ts";
import { checksFor, perBook, sumCheck, unreviewedEstimate } from "./common.ts";
import { groupRows, type PayLine } from "./payProof.ts";
import type { ChainLine, Proof, ProofBlock, ProofContext, ProofEstimate, ProofKind, ProofLink, ProofValue } from "./types.ts";

/**
 * The proof behind a line of a year's tax estimate (Taxes › Worksheet, Overview, Income,
 * Payments; Filed return's "This app" column). A tax figure is worked out, not read off a
 * statement, so its proof is a chain: the line's inputs and the arithmetic that joins them,
 * each input linking to its own proof. Lines built from other lines (AGI, taxable income,
 * the tax) link to those lines' proofs; the leaves are where the figures come from:
 *
 *  - W-2 boxes: a W-2 form on file (proven, naming the document), else the pay stubs'
 *    year-to-date lines, each opening the pay proof for that person, employer and line;
 *  - brokerage interest, dividends and gains: the latest statement's tax figures (proven,
 *    naming the statement) or the year's 1099;
 *  - bank interest: each account's interest rows, opening the cash-flow proof;
 *  - tax payments: the bank rows that paid them;
 *  - brackets, the standard deduction, caps and rates: tax law for the year (params.ts);
 *  - amounts typed under Inputs: the owner's assumptions.
 *
 * The year in progress is a run-rate forecast (the W-4 / prepayment plan): whatever the
 * projection adds after the latest stub and statement is marked "estimate".
 *
 * TODO(forecast proof): the projected paychecks and bonuses come from the shared forecast
 * (lib/forecast: paycheck basis, scheduled bonuses). Once the "forecast" proof kind is
 * registered, the "after the latest stub" estimate lines link to its pay lines for the
 * person and year instead of only describing them.
 *
 * Every figure is re-derived through the page's own code: buildTaxReport (with the same
 * forecast link and birth years as api/tax), estimateColumns and ESTIMATE_LINES
 * (lib/tax/estimateLines.ts), and, for the Filed return tab, filedCheck's asFiled.
 */

/** The page's basis, or "filed": the joint return as the Filed return tab compares it (whole dollars). */
export type TaxEstimateBasis = EstimateBasis | "filed";

/** The Payments tab's totals: the year's estimated payments to one authority found in the bank ledger. */
export type FoundKey = "found.FEDERAL" | "found.CT";
const FOUND: Record<FoundKey, { authority: TaxAuthority; label: string }> = {
  "found.FEDERAL": { authority: "FEDERAL", label: "Federal estimated payments found in the bank ledger" },
  "found.CT": { authority: "CT", label: "Connecticut estimated payments found in the bank ledger" },
};

export type TaxEstimateDescriptor = {
  report: "tax-estimate";
  year: number;
  basis: TaxEstimateBasis;
  /** A spouse's own separate return (the worksheet's columns); omitted: the joint return. */
  filer?: string;
  key: EstimateKey | FoundKey;
};

/** The checks that can withhold a tax figure: taxBlockers' pay, tax and bank-account findings. */
export const TAX_ESTIMATE_CHECKS: CheckId[] = [
  "tax.params",
  "tax.documents-tie",
  "tax.brokerage-coverage",
  "paystub.arithmetic",
  "paystub.person",
  "paystub.deposit",
  "pay.continuity",
  "pay.after-last-stub",
  "pay.deposits-tie",
  "pay.unexplained-deposits",
  "pay.year-gap",
  "retirement.contributions",
  "statement.chain",
  "statement.gap",
  "ledger.freshness",
];

const isFound = (k: unknown): k is FoundKey => typeof k === "string" && Object.hasOwn(FOUND, k);

export function parseTaxEstimateDescriptor(d: Record<string, unknown>): TaxEstimateDescriptor | { error: string } {
  if (typeof d.year !== "number" || !Object.hasOwn(TAX_YEARS, d.year)) return { error: `year must be one of: ${Object.keys(TAX_YEARS).join(", ")}.` };
  if (d.basis !== "projected" && d.basis !== "ytd" && d.basis !== "filed") return { error: "basis must be projected, ytd or filed." };
  if (!isEstimateKey(d.key) && !isFound(d.key)) return { error: "key isn't a tax estimate line." };
  if (d.filer != null && (typeof d.filer !== "string" || !d.filer)) return { error: "filer must be a person's id." };
  if (d.basis === "filed" && (d.filer != null || !/^(fed|ct|ny)\./.test(d.key as string))) return { error: "The filed comparison is the joint return's federal, Connecticut and New York lines." };
  return { report: "tax-estimate", year: d.year, basis: d.basis, ...(d.filer ? { filer: d.filer as string } : {}), key: d.key as TaxEstimateDescriptor["key"] };
}

// ---------------------------------------------------------------- building blocks

const money = (c: number) => (c === 0 ? "$0.00" : formatUsdFromCents(c));
const usd0 = (c: number) => `${c < 0 ? "−" : ""}$${Math.abs(Math.round(c / 100)).toLocaleString("en-US")}`;
const pct = (r: number, digits = 2) => `${(Math.round(r * 10 ** (digits + 2)) / 10 ** digits).toString()}%`;
const cents = (v: number): ProofValue => ({ cents: v });
const pos = (n: number) => Math.max(0, n);

type Op = ChainLine["op"];
const ln = (op: Op, label: string, value: number | ProofValue, source: ChainLine["source"], note?: string, link?: ProofLink): ChainLine => ({
  ...(op ? { op } : {}),
  label,
  value: typeof value === "number" ? cents(value) : value,
  source,
  ...(note ? { note } : {}),
  ...(link ? { link } : {}),
});

/** A chain's first line starts it: a leading "+" is dropped (a leading "−" subtracts from zero). */
const seq = (lines: ChainLine[]): ChainLine[] => lines.map((l, i) => (i === 0 && l.op === "+" ? { ...l, op: undefined } : l));

/**
 * Works a chain through: each line adds, subtracts, multiplies or divides into the running
 * figure; an "=" line must match it (to the half cent a rounded step allows) and carries on
 * from its own value. Lines with words for values don't count.
 */
export function evalChain(lines: ChainLine[]): { value: number; ok: boolean; delta: number } {
  let acc = 0;
  let ok = true;
  let delta = 0;
  for (const l of lines) {
    const v = "cents" in l.value ? l.value.cents : "ratio" in l.value ? l.value.ratio : null;
    if (v == null) continue;
    switch (l.op) {
      case undefined:
        acc = v;
        break;
      case "+":
        acc += v;
        break;
      case "−":
        acc -= v;
        break;
      case "×":
        acc *= v;
        break;
      case "÷":
        acc = v ? acc / v : 0;
        break;
      case "=":
        if (Math.abs(acc - v) > 0.5 + 1e-6) {
          ok = false;
          delta += acc - v;
        }
        acc = v;
    }
  }
  return { value: acc, ok, delta };
}

/** What a line's proof is built from. */
type X = {
  book: Book;
  d: TaxEstimateDescriptor;
  report: TaxReport;
  params: TaxYearParams;
  col: EstimateColumn;
  cols: EstimateColumn[];
  /** The people on this return, in the order of col.incomes. */
  people: PersonReport[];
  pick: "ytd" | "projected";
  /** A finished year: its forms and K-1s are its figures. */
  finished: boolean;
  /** The pay stubs' cutoff for the year (taxYearThrough). */
  through: string;
  /** Supporting blocks the explainers add below the main chain. */
  blocks: ProofBlock[];
  /** Bank rows the figure counts (interest, payments). */
  rows: BookRow[];
};

const label = (k: EstimateKey) => ESTIMATE_LINES[k].label;
const val = (x: X, k: EstimateKey) => lineValue(k, x.col, x.cols) ?? 0;
const selfLink = (x: X, k: EstimateKey, extra: Partial<TaxEstimateDescriptor> = {}): ProofLink => ({ label: label(k), descriptor: { ...x.d, key: k, ...extra } });
/** Another line of the same return, linked to its proof. */
const ref = (x: X, op: Op, k: EstimateKey, note?: string): ChainLine => ln(op, label(k), val(x, k), "derived", note, selfLink(x, k));
const who = (x: X, p: PersonReport) => (x.people.length > 1 ? `${p.name} · ` : "");
const nPeople = (x: X) => x.report.people.length;
const shortEmployer = (s: string) => s.replace(/ · payroll .*$/, "");
const fsLabel = (x: X) => FILING_STATUS_LABEL[x.col.r.filingStatus].toLowerCase();
const lawNote = (x: X, what: string) => `${what}, ${x.d.year} tax law (${fsLabel(x)}).`;

/** The latest stub's employer key for a payroll entry, for links to its pay proof. */
function employerKeyOf(x: X, p: PersonReport, e: PersonReport["payroll"][number]): string | null {
  const year = personPayYear(x.book, p.id, x.d.year, x.through);
  return year.employers.find((em) => em.employer === e.employer && em.lastPayDate === e.latestPayDate)?.employerKey ?? null;
}

function payLink(x: X, p: PersonReport, e: PersonReport["payroll"][number], line: PayLine): ProofLink | undefined {
  const key = employerKeyOf(x, p, e);
  if (!key) return undefined;
  return {
    label: `${p.name} · ${shortEmployer(e.employer)} ${line === "base" ? "base pay" : "bonus"}, ${x.d.year}`,
    descriptor: { report: "pay", basis: "ytd", personId: p.id, employerKeys: [key], lines: [line], year: x.d.year, through: x.through },
  };
}

const formOnly = (e: PersonReport["payroll"][number]) => !e.latestPayDate;

/** How the projection fills the rest of the year for an employer (the run-rate forecast). */
function projectionNote(x: X, p: PersonReport, e: PersonReport["payroll"][number]): string {
  const n = e.remainingPayDates.length;
  const repeat = n && e.regularPaycheck ? `${n} more paycheck${n === 1 ? "" : "s"} repeat the ${e.basis === "TYPICAL" ? "typical recent" : "latest"} regular paycheck (${money(e.regularPaycheck.gross)} gross)${e.payThrough ? `, ending ${e.payThrough}` : ""}` : "";
  const typed = x.report.inputs.people[p.id]?.extras.expectedBonus ?? 0;
  const fromForecast = p.fromForecast?.bonus ?? 0;
  const bonus = e.extraBonus
    ? `${money(e.extraBonus)} expected bonus${fromForecast ? ` (${money(fromForecast)} from the forecast: ${p.fromForecast!.items.map((i) => i.label).join(", ")})` : ""}${typed ? ` (${money(typed)} typed under Inputs)` : ""}, withheld at the supplemental rates`
    : "";
  const what = [repeat, bonus].filter(Boolean).join("; ");
  return `${what ? `${what}. ` : ""}Projected after the ${e.latestPayDate} stub: 401(k) deferrals stop at the annual limit and Social Security at the wage base.`;
}

const PAY_FIELD: Partial<Record<keyof PayrollAmounts, { name: string; link?: PayLine; sign: 1 | -1 }>> = {
  regular: { name: "base pay", link: "base", sign: 1 },
  bonus: { name: "bonus", link: "bonus", sign: 1 },
  imputed: { name: "taxable benefits (imputed income)", sign: 1 },
  section125: { name: "pre-tax health, dental, vision (§125)", sign: -1 },
  hsa: { name: "HSA from pay", sign: -1 },
  dependentCareFsa: { name: "dependent care FSA", sign: -1 },
  retirementPretax: { name: "pre-tax 401(k)", sign: -1 },
};

/** Pay-stub totals for some fields (all added), employer by employer: year to date, then the projection. */
function payrollLines(x: X, fields: (keyof PayrollAmounts)[]): ChainLine[] {
  const out: ChainLine[] = [];
  for (const p of x.people) {
    for (const e of p.payroll) {
      const emp = shortEmployer(e.employer);
      for (const f of fields) {
        const v = e.ytd[f];
        if (!v) continue;
        const def = PAY_FIELD[f]!;
        out.push(
          formOnly(e)
            ? ln("+", `${who(x, p)}${emp} W-2: ${def.name}`, v, "proven", `Read off ${e.w2Doc?.file ?? "the W-2"}; no pay stubs from this employer.`)
            : ln("+", `${who(x, p)}${emp}: ${def.name}, year to date on the ${e.latestPayDate} stub`, v, "proven", undefined, def.link ? payLink(x, p, e, def.link) : undefined),
        );
      }
      if (x.pick === "projected") {
        const diff = fields.reduce((t, f) => t + e.projected[f] - e.ytd[f], 0);
        if (diff) out.push(ln("+", `${who(x, p)}${emp}: paychecks after ${e.latestPayDate}`, diff, "estimate", projectionNote(x, p, e)));
      }
    }
  }
  return out;
}

const BOX: Partial<Record<keyof W2, string>> = {
  box1Wages: "box 1 wages",
  box5MedicareWages: "box 5 Medicare wages",
  federalWithheld: "box 2 federal tax withheld",
  ssWithheld: "box 4 Social Security withheld",
  medicareWithheld: "box 6 Medicare withheld",
  stateWithheld: "box 17 Connecticut tax withheld",
  nyWithheld: "New York State tax withheld",
  nycWithheld: "box 19 New York City tax withheld",
};

/** One W-2 box across the return's W-2s: the form on file, else the pay stubs' year-to-date lines (wages by part), then the projection. */
function w2Lines(x: X, fields: (keyof W2)[]): ChainLine[] {
  const out: ChainLine[] = [];
  x.people.forEach((p, pi) => {
    p.payroll.forEach((e, i) => {
      const w2 = x.col.incomes[pi]!.w2s[i];
      if (!w2) return;
      const emp = shortEmployer(e.employer);
      for (const field of fields) {
        const v = (w2[field] as number | undefined) ?? 0;
        if (e.w2Doc) {
          if (v) out.push(ln("+", `${who(x, p)}W-2 from ${emp}, ${BOX[field]}`, v, "proven", `Read off ${e.w2Doc.file}.`));
          continue;
        }
        const ytd = (e.w2Ytd[field] as number | undefined) ?? 0;
        if (field === "box1Wages" || field === "box5MedicareWages") {
          const parts: (keyof PayrollAmounts)[] = ["regular", "bonus", "imputed", "section125", "hsa", "dependentCareFsa", ...(field === "box1Wages" ? (["retirementPretax"] as const) : [])];
          for (const f of parts) {
            const a = e.ytd[f];
            if (!a) continue;
            const def = PAY_FIELD[f]!;
            out.push(ln(def.sign < 0 ? "−" : "+", `${who(x, p)}${emp}: ${def.name}, year to date on the ${e.latestPayDate} stub`, a, "proven", undefined, def.link ? payLink(x, p, e, def.link) : undefined));
          }
        } else if (ytd) out.push(ln("+", `${who(x, p)}${emp}: ${BOX[field] ?? field}, year to date on the ${e.latestPayDate} stub`, ytd, "proven"));
        if (v - ytd) out.push(ln("+", `${who(x, p)}${emp}: paychecks after ${e.latestPayDate}`, v - ytd, "estimate", projectionNote(x, p, e)));
      }
    });
  });
  return out;
}

const INV_WORD: Record<keyof InvestmentFigures, string> = {
  ordinaryDividends: "ordinary dividends",
  qualifiedDividends: "qualified dividends",
  moneyMarketDividends: "money-market dividends",
  interest: "interest",
  capGainDistShort: "short-term capital gain distributions",
  capGainDistLong: "capital gain distributions",
  shortTermGain: "short-term realized gain",
  longTermGain: "long-term realized gain",
  foreignTax: "foreign tax paid",
  taxExempt: "tax-exempt interest",
  section199a: "REIT (section 199A) dividends",
  usTreasury: "US Treasury interest",
};

const accountShare = (x: X, a: AccountIncome, p: PersonReport) => (a.ownerId === p.id ? 1 : a.ownerId === "JOINT" ? 1 / nPeople(x) : 0);

/** A person's taxable brokerage accounts' figure, each rounded once as the engine counts it: the statement (or 1099), then the run to December 31. */
function investmentLines(x: X, p: PersonReport, k: keyof InvestmentFigures): ChainLine[] {
  const out: ChainLine[] = [];
  for (const a of x.report.accounts) {
    const share = accountShare(x, a, p);
    if (a.kind !== "TAXABLE" || !share) continue;
    const counted = Math.round(a[x.pick][k] * share);
    const shareNote = share < 1 ? ` A joint account: split evenly, ${Math.round(share * 100)}% each.` : "";
    if (a.source === "1099") {
      if (counted) out.push(ln("+", `${who(x, p)}${a.label}: ${INV_WORD[k]} (1099)`, counted, "proven", `Read off ${a.doc?.file ?? "the year's 1099"}.${shareNote}`));
      continue;
    }
    const ytd = Math.round(a.ytd[k] * share);
    const guessed = k === "qualifiedDividends" || k === "section199a";
    if (ytd)
      out.push(
        ln(
          "+",
          `${who(x, p)}${a.label}: ${INV_WORD[k]} on the statement ending ${a.latestStatement}`,
          ytd,
          guessed ? (a.calibratedFrom ? "estimate" : "assumption") : "proven",
          guessed
            ? a.calibratedFrom
              ? `The year's dividends at the qualified and REIT shares of the account's ${a.calibratedFrom} 1099.${shareNote}`
              : `The statement's dividends, ${Math.round(x.report.profile.qualifiedDividendShare * 100)}% treated as qualified (Inputs; money-market and bond-fund dividends as ordinary).${shareNote}`
            : `Year to date as the ${a.label.split(" ")[0]} statement prints it.${shareNote}`,
        ),
      );
    if (counted - ytd)
      out.push(ln("+", `${who(x, p)}${a.label}: ${INV_WORD[k]} run to December 31`, counted - ytd, "estimate", `× ${a.projection.factor.toFixed(3)} (${a.projection.method === "SEASONAL" ? "last year's month-by-month pattern in the account" : "straight-line run rate"}).`));
  }
  return out;
}

type K1Field = keyof PersonReport["k1s"][number]["figures"];

/** K-1s counted for a person: a finished year's forms, or for a year in progress last year's again (estimates), projected basis only. */
function k1Lines(x: X, p: PersonReport, f: K1Field, opts: { always?: boolean } = {}): ChainLine[] {
  if (!opts.always && x.pick === "ytd" && !x.finished) return [];
  return p.k1s
    .filter((k) => k.figures[f])
    .map((k) => ln("+", `${who(x, p)}K-1 from ${k.partnership}`, k.figures[f], k.estimate ? "estimate" : "proven", k.estimate ? `Last year's K-1 (${k.doc.file}) repeated as an estimate: the partnership didn't mark it final.` : `Read off ${k.doc.file}.`));
}

const extras = (x: X, p: PersonReport) => x.report.inputs.people[p.id]!.extras;
const typed = (x: X, p: PersonReport, op: Op, what: string, v: number): ChainLine[] => (v ? [ln(op, `${who(x, p)}${what}`, v, "assumption", "Typed under Inputs.")] : []);

/** A person's bank interest: each account's interest rows (or 1099-INT), joint accounts split evenly, run to December 31 for a year in progress. */
function bankInterestLines(x: X, p: PersonReport): ChainLine[] {
  const bi = x.report.bankInterest;
  const n = nPeople(x);
  const parts = bi.parts.filter((b) => b.ownerId === p.id || b.ownerId === "JOINT");
  if (!parts.length) return [];
  const sub: ChainLine[] = [];
  for (const b of parts) {
    const share = b.ownerId === "JOINT" ? 1 / n : 1;
    const rows = b.rowIds.map((id) => x.book.rowById.get(id)).filter((r): r is BookRow => !!r);
    x.rows.push(...rows.filter((r) => !x.rows.includes(r)));
    sub.push(
      ln(
        "+",
        `${b.name}${b.doc ? " (1099-INT)" : `: interest ${x.d.year}-01-01 – ${bi.through}`}`,
        b.cents * share,
        "proven",
        b.doc ? `Read off ${b.doc.file}; it replaces the ledger's interest for the account.` : `${rows.length} interest row${rows.length === 1 ? "" : "s"} on the bank statements, ${money(b.cents)} in all.${share < 1 ? ` A joint account: split evenly, ${Math.round(share * 100)}% each.` : ""}`,
        b.accountId && !b.doc
          ? { label: share < 1 ? `All interest on ${b.name} (both halves)` : `Interest, ${b.name}`, descriptor: { report: "cash-flow", metric: "income", granularity: "year", start: `${x.d.year}-01-01`, end: bi.through, category: "Interest", accountIds: [b.accountId] } }
          : undefined,
      ),
    );
  }
  const own = parts.reduce((t, b) => t + b.cents * (b.ownerId === "JOINT" ? 1 / n : 1), 0);
  const runs = x.pick === "projected" && bi.factor !== 1;
  const value = Math.round(runs ? own * bi.factor : own);
  if (runs) sub.push(ln("×", `Run to December 31 (365 ÷ ${Math.round(365 / bi.factor)} days through ${bi.through})`, { ratio: bi.factor }, "estimate"));
  sub.push(ln("=", `${p.name}: bank interest`, value, "derived"));
  x.blocks.push({ kind: "chain", title: `Bank interest · ${p.name}`, lines: seq(sub), note: "Interest the bank statements print (category Interest), from January 1 through the latest date every bank account's statements reach." });
  return [ln("+", `${who(x, p)}Bank interest`, value, runs ? "estimate" : "proven", `Worked out in “Bank interest · ${p.name}” below.`)];
}

/** Lines whose figure is worked out for each person and then added (Social Security, Medicare, PFML): inline for one person, a block each for two. */
function perPerson(x: X, title: string, build: (p: PersonReport, inc: PersonIncome) => ChainLine[]): ChainLine[] {
  if (x.people.length === 1) return build(x.people[0]!, x.col.incomes[0]!);
  return x.people.map((p, i) => {
    const lines = seq(build(p, x.col.incomes[i]!));
    const v = evalChain(lines).value;
    x.blocks.push({ kind: "chain", title: `${title} · ${p.name}`, lines: [...lines, ln("=", `${p.name}: ${title.toLowerCase()}`, Math.round(v), "derived")] });
    return ln("+", `${p.name}: ${title.toLowerCase()}`, Math.round(v), "derived", `Worked out in “${title} · ${p.name}” below.`);
  });
}

/** A bracket schedule's bands (tax law), then the rounding that brings them to the engine's figure. */
function bandLines(x: X, key: string, target: number, what: string): ChainLine[] {
  const s = returnSchedules(x.col.r, x.col.incomes, x.params).find((sc) => sc.key === key);
  if (!s || s.kind !== "brackets") return [ln(undefined, what, target, "derived")];
  const out = s.rows
    .filter((r) => r.included > 0)
    .map((r) => ln("+", `${pct(r.rate)} on ${usd0(r.included)} (${r.to == null ? `over ${usd0(r.from)}` : `${usd0(r.from)} – ${usd0(r.to)}`})`, r.owed, "law", lawNote(x, what)));
  const sum = out.reduce((t, l) => t + (l.value as { cents: number }).cents, 0);
  if (target !== sum) out.push(ln("+", "Rounding (the tax is rounded once, the bands each)", target - sum, "derived"));
  return out.length ? out : [ln("+", `${what}: no income in any band`, 0, "law")];
}

/** The year's estimated payments to one authority: bank rows, split evenly between spouses, plus amounts typed under Inputs. */
function paymentLines(x: X, authority: TaxAuthority, extra?: "estimatedFederalExtra" | "estimatedCtExtra"): ChainLine[] {
  const rows = estimateRows(x.report.payments, x.d.year, authority).filter((p) => x.pick === "projected" || p.date <= x.report.today);
  const total = rows.reduce((t, p) => t + p.amount, 0);
  const n = nPeople(x);
  const half = Math.round(total / n);
  const bankRows = rows.map((p) => x.book.rowById.get(p.transactionId)).filter((r): r is BookRow => !!r);
  x.rows.push(...bankRows.filter((r) => !x.rows.includes(r)));
  const out: ChainLine[] = [
    ln(
      undefined,
      `${rows.length} estimated payment${rows.length === 1 ? "" : "s"} in the bank ledger${x.pick === "ytd" ? ` through ${x.report.today}` : ""}`,
      total,
      "proven",
      rows.length ? rows.map((p) => `${p.date} ${money(p.amount)}${p.basis === "OWNER" ? " (attributed by you)" : ""}`).join(" · ") : "None found for the year.",
    ),
  ];
  if (n > 1) {
    if (x.col.id === "joint") {
      if (half * n !== total) out.push(ln("+", "Split evenly between spouses, each half rounded", half * n - total, "derived"));
    } else out.push(ln("×", "Split evenly between spouses", { ratio: 1 / n }, "derived", "Joint payments count half on each separate return."), ln("=", "This spouse's half", half, "derived"));
  }
  if (extra) for (const p of x.people) out.push(...typed(x, p, "+", "estimated payments not in the bank ledger", extras(x, p)[extra]));
  return out;
}

// ---------------------------------------------------------------- each line

/** The main chain for a line: its inputs and arithmetic, without the closing "=". */
function explain(x: X, key: EstimateKey): ChainLine[] {
  const f = x.col.r.federal;
  const ct = x.col.r.ct;
  const ny = x.col.r.ny;
  const fp = x.params.federal;
  const fs = x.col.r.filingStatus;
  const each = (build: (p: PersonReport, inc: PersonIncome) => ChainLine[]) => x.people.flatMap((p, i) => build(p, x.col.incomes[i]!));
  const finishedOrProjected = x.pick === "projected" || x.finished;
  switch (key) {
    case "pay.salary":
      return payrollLines(x, ["regular"]);
    case "pay.bonus":
      return payrollLines(x, ["bonus"]);
    case "pay.imputed":
      return payrollLines(x, ["imputed"]);
    case "pay.pretax":
      return payrollLines(x, ["section125", "hsa", "dependentCareFsa"]);
    case "pay.k401":
      return payrollLines(x, ["retirementPretax"]);
    case "pay.earned":
      return [ref(x, "+", "pay.salary"), ref(x, "+", "pay.bonus")];
    case "pay.withBenefits":
      return [ref(x, "+", "pay.earned"), ref(x, "+", "pay.imputed")];
    case "pay.medicareWages":
      return w2Lines(x, ["box5MedicareWages"]);
    case "fed.wages":
      return w2Lines(x, ["box1Wages"]);
    case "fed.w2Withholding":
      return w2Lines(x, ["federalWithheld"]);
    case "ct.withheld":
      return w2Lines(x, ["stateWithheld"]);
    case "ny.withheld":
      return w2Lines(x, ["nyWithheld"]);
    case "ny.cityWithheld":
      return w2Lines(x, ["nycWithheld"]);
    case "ny.withheldAll":
      return w2Lines(x, ["nyWithheld", "nycWithheld"]);
    case "fica.ssWithheld":
      return w2Lines(x, ["ssWithheld"]);
    case "fica.medicareWithheld":
      return w2Lines(x, ["medicareWithheld"]);

    case "fed.taxableInterest":
      return each((p) => [...bankInterestLines(x, p), ...investmentLines(x, p, "interest"), ...k1Lines(x, p, "interest"), ...typed(x, p, "+", "other interest", extras(x, p).extraInterest)]);
    case "fed.ordinaryDividends":
      return each((p) => [...investmentLines(x, p, "ordinaryDividends"), ...investmentLines(x, p, "capGainDistShort"), ...k1Lines(x, p, "ordinaryDividends")]);
    case "fed.qualifiedDividends": {
      const lines = each((p) => [...investmentLines(x, p, "qualifiedDividends"), ...k1Lines(x, p, "qualifiedDividends")]);
      const sum = x.col.incomes.reduce((t, i) => t + i.qualifiedDividends, 0);
      if (sum > f.ordinaryDividends) lines.push(ln("−", "More than the ordinary dividends: capped at them", sum - f.ordinaryDividends, "law"));
      return lines;
    }
    case "fed.capitalGain": {
      const lines = each((p) => {
        const e = extras(x, p);
        return [
          ...investmentLines(x, p, "shortTermGain"),
          ...(x.pick === "projected" ? typed(x, p, "+", "expected short-term gains", e.extraShortTermGain) : []),
          ...typed(x, p, "−", "capital loss carried over from earlier years", e.capitalLossCarryover),
          ...k1Lines(x, p, "shortTermGain"),
          ...investmentLines(x, p, "longTermGain"),
          ...(x.pick === "projected" ? typed(x, p, "+", "expected long-term gains", e.extraLongTermGain) : []),
          ...k1Lines(x, p, "longTermGain"),
          ...investmentLines(x, p, "capGainDistLong"),
        ];
      });
      if (f.capitalGainAllowed !== f.capitalGainNet)
        lines.push(ln("+", `Loss over the ${usd0(fp.capitalLossLimit[fs])} limit carries to next year`, f.capitalGainAllowed - f.capitalGainNet, "law", lawNote(x, "Capital loss limit")));
      return lines;
    }
    case "fed.iraTaxable":
      return each((p) => {
        const r = p.retirement;
        if (r.source === "1099-R") return [ln("+", `${who(x, p)}Taxable amount on the year's 1099-R forms`, r.taxable, "proven", "Read off the 1099-Rs in the tax documents folder; rollovers (codes G, H) are never taxable.")];
        const out = [
          ...(r.conversions ? [ln("+", `${who(x, p)}Roth conversions`, r.conversions, "proven", "The IRAs' conversion rows on their statements.")] : []),
          ...(r.otherDistributions ? [ln("+", `${who(x, p)}Other IRA withdrawals`, r.otherDistributions, "proven", "Withdrawals that aren't rollovers or conversions: counted as fully taxable.")] : []),
        ];
        const basis = r.taxable - r.conversions - r.otherDistributions;
        if (basis) out.push(ln("+", `${who(x, p)}Less non-deductible basis (Form 8606 pro-rata)`, basis, "derived", `Basis ${money(r.basis)} (contributions, plus any typed carryforward), spread over the pre-tax IRA money.`));
        return out;
      });
    case "fed.additionalIncome":
      return each((p) => [
        ...typed(x, p, "+", "other income", extras(x, p).otherIncome),
        ...k1Lines(x, p, "otherIncome"),
        ...(finishedOrProjected
          ? p.k1s.filter((k) => !k.suspendedLoss && k.figures.passive).map((k) => ln("+", `${who(x, p)}K-1 from ${k.partnership}: passive income (boxes 1–3)`, k.figures.passive, k.estimate ? "estimate" : "proven", `Read off ${k.doc.file}.`))
          : []),
        ...(p.k401.excess[x.pick]
          ? [ln("+", `${who(x, p)}401(k) deferrals over the limit`, p.k401.excess[x.pick], "law", `${money(p.k401.deferred[x.pick])} deferred against the ${money(p.k401.limit)} limit for ${x.d.year}: the excess is income for the year.`)]
          : []),
      ]);
    case "fed.adjustments":
      return each((p) => [...typed(x, p, "+", "HSA contributions outside payroll", extras(x, p).hsaOutsidePayroll), ...typed(x, p, "+", "other adjustments", extras(x, p).otherAdjustments)]);
    case "fed.investmentIncome":
      return [ref(x, "+", "fed.taxableInterest"), ref(x, "+", "fed.ordinaryDividends"), ref(x, "+", "fed.capitalGain"), ref(x, "+", "fed.iraTaxable"), ref(x, "+", "fed.additionalIncome")];
    case "fed.totalIncome":
      return [ref(x, "+", "fed.wages"), ref(x, "+", "fed.taxableInterest"), ref(x, "+", "fed.ordinaryDividends"), ref(x, "+", "fed.capitalGain"), ref(x, "+", "fed.iraTaxable"), ref(x, "+", "fed.additionalIncome")];
    case "fed.agi":
      return [ref(x, "+", "fed.totalIncome"), ref(x, "−", "fed.adjustments")];
    case "fed.deduction": {
      const it = f.itemized;
      const sum = (g: (i: PersonIncome) => number) => x.col.incomes.reduce((t, i) => t + g(i), 0);
      const itemized: ChainLine[] = [
        ln("+", "State and local tax withheld (W-2s)", sum((i) => i.w2s.reduce((t, w) => t + w.stateWithheld + (w.nyWithheld ?? 0) + (w.nycWithheld ?? 0), 0)), "derived", "Connecticut and New York withholding on the W-2s."),
        ln("+", "Property tax", sum((i) => i.propertyTax), "assumption", "Typed under Inputs (household, split evenly when filing separately)."),
        ref(x, "+", "ct.estimatedPayments"),
        ...(ny ? [ref(x, "+", "ny.estimatedPayments")] : []),
        ln("+", "Other state tax", sum((i) => i.otherStateTax), "assumption", "Typed under Inputs."),
        ln("+", "Earlier years' state tax paid this year", sum((i) => i.priorYearStateTaxPaid), "proven", "Connecticut and New York balance-due payments in the bank ledger this calendar year."),
        ln("=", "State and local tax paid", it.saltPaid, "derived"),
        ln("−", "Over the SALT cap", it.saltPaid - it.salt, "law", lawNote(x, `Cap ${usd0(it.saltCap)} at this AGI`)),
        ln("+", "Mortgage interest", it.mortgageInterest, "assumption", "Typed under Inputs."),
        ln("+", "Charitable gifts above the AGI floor", it.charitable, "assumption", "Gifts typed under Inputs, less the share of AGI the law disallows."),
        ln("+", "Other itemized deductions", it.other, "assumption"),
        ...(it.limitation37 ? [ln("−", "2/37 limitation at the top bracket", it.limitation37, "law", lawNote(x, "Itemized deduction limitation"))] : []),
      ].filter((l) => l.op === "=" || (l.value as { cents: number }).cents !== 0);
      if (f.itemizes) return [...itemized, ...(f.charitableNonItemizer ? [ln("+", "Charity for non-itemizers", f.charitableNonItemizer, "law")] : [])];
      x.blocks.push({ kind: "chain", title: "Itemizing instead", lines: [...seq(itemized), ln("=", "Itemized deductions", it.total, "derived")], note: `Less than the ${usd0(f.standardDeduction)} standard deduction, so the standard deduction is taken.` });
      return [ln(undefined, `Standard deduction, ${fsLabel(x)}`, f.standardDeduction, "law", lawNote(x, "Standard deduction")), ...(f.charitableNonItemizer ? [ln("+", "Cash gifts for non-itemizers", f.charitableNonItemizer, "law", "Gifts typed under Inputs, up to the law's limit.")] : [])];
    }
    case "fed.qbiDeduction": {
      const base = x.col.incomes.reduce((t, i) => t + i.section199aDividends, 0);
      if (!f.qbiDeduction) return [ln(undefined, base ? "Limited to 20% of taxable income less net capital gain: none left" : "No REIT dividends or qualified business income", 0, base ? "law" : "derived")];
      const twenty = Math.round(0.2 * base);
      return [
        ln(undefined, "REIT (section 199A) dividends", base, "proven", "1099-DIV box 5, or the statements' share from last year's 1099."),
        ln("×", "20%", { ratio: 0.2 }, "law", lawNote(x, "QBI deduction")),
        ln("=", "20% of REIT dividends", twenty, "derived"),
        ...(f.qbiDeduction !== twenty ? [ln("−", "Limited to 20% of taxable income less net capital gain", twenty - f.qbiDeduction, "law")] : []),
      ];
    }
    case "fed.taxableIncome": {
      const before = f.agi - f.deduction - f.qbiDeduction;
      return [ref(x, "+", "fed.agi"), ref(x, "−", "fed.deduction"), ref(x, "−", "fed.qbiDeduction"), ...(before < 0 ? [ln("+", "Not below zero", -before, "law")] : [])];
    }
    case "fed.preferentialIncome": {
      const longTerm = x.col.incomes.reduce((t, i) => t + i.longTermGain + i.capitalGainDistributions, 0);
      const lt = pos(Math.min(longTerm, f.capitalGainAllowed));
      const base = f.qualifiedDividends + lt;
      return [ref(x, "+", "fed.qualifiedDividends"), ln("+", "Net long-term gain (when the year's gains net positive)", lt, "derived", "Long-term gains and capital gain distributions, up to the year's net gain."), ...(base > f.taxableIncome ? [ln("−", "More than taxable income", base - f.taxableIncome, "law")] : [])];
    }
    case "fed.tax": {
      x.blocks.push({ kind: "breakdown", title: "Income the brackets apply to", items: [{ label: label("fed.taxableIncome"), value: cents(f.taxableIncome), link: selfLink(x, "fed.taxableIncome") }, { label: label("fed.preferentialIncome"), value: cents(f.preferentialIncome), link: selfLink(x, "fed.preferentialIncome") }], note: "Ordinary income (taxable income less qualified dividends and long-term gains) fills the brackets first; the preferential part stacks on top at 0%, 15% and 20%." });
      return [...bandLines(x, "fed", f.ordinaryTax, "Federal brackets on ordinary income"), ...bandLines(x, "pref", f.preferentialTax, "Qualified dividends and long-term gains").map((l, i) => (i === 0 && !l.op ? { ...l, op: "+" as const } : l))];
    }
    case "fed.amt":
      return [ln(undefined, f.amt ? "Tentative minimum tax over the regular tax (Form 6251, simplified)" : "Tentative minimum tax is below the regular tax: no AMT", f.amt, "derived", "The standard deduction (or the SALT deduction) added back, the AMT exemption and its phase-out, at 26% / 28%.")];
    case "fed.childCredit": {
      const kids = x.col.dependents.filter((dd) => dd.age < 17).length;
      const others = x.col.dependents.length - kids;
      if (!x.col.dependents.length) return [ln(undefined, "No dependents claimed on this return", 0, "derived")];
      const tentative = kids * fp.childTaxCredit.perChild + others * fp.childTaxCredit.otherDependent;
      const reduction = Math.min(tentative, 5_000 * Math.ceil(pos(f.agi - fp.childTaxCredit.phaseoutStart[fs]) / 100_000));
      const used = f.childTaxCredit + f.otherDependentCredit;
      return [
        ...(kids ? [ln("+", `${kids} child${kids === 1 ? "" : "ren"} under 17 × ${usd0(fp.childTaxCredit.perChild)}`, kids * fp.childTaxCredit.perChild, "law", lawNote(x, "Child tax credit"))] : []),
        ...(others ? [ln("+", `${others} other dependent${others === 1 ? "" : "s"} × ${usd0(fp.childTaxCredit.otherDependent)}`, others * fp.childTaxCredit.otherDependent, "law")] : []),
        ...(reduction ? [ln("−", `Phase-out: $50 per $1,000 of AGI over ${usd0(fp.childTaxCredit.phaseoutStart[fs])}`, reduction, "law")] : []),
        ...(tentative - reduction - used ? [ln("−", "More than the tax left after other credits (the refundable part is a payment)", tentative - reduction - used, "derived")] : []),
      ];
    }
    case "fed.otherCredits": {
      const paid = x.col.incomes.reduce((t, i) => t + i.foreignTaxPaid, 0);
      return [
        ln(undefined, "Foreign tax paid (1099-DIV, statements, K-1s)", paid, "proven"),
        ...(paid > f.foreignTaxCredit ? [ln("−", "More than the tax", paid - f.foreignTaxCredit, "law")] : []),
        ln("+", "Dependent care credit", f.dependentCareCredit, "derived", "Care expenses typed under Inputs, less the dependent care FSA, at the year's rate."),
      ];
    }
    case "fed.additionalMedicareTax": {
      const thr = fp.surtaxThreshold[fs];
      const box5 = val(x, "pay.medicareWages");
      return [ref(x, undefined, "pay.medicareWages"), ln("−", "Threshold", thr, "law", lawNote(x, "Additional Medicare tax threshold")), ...(box5 < thr ? [ln("+", "Below the threshold: nothing over it", thr - box5, "law")] : []), ln("×", "0.9%", { ratio: fp.additionalMedicareRate }, "law"), ln("=", "Additional Medicare tax", f.additionalMedicareTax, "derived")];
    }
    case "fed.niit": {
      const over = pos(f.agi - fp.surtaxThreshold[fs]);
      const first =
        f.netInvestmentIncome <= over
          ? ln(undefined, "Net investment income (interest, dividends, gains)", f.netInvestmentIncome, "derived", `Less than AGI over the ${usd0(fp.surtaxThreshold[fs])} threshold (${usd0(over)}), so it's what's taxed.`)
          : ln(undefined, `AGI over the ${usd0(fp.surtaxThreshold[fs])} threshold`, over, "law", `Less than net investment income (${usd0(f.netInvestmentIncome)}), so it's what's taxed.`);
      return [first, ln("×", "3.8%", { ratio: fp.niitRate }, "law", lawNote(x, "Net investment income tax")), ln("=", "Net investment income tax", f.niit, "derived")];
    }
    case "fed.totalTax":
      return [ref(x, "+", "fed.tax"), ref(x, "+", "fed.amt"), ref(x, "−", "fed.childCredit"), ref(x, "−", "fed.otherCredits"), ref(x, "+", "fed.additionalMedicareTax"), ref(x, "+", "fed.niit")];
    case "fed.incomeTax":
      return [ref(x, "+", "fed.tax"), ref(x, "+", "fed.amt"), ref(x, "−", "fed.childCredit"), ref(x, "−", "fed.otherCredits"), ref(x, "−", "fed.refundableChildCredit")];
    case "fed.otherWithholding":
      return x.people.flatMap((p, pi) =>
        p.payroll.flatMap((e, i) => {
          const w = x.col.incomes[pi]!.w2s[i]!;
          const v = pos(w.medicareWithheld - Math.round(w.box5MedicareWages * fp.medicareRate));
          return v ? [ln("+", `${who(x, p)}${shortEmployer(e.employer)}: Medicare withheld over 1.45% of box 5 wages`, v, "derived", `${money(w.medicareWithheld)} withheld against ${money(Math.round(w.box5MedicareWages * fp.medicareRate))} at 1.45%.`)] : [];
        }),
      );
    case "fed.estimatedPayments":
      return paymentLines(x, "FEDERAL", "estimatedFederalExtra");
    case "ct.estimatedPayments":
      return paymentLines(x, "CT", "estimatedCtExtra");
    case "ny.estimatedPayments":
      return paymentLines(x, "OTHER_STATE");
    case "fed.excessSsCredit":
      return x.people.flatMap((p, pi) => {
        const inc = x.col.incomes[pi]!;
        if (inc.w2s.length < 2) return [];
        const withheld = inc.w2s.reduce((t, w) => t + w.ssWithheld, 0);
        const cap = Math.round(fp.socialSecurity.wageBase * fp.socialSecurity.rate);
        return [ln("+", `${who(x, p)}Social Security withheld by ${inc.w2s.length} employers`, withheld, "derived"), ln("−", "6.2% of the wage base", Math.min(withheld, cap), "law", lawNote(x, "Social Security wage base"))];
      });
    case "fed.refundableChildCredit":
      return [ln(undefined, f.refundableChildCredit ? "The child credit the tax couldn't absorb, refunded up to the per-child limit" : "No refundable child credit", f.refundableChildCredit, "derived")];
    case "fed.totalPayments":
      return [ref(x, "+", "fed.w2Withholding"), ref(x, "+", "fed.otherWithholding"), ref(x, "+", "fed.excessSsCredit"), ref(x, "+", "fed.refundableChildCredit"), ref(x, "+", "fed.estimatedPayments")];
    case "fed.balance":
      return [ref(x, "+", "fed.totalTax"), ref(x, "−", "fed.totalPayments")];

    case "ct.federalAgi":
      return [ref(x, "+", "fed.agi")];
    case "ct.usObligationSubtraction":
    case "ny.usObligationSubtraction":
      return perPerson(x, "US-obligation income", (p) => {
        const mm = investmentLines(x, p, "moneyMarketDividends");
        const mmTotal = mm.reduce((t, l) => t + (l.value as { cents: number }).cents, 0);
        return [
          ...(mm.length
            ? [...mm, ln("×", "Share from US obligations", { ratio: x.report.profile.moneyMarketUsGovShare }, "assumption", "Typed under Inputs from the fund's annual percentage."), ln("=", "Money-market dividends from US obligations", Math.round(mmTotal * x.report.profile.moneyMarketUsGovShare), "derived")]
            : []),
          ...investmentLines(x, p, "usTreasury"),
          ...typed(x, p, "+", "other US-obligation income", extras(x, p).usObligationIncome),
        ];
      });
    case "ct.chet": {
      const total = x.col.incomes.reduce((t, i) => t + i.ctChetContributions, 0);
      return [ln(undefined, "CHET 529 contributions on the statements", total, "proven", "The CHET accounts' contribution rows (shared with Account limits)."), ...(total > ct.chetDeduction ? [ln("−", "Over the cap", total - ct.chetDeduction, "law", lawNote(x, `CHET deduction cap ${usd0(x.params.ct.chetDeduction[fs])}`))] : [])];
    }
    case "ct.stateAgi":
      return [ref(x, "+", "ct.federalAgi"), ...(ct.additions ? [ln("+", "Other additions", ct.additions, "assumption")] : []), ref(x, "−", "ct.chet"), ref(x, "−", "ct.usObligationSubtraction"), ...(ct.subtractions - ct.chetDeduction - ct.usObligationSubtraction ? [ln("−", "Other subtractions", ct.subtractions - ct.chetDeduction - ct.usObligationSubtraction, "assumption")] : [])];
    case "ct.exemption": {
      const ex = x.params.ct.exemption[fs];
      return [ln(undefined, "Personal exemption", ex.amount, "law", lawNote(x, "Connecticut personal exemption")), ...(ex.amount - ct.exemption ? [ln("−", `Phase-out: $1,000 per $1,000 of CT AGI over ${usd0(ex.phaseoutStart)}`, ex.amount - ct.exemption, "law")] : [])];
    }
    case "ct.taxableIncome": {
      const tableAgi = ct.sourceIncome == null ? ct.ctAgi : Math.max(ct.ctAgi, ct.sourceIncome);
      return [ref(x, "+", "ct.stateAgi"), ...(tableAgi > ct.ctAgi ? [ln("+", "Part-year: the tables are read at the Connecticut-source income", tableAgi - ct.ctAgi, "law")] : []), ref(x, "−", "ct.exemption"), ...(tableAgi - ct.exemption < 0 ? [ln("+", "Not below zero", ct.exemption - tableAgi, "law")] : [])];
    }
    case "ct.taxBeforeAllocation":
      return [
        ...bandLines(x, "ct", ct.initialTax, "Connecticut brackets"),
        ...(ct.addBack ? [ln("+", "2% rate phase-out add-back (Table C)", ct.addBack, "law", lawNote(x, "CT-1040 Table C"))] : []),
        ...(ct.recapture ? [ln("+", "Benefit recapture (Table D)", ct.recapture, "law", lawNote(x, "CT-1040 Table D"))] : []),
        ...(ct.personalCredit ? [ln("−", `Personal tax credit (${Math.round(ct.personalCreditRate * 100)}%, Table E)`, ct.personalCredit, "law")] : []),
      ];
    case "ct.sourceIncome":
    case "ny.sourceIncome":
      return x.people.flatMap((p) => {
        const s = key === "ct.sourceIncome" ? p.ctSource : p.nySource;
        if (!s) return [];
        if (key === "ct.sourceIncome" && x.report.residency.sourceIncome != null) return [ln("+", `${who(x, p)}Connecticut-source income`, s.total, "assumption", "Typed under Inputs (all on the first person's return).")];
        return [
          ...(s.wages ? [ln("+", `${who(x, p)}Wages earned there`, s.wages, "proven", "The W-2s' state lines, else the stubs paid while a resident or with that state's withholding.")] : []),
          ...(s.investment ? [ln("+", `${who(x, p)}Investment income, ${pct(s.investmentShare, 1)} of the year's`, s.investment, "derived", "The share of the year lived there, line by line in whole dollars.")] : []),
          ...(s.other ? [ln("+", `${who(x, p)}Other income`, s.other, "derived")] : []),
        ];
      });
    case "ct.otherStateCredit": {
      const typedOther = x.col.incomes.reduce((t, i) => t + i.otherStateTax, 0);
      return [ln(undefined, "Other state tax (typed under Inputs)", typedOther, "assumption"), ...(ct.otherStateCredit - typedOther ? [ln("+", "New York tax on income Connecticut also taxes (Schedule 2)", ct.otherStateCredit - typedOther, "derived", "The lesser of New York's tax and Connecticut's tax on the same income.")] : [])];
    }
    case "ct.childTaxCredit":
      return [ln(undefined, ct.childTaxCredit ? "Children 16 or under, phased out by federal AGI" : "No Connecticut child tax credit", ct.childTaxCredit, ct.childTaxCredit ? "law" : "derived", lawNote(x, "Connecticut child tax credit"))];
    case "ct.totalTax":
      return [
        ref(x, "+", "ct.taxBeforeAllocation"),
        ...(ct.incomePercentage != null ? [ln("×", "Connecticut share of income", { ratio: ct.incomePercentage }, "derived", undefined, selfLink(x, "ct.incomePercentage")), ln("=", "Connecticut tax on Connecticut income", ct.taxBeforeCredits, "derived")] : []),
        ref(x, "−", "ct.otherStateCredit"),
        ref(x, "−", "ct.childTaxCredit"),
      ];
    case "ct.totalPayments":
      return [ref(x, "+", "ct.withheld"), ref(x, "+", "ct.estimatedPayments")];
    case "ct.balance":
      return [ref(x, "+", "ct.totalTax"), ref(x, "−", "ct.totalPayments")];
    case "ct.incomePercentage":
      return [ref(x, undefined, "ct.sourceIncome"), ref(x, "÷", "ct.stateAgi"), ln("=", "Share, to four decimals (at most 100%)", { ratio: ct.incomePercentage ?? 0 }, "law")];

    case "ny.federalAgi":
      return [ref(x, "+", "fed.agi")];
    case "ny.stateAgi":
      return [ref(x, "+", "ny.federalAgi"), ref(x, "−", "ny.usObligationSubtraction")];
    case "ny.deductions":
      return ny ? [ln(undefined, "Standard deduction", ny.standardDeduction, "law", lawNote(x, "New York standard deduction")), ...(ny.dependentExemption ? [ln("+", `${x.col.dependents.length} dependent exemption${x.col.dependents.length === 1 ? "" : "s"}`, ny.dependentExemption, "law")] : [])] : [];
    case "ny.taxableIncome": {
      if (!ny) return [];
      const whole = Math.round(ny.nyAgi / 100) * 100;
      return [ref(x, "+", "ny.stateAgi"), ...(whole - ny.nyAgi ? [ln("+", "Rounded to whole dollars", whole - ny.nyAgi, "law")] : []), ref(x, "−", "ny.deductions"), ...(whole - ny.standardDeduction - ny.dependentExemption < 0 ? [ln("+", "Not below zero", ny.standardDeduction + ny.dependentExemption - whole, "law")] : [])];
    }
    case "ny.taxBeforeAllocation":
      return ny ? [...bandLines(x, "ny", ny.scheduleTax, "New York State brackets"), ...(ny.recapture ? [ln("+", "Benefit recapture (tax computation worksheet)", ny.recapture, "law", lawNote(x, "New York recapture above $107,650 of AGI"))] : [])] : [];
    case "ny.incomeTax":
      return ny ? [ref(x, "+", "ny.taxBeforeAllocation"), ...(ny.incomePercentage != null ? [ln("×", "New York share of income", { ratio: ny.incomePercentage }, "derived", undefined, selfLink(x, "ny.incomePercentage")), ...(ny.stateTax !== ny.baseTax * ny.incomePercentage ? [ln("+", "Rounded to whole dollars, as the form does", ny.stateTax - ny.baseTax * ny.incomePercentage, "law")] : [])] : [])] : [];
    case "ny.incomePercentage":
      return [ref(x, undefined, "ny.sourceIncome"), ref(x, "÷", "ny.stateAgi"), ln("=", "Share, to four decimals (at most 100%)", { ratio: ny?.incomePercentage ?? 0 }, "law")];
    case "ny.cityTaxableIncome":
      if (!ny?.city) return [];
      return ny.filing.city === "RESIDENT"
        ? [ref(x, "+", "ny.taxableIncome", "A full-year City resident's City taxable income is the State's.")]
        : [ln(undefined, "Income while living in the City", ny.city.agi, "derived", undefined, selfLink(x, "ny.sourceIncome")), ln("−", `Deduction, ${ny.filing.cityMonths}/12 of the year`, ny.city.deduction, "law"), ...(ny.city.dependentExemption ? [ln("−", "Dependent exemptions, prorated", ny.city.dependentExemption, "law")] : [])];
    case "ny.cityTax":
      return ny?.city ? bandLines(x, "nyc", ny.cityTax, "New York City brackets") : [];
    case "ny.totalTax":
      return ny ? [ref(x, "+", "ny.incomeTax"), ref(x, "+", "ny.cityTax")] : [];
    case "ny.credits":
      return [ln(undefined, "NYC school tax credits (refundable)", ny?.city ? ny.city.schoolCredit + ny.city.schoolRateReduction : 0, "law", lawNote(x, "NYC school tax credit")), ...(ny ? [ref(x, "+", "ny.estimatedPayments")] : [])];
    case "ny.totalPayments":
      return ny ? [ref(x, "+", "ny.withheld"), ref(x, "+", "ny.cityWithheld"), ref(x, "+", "ny.estimatedPayments"), ln("+", "NYC school tax credits (refundable)", ny.city ? ny.city.schoolCredit + ny.city.schoolRateReduction : 0, "law")] : [];
    case "ny.balance":
      return ny ? [ref(x, "+", "ny.totalTax"), ref(x, "−", "ny.totalPayments")] : [];

    case "fica.socialSecurity":
    case "fica.pfml":
      return perPerson(x, key === "fica.pfml" ? "CT Paid Leave" : "Social Security", (p, inc) => {
        const wages = inc.w2s.reduce((t, w) => t + w.box3SsWages, 0);
        const base = fp.socialSecurity.wageBase;
        return [
          ln(undefined, `${who(x, p)}Social Security wages (W-2 box 3)`, wages, "derived", "Box 5 wages, each W-2 capped at the wage base."),
          ...(wages > base ? [ln("−", "Above the Social Security wage base", wages - base, "law", lawNote(x, `Wage base ${usd0(base)}`))] : []),
          ln("×", key === "fica.pfml" ? "0.5%" : "6.2%", { ratio: key === "fica.pfml" ? x.params.ct.pfmlRate : fp.socialSecurity.rate }, "law"),
          ln("=", key === "fica.pfml" ? "Paid leave contribution" : "Social Security tax", Math.round(Math.min(base, wages) * (key === "fica.pfml" ? x.params.ct.pfmlRate : fp.socialSecurity.rate)), "derived"),
        ];
      });
    case "fica.medicare":
      return perPerson(x, "Medicare", (p, inc) => {
        const box5 = inc.w2s.reduce((t, w) => t + w.box5MedicareWages, 0);
        return [ln(undefined, `${who(x, p)}Medicare wages (W-2 box 5)`, box5, "derived", undefined, selfLink(x, "pay.medicareWages", x.people.length > 1 ? { filer: p.id } : {})), ln("×", "1.45%", { ratio: fp.medicareRate }, "law", lawNote(x, "Medicare tax")), ln("=", "Medicare tax", Math.round(box5 * fp.medicareRate), "derived")];
      });
    case "fica.medicareTotal":
      return [ref(x, "+", "fica.medicare"), ref(x, "+", "fed.additionalMedicareTax")];

    case "all.otherStateTax":
      return each((p, inc) => typed(x, p, "+", "other state tax", inc.otherStateTax));
    case "all.totalTaxes":
      return [
        ref(x, "+", "fed.incomeTax"),
        ref(x, "+", "fica.medicareTotal"),
        ref(x, "+", "fed.niit"),
        ref(x, "+", "fica.socialSecurity"),
        ref(x, "+", "ct.totalTax"),
        ref(x, "+", "fica.pfml"),
        ...(x.col.r.otherStateTax ? [ref(x, "+", "all.otherStateTax")] : []),
        ...(ny ? [ref(x, "+", "ny.incomeTax"), ref(x, "+", "ny.cityTax")] : []),
      ];
    case "all.jointValue":
      if (x.col.id !== "joint") return [];
      return [
        ...x.cols
          .filter((c) => c.id !== "joint")
          .map((c, i) => ln(i === 0 ? undefined : "+", `${c.name} filing separately: total taxes`, lineValue("all.totalTaxes", c, x.cols) ?? 0, "derived", undefined, { label: `${c.name}'s separate return`, descriptor: { ...x.d, filer: c.id, key: "all.totalTaxes" } })),
        ln("−", "Filing jointly: total taxes", val(x, "all.totalTaxes"), "derived", undefined, selfLink(x, "all.totalTaxes")),
      ];
    case "all.earnedPlusInvestment":
      return [ref(x, "+", "pay.salary"), ref(x, "+", "pay.bonus"), ref(x, "+", "pay.imputed"), ref(x, "+", "fed.investmentIncome")];
    case "all.takeHome":
      return [ref(x, "+", "all.earnedPlusInvestment"), ref(x, "−", "all.totalTaxes")];
    case "all.totalPaid":
      return [
        ref(x, "+", "fed.w2Withholding"),
        ref(x, "+", "fed.estimatedPayments"),
        ref(x, "+", "fica.medicareWithheld"),
        ref(x, "+", "fica.ssWithheld"),
        ref(x, "+", "ct.withheld"),
        ref(x, "+", "ct.estimatedPayments"),
        ref(x, "+", "fica.pfml", "PFML is withheld from pay as it's owed."),
        ...(ny || val(x, "ny.withheldAll") ? [ref(x, "+", "ny.withheldAll"), ref(x, "+", "ny.credits")] : []),
      ];
    case "all.balance":
      return [ref(x, "+", "fed.balance"), ref(x, "+", "ct.balance"), ...(ny ? [ref(x, "+", "ny.balance")] : [])];
  }
}

// ---------------------------------------------------------------- the proof

/** The page's report for the year, built as api/tax builds it: the forecast's link for the year in progress. */
async function reportFor(ctx: ProofContext, year: number) {
  const current = Number(ctx.book.today.slice(0, 4)) === year;
  return perBook(ctx, `tax-report|${year}`, async () => {
    const forecast = current ? (await loadForecast(ctx.db, ctx.book)).forecast : null;
    return buildTaxReport(ctx.book, year, { forecast: forecast ? taxLink(forecast) : null });
  });
}

export async function buildTaxEstimateProof(ctx: ProofContext, d: TaxEstimateDescriptor): Promise<Proof> {
  const { book } = ctx;
  const through = taxYearThrough(book, d.year);
  const from = `${d.year}-01-01`;
  const bankIds = book.accounts.filter((a) => a.group === "Cash").map((a) => a.id);
  const bankTo = [`${d.year + 1}-04-30`, book.horizon.cashFlow].sort()[0]!;
  const { checks } = checksFor(
    book,
    [
      { affects: "PAY", from, to: through },
      { affects: "TAX", from, to: through },
      { affects: "CASH_FLOW", from, to: bankTo, accountIds: bankIds },
    ],
    TAX_ESTIMATE_CHECKS,
  );
  const report = await reportFor(ctx, d.year);
  const keyLabel = isFound(d.key) ? FOUND[d.key].label : label(d.key);
  const base = { report: "tax-estimate" as const, descriptor: d, checks, through, today: book.today };

  if (report.blocked) {
    const open = taxBlockers(book, d.year);
    return {
      ...base,
      describes: `${keyLabel}, ${d.year}`,
      figure: { text: "Withheld" },
      selfCheck: null,
      withheld: true,
      estimates: [],
      blocks: [{ kind: "chain", title: "Why it isn't shown", lines: [ln(undefined, `${open.length} open finding${open.length === 1 ? "" : "s"} for ${d.year}'s pay, tax documents or bank accounts, and no filed return on file`, { text: "—" }, "derived")], note: "A finished year's estimate is shown once its pay, investment income and bank accounts are proven, or its filed return is in the tax documents folder." }],
    };
  }

  const isCurrent = report.isCurrentYear;
  const forecastNote: ProofEstimate[] =
    isCurrent && d.basis !== "ytd"
      ? [{ id: `tax-estimate:projected:${d.year}`, title: `${d.year} is projected to December 31`, detail: "Paychecks after the latest stub, the forecast's bonuses, and dividends and interest run to year end are estimates (the W-4 / prepayment plan). Realized gains aren't projected." }]
      : [];
  const inferences: ProofEstimate[] = book.integrity.inferences
    .filter((i) => i.check.startsWith("pay.") && i.scope && i.scope.from <= through && i.scope.to >= from && (!d.filer || !i.scope.personId || i.scope.personId === d.filer))
    .map((i) => ({ id: i.id, title: i.title, detail: i.detail }));
  // Interest and tax-payment rows the classifier asked about count as filed: say so.
  const bankRowIds = new Set([...report.bankInterest.parts.flatMap((p) => p.rowIds), ...report.payments.map((p) => p.transactionId)]);
  const unreviewed = [...bankRowIds].map((id) => book.rowById.get(id)).filter((r) => r?.needsReview);
  const estimates = [...forecastNote, ...inferences, ...(unreviewed.length ? [unreviewedEstimate(unreviewed.map((r) => r!))] : [])];

  // The Payments tab's totals: just the rows.
  if (isFound(d.key)) {
    const rows = estimateRows(report.payments, d.year, FOUND[d.key].authority);
    const total = rows.reduce((t, p) => t + p.amount, 0);
    const bankRows = rows.map((p) => book.rowById.get(p.transactionId)).filter((r): r is BookRow => !!r);
    const lines = seq([...rows.map((p) => ln("+", `${p.date} ${p.payee}`, p.amount, "proven", p.basis === "OWNER" ? "Attributed to this year by you." : p.basis === "FILED_RETURN" ? "The filed return shows nothing was owed, so it's this year's estimate." : "Its date makes it this year's estimate.")), ln("=", keyLabel, total, "derived")]);
    return {
      ...base,
      describes: `${keyLabel}, ${d.year}`,
      figure: cents(total),
      selfCheck: sumCheck(total, rows.reduce((t, p) => t + p.amount, 0), `The ${rows.length} payment${rows.length === 1 ? "" : "s"} below add up to ${money(total)}`),
      withheld: false,
      estimates,
      blocks: [{ kind: "chain", title: "Payments", lines: lines.length > 1 ? lines : [ln(undefined, "No estimated payments found for the year", 0, "proven")] }, ...(bankRows.length ? [{ kind: "rows" as const, title: "Bank rows", figureCents: bankRows.reduce((t, r) => t + r.amountCents, 0), groups: groupRows(book, bankRows), note: "As the bank statements print them (paid out negative)." }] : [])],
    };
  }

  const key = d.key;
  const params = taxYearParams(d.year);
  const def = ESTIMATE_LINES[key];

  // The Filed return tab's "This app": the projected joint return, without a K-1 the return left off, in whole dollars.
  if (d.basis === "filed") {
    const docs = yearDocs(book.taxDocs, d.year, report.profile.persons);
    if (!docs.federal && !docs.ct) {
      return { ...base, describes: `${keyLabel}, as compared with the filed ${d.year} return`, figure: { text: "No filed return" }, selfCheck: null, withheld: false, estimates, blocks: [{ kind: "chain", title: "Filed return", lines: [ln(undefined, `No filed ${d.year} return in the tax documents folder`, { text: "—" }, "derived")] }] };
    }
    const filed = asFiled(report, docs);
    const mk = (r: typeof filed.result, whole: boolean): EstimateColumn => ({ id: "joint", name: "Joint", sub: "as filed", r, incomes: report.people.map((p) => p.income), pay: { ...ZERO_AMOUNTS }, dependents: report.dependents, wholeDollars: whole });
    const projected = lineValue(key, mk(report.scenarios.mfj, false));
    const exact = lineValue(key, mk(filed.exact, false));
    const shown = lineValue(key, mk(filed.result, true));
    const ratio = !!def.ratio;
    const v = (n: number | null): ProofValue => (n == null ? { text: "not on this return" } : ratio ? { ratio: n } : cents(n));
    const lines: ChainLine[] = [ln(undefined, `This app's ${def.label.toLowerCase()}, ${d.year} (joint)`, v(projected), "derived", "The estimate's own figure, in cents: its proof shows where it comes from.", { label: def.label, descriptor: { ...d, basis: "projected" } })];
    if (!ratio && projected != null && exact != null && exact !== projected) lines.push(ln("+", "Without the K-1 the filed return left off", exact - projected, "derived", filed.amendment?.reason));
    if (!ratio && exact != null && shown != null && shown !== exact) lines.push(ln("+", "Every W-2 box and income figure rounded to whole dollars, as the return reports them", shown - exact, "derived", key.endsWith(".balance") ? "The form subtracts its own rounded lines (total tax − total payments)." : undefined));
    if (!ratio) lines.push(ln("=", `${def.label}, as the Filed return tab compares it`, v(shown), "derived"));
    const chk = evalChain(lines);
    return {
      ...base,
      describes: `${def.label}, ${d.year} joint return, as compared with the filed return`,
      figure: v(shown),
      selfCheck: ratio || shown == null ? null : { ok: chk.ok, deltaCents: Math.round(chk.delta), explain: `The lines below work out to ${money(shown)}` },
      withheld: false,
      estimates,
      blocks: [{ kind: "chain", title: "From the estimate to the filed comparison", lines, note: "Returns are filed in whole dollars, each W-2 box and 1099 amount rounded before it's added; the Filed return tab rounds the same way." }],
    };
  }

  const { cols } = estimateColumns(report, d.basis);
  const col = cols.find((c) => c.id === (d.filer ?? "joint"));
  if (!col) return { ...base, describes: keyLabel, figure: { text: "No such return" }, selfCheck: null, withheld: false, estimates, blocks: [{ kind: "chain", title: "Return", lines: [ln(undefined, `No one with id ${d.filer} files a ${d.year} return here`, { text: "—" }, "derived")] }] };

  const x: X = {
    book,
    d,
    report,
    params,
    col,
    cols,
    people: col.incomes.map((i) => report.people.find((p) => p.id === i.id)!),
    pick: d.basis === "ytd" ? "ytd" : "projected",
    finished: Number(book.today.slice(0, 4)) > d.year,
    through,
    blocks: [],
    rows: [],
  };
  const figure = lineValue(key, col, cols);
  const ratio = !!def.ratio;
  const basisWords = d.basis === "ytd" ? "year to date" : isCurrent ? "projected to December 31" : "full year";
  const describes = `${def.label} · ${col.id === "joint" ? "joint return" : `${col.name} filing separately`} · ${d.year}, ${basisWords}`;

  if (figure == null) {
    const why = key.startsWith("ny.") ? `No New York return for ${d.year}` : key.endsWith("sourceIncome") || key.endsWith("incomePercentage") ? "Full-year resident: the whole year's income is the state's" : "Not on this return";
    return { ...base, describes, figure: { text: "—" }, selfCheck: null, withheld: false, estimates, blocks: [{ kind: "chain", title: "How it's worked out", lines: [ln(undefined, why, { text: "—" }, "derived")] }] };
  }

  const body = seq(explain(x, key));
  const value: ProofValue = ratio ? { ratio: figure } : cents(figure);
  const main: ChainLine[] = ratio ? body : [...(body.length ? body : [ln(undefined, "Nothing on this return", 0, "derived")]), ln("=", def.label, value, "derived")];
  const blocks: ProofBlock[] = [
    {
      kind: "chain",
      title: "How it's worked out",
      lines: main,
      note: x.pick === "projected" && isCurrent ? "A forecast to December 31: lines marked Estimate are projected past the latest stub and statement." : undefined,
    },
    ...x.blocks,
  ];
  if (x.rows.length)
    blocks.push({ kind: "rows", title: "Bank rows counted", figureCents: x.rows.reduce((t, r) => t + r.amountCents, 0), groups: groupRows(book, x.rows), note: "Interest and tax payments as the bank statements print them." });

  let selfCheck: Proof["selfCheck"] = null;
  if (!ratio) {
    const results = blocks.filter((b): b is Extract<ProofBlock, { kind: "chain" }> => b.kind === "chain").map((b) => evalChain(b.lines));
    const mainEval = evalChain(main.slice(0, -1));
    const ok = results.every((r) => r.ok) && Math.abs(mainEval.value - figure) <= 0.5;
    selfCheck = { ok, deltaCents: Math.round(mainEval.value - figure), explain: `The ${main.length - 1} line${main.length === 2 ? "" : "s"} below work out to ${money(Math.round(mainEval.value))}` };
  }

  return { ...base, describes, figure: value, selfCheck, withheld: false, estimates, blocks };
}

export const taxEstimateKind: ProofKind<TaxEstimateDescriptor> = {
  report: "tax-estimate",
  parse: parseTaxEstimateDescriptor,
  build: buildTaxEstimateProof,
};
