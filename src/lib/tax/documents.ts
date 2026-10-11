import type { Brokerage1099, FiledReturn, Int1099, K1Form, R1099, TaxDoc, TaxDocsFile, W2Form } from "../taxdocs/types.ts";
import type { W2Boxes } from "./facts/payroll.ts";
import type { TaxPerson } from "./profile.ts";

/**
 * A year's tax documents (lib/taxdocs), sorted by person: the W-2s, 1099s and K-1s the
 * return was built from, and the returns that were filed. For a finished year these are
 * the figures of record: they replace what the pay stubs and statements imply, and the
 * filed return is what the model is checked against.
 */

export type DocRef = { id: string; file: string };
export type Owned<T> = { doc: DocRef; personId: string | null; form: T };

export type YearDocs = {
  year: number;
  federal: (FiledReturn & { doc: DocRef }) | null;
  ct: (FiledReturn & { doc: DocRef }) | null;
  ny: (FiledReturn & { doc: DocRef }) | null;
  w2s: Owned<W2Form>[];
  brokerage: Owned<Brokerage1099>[];
  ints: Owned<Int1099>[];
  rs: Owned<R1099>[];
  k1s: Owned<K1Form>[];
  /** Everything else filed under the year (pay stubs, worksheets, foreign slips, superseded returns). */
  other: { doc: DocRef; kind: TaxDoc["kind"]; superseded: string | null; warnings: string[] }[];
  /** Every document for the year with what it is, for the documents list. */
  all: TaxDoc[];
};

const ref = (d: TaxDoc): DocRef => ({ id: d.id, file: d.file });

/** The person whose name tokens appear in the document's name (employee, recipient, partner). */
export function ownerOf(names: string[], persons: TaxPerson[]): string | null {
  const text = names.join(" ").toUpperCase();
  const hit = persons.filter((p) => p.match.some((m) => m && new RegExp(`\\b${m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)));
  return hit.length === 1 ? hit[0]!.id : null;
}

export function yearDocs(file: TaxDocsFile | null, year: number, persons: TaxPerson[]): YearDocs {
  const all = (file?.docs ?? []).filter((d) => d.year === year);
  const live = all.filter((d) => !d.superseded);
  const ret = (kind: TaxDoc["kind"]) => {
    const d = live.find((x) => x.kind === kind);
    return d && "ret" in d.parsed ? { ...d.parsed.ret, doc: ref(d) } : null;
  };
  const owned = <T>(kind: TaxDoc["kind"], pick: (d: TaxDoc) => T | null): Owned<T>[] =>
    live.flatMap((d) => {
      if (d.kind !== kind) return [];
      const form = pick(d);
      return form ? [{ doc: ref(d), personId: ownerOf(d.names, persons), form }] : [];
    });
  return {
    year,
    federal: ret("RETURN_FEDERAL"),
    ct: ret("RETURN_CT"),
    ny: ret("RETURN_NY"),
    w2s: owned("W2", (d) => (d.parsed.kind === "W2" ? d.parsed.w2 : null)),
    brokerage: owned("1099_BROKERAGE", (d) => (d.parsed.kind === "1099_BROKERAGE" ? d.parsed.f1099 : null)),
    ints: owned("1099_INT", (d) => (d.parsed.kind === "1099_INT" ? d.parsed.int : null)),
    rs: owned("1099_R", (d) => (d.parsed.kind === "1099_R" ? d.parsed.r : null)),
    k1s: owned("K1", (d) => (d.parsed.kind === "K1" ? d.parsed.k1 : null)),
    other: all
      .filter((d) => d.superseded || ["OTHER", "FOREIGN", "5498_SA"].includes(d.kind))
      .map((d) => ({ doc: ref(d), kind: d.kind, superseded: d.superseded, warnings: d.warnings })),
    all,
  };
}

/** The state whose return the engine models: its withholding is "state", every other state's and city's is "other". */
export const HOME_STATE = "CT";

/** W-2 box 20 names New York City's tax by ("NEW YORK", "NYC RES", "NY CITY"…). */
export const NYC_LOCALITY = /NEW YORK|NYC|NY CITY/i;

/** A W-2 form as the engine's W-2 boxes. Payroll-only figures the form doesn't carry come from the stubs, when matched. */
export function w2FromForm(w: W2Form, fromStubs: W2Boxes | null): W2Boxes {
  const code = (c: string) => w.box12.filter((e) => e.code === c).reduce((s, e) => s + e.amount, 0);
  const home = w.states.filter((s) => s.state === HOME_STATE);
  return {
    employer: fromStubs?.employer ?? w.employer,
    grossPay: fromStubs?.grossPay ?? w.medicareWages,
    box1Wages: w.wages,
    box3SsWages: w.ssWages,
    box5MedicareWages: w.medicareWages,
    box16StateWages: home.reduce((s, x) => s + x.wages, 0),
    federalWithheld: w.federalWithheld,
    ssWithheld: w.ssWithheld,
    medicareWithheld: w.medicareWithheld,
    stateWithheld: home.reduce((s, x) => s + x.withheld, 0),
    nyStateWages: w.states.filter((s) => s.state === "NY").reduce((s, x) => s + x.wages, 0),
    nyWithheld: w.states.filter((s) => s.state === "NY").reduce((s, x) => s + x.withheld, 0),
    nycWithheld: w.locals.filter((l) => NYC_LOCALITY.test(l.name)).reduce((s, x) => s + x.withheld, 0),
    otherStateWithheld: w.states.filter((s) => s.state !== HOME_STATE).reduce((s, x) => s + x.withheld, 0) + w.locals.reduce((s, x) => s + x.withheld, 0),
    statePayroll: fromStubs?.statePayroll ?? 0,
    employerRetirement: fromStubs?.employerRetirement ?? 0,
    box10: w.dependentCare,
    box12: { D: code("D"), AA: code("AA"), W: code("W"), C: code("C"), DD: code("DD") },
  };
}

/**
 * Pairs each person's W-2 forms with their payroll employers by wages: the closest box 1
 * within 15% (or $2,000). Forms left over are employers with no stubs on file; employers
 * left over have no W-2 on file.
 */
export function matchW2s<P extends { w2Ytd: W2Boxes }>(payroll: P[], forms: Owned<W2Form>[]): { pairs: [P, Owned<W2Form>][]; formsOnly: Owned<W2Form>[]; stubsOnly: P[] } {
  const pairs: [P, Owned<W2Form>][] = [];
  const left = [...forms];
  const stubsOnly: P[] = [];
  for (const p of [...payroll].sort((a, b) => b.w2Ytd.box1Wages - a.w2Ytd.box1Wages)) {
    const target = p.w2Ytd.box1Wages;
    const best = left
      .map((f, i) => ({ f, i, gap: Math.abs(f.form.wages - target) }))
      .filter((x) => x.gap <= Math.max(200_000, target * 0.15))
      .sort((a, b) => a.gap - b.gap)[0];
    if (best) {
      pairs.push([p, best.f]);
      left.splice(best.i, 1);
    } else stubsOnly.push(p);
  }
  return { pairs, formsOnly: left, stubsOnly };
}

/** A K-1's figures for the 1040: portfolio income flows straight through; boxes 1–3 are passive for a limited partner. */
export function k1Income(k: K1Form) {
  const passive = k.ordinaryBusiness + k.rentalRealEstate + k.otherRental;
  return {
    interest: k.interest,
    ordinaryDividends: k.ordinaryDividends,
    qualifiedDividends: k.qualifiedDividends,
    shortTermGain: k.shortTermGain,
    longTermGain: k.longTermGain + k.section1231,
    otherIncome: k.royalties + k.guaranteedPayments,
    /** Net passive income or loss. A net loss with no other passive income is suspended (Form 8582), not deducted. */
    passive,
    foreignTax: k.foreignTax,
  };
}

/** A filed return's balance: positive owed, negative refunded (null: not on the return). */
export function filedBalance(r: FiledReturn | null): number | null {
  if (!r) return null;
  if (r.federal) {
    const f = r.federal;
    if (f.amountOwed) return f.amountOwed;
    if (f.refund || f.appliedToNextYear) return -((f.refund ?? 0) + (f.appliedToNextYear ?? 0));
    return f.totalTax != null && f.totalPayments != null ? f.totalTax - f.totalPayments : null;
  }
  const s = r.state!;
  if (s.amountOwed) return s.amountOwed;
  if (s.refund) return -s.refund;
  return s.totalTax != null && s.totalPayments != null ? s.totalTax - s.totalPayments : null;
}

/** Total tax for the next year's safe harbor: line 24 less refundable credits (excess Social Security is a payment, not a credit). */
export function safeHarborTax(r: FiledReturn | null): number | null {
  const f = r?.federal;
  if (!f?.totalTax) return null;
  return f.totalTax - Math.max(0, (f.refundableCredits ?? 0) - (f.excessSsCredit ?? 0));
}

/** CT-1040AW: the share of each income line earned while a Connecticut resident (column B ÷ column A). */
export function ctResidentShares(ct: FiledReturn | null): { wages: number | null; investment: number | null } {
  if (!ct) return { wages: null, investment: null };
  const aw = (line: string) => ct.lines.find((l) => l.form === "CT-1040AW" && l.line === line)?.values ?? null;
  const share = (v: number[] | null) => (v && v.length >= 2 && v[0] ? v[1]! / v[0] : null);
  const inv = [aw("2"), aw("3"), aw("6")].filter((v): v is number[] => !!v && v.length >= 2);
  const a = inv.reduce((s, v) => s + v[0]!, 0);
  const b = inv.reduce((s, v) => s + v[1]!, 0);
  return { wages: share(aw("1")), investment: a ? b / a : null };
}
