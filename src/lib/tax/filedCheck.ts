import type { FederalKey, StateKey } from "../taxdocs/types.ts";
import type { TaxReport } from "./buildTaxReport.ts";
import { computeReturn, type FederalResult, type CtResult, type NyResult, type PersonIncome, type ReturnResult } from "./computeReturn.ts";
import { ownerOf, type YearDocs } from "./documents.ts";
import { taxYearParams } from "./params.ts";

/**
 * This model against the return that was actually filed, line by line, plus the
 * documents against the ledger (W-2s vs pay stubs, 1099s vs statements, payments vs the
 * bank). Returns are in whole dollars, so a line matches when the model rounds to it; a
 * dollar or two off on a line that adds rounded amounts is rounding. Every other gap is
 * explained where the documents say why, and the fixes that are just missing inputs come
 * with a one-click patch to the tax profile.
 */

export type CheckStatus = "MATCH" | "ROUNDING" | "DIFFERENT" | "FILED_ONLY" | "MODEL_ONLY";

export type CheckLine = {
  key: string;
  /** Form and line, as printed on the return ("1040 · 11a"). */
  where: string;
  label: string;
  /** Cents (or, for a percentage, ten-thousandths). */
  filed: number | null;
  model: number | null;
  status: CheckStatus;
  note: string | null;
  percent?: boolean;
};

export type SourceCheck = {
  /** What's compared: a W-2 box, a 1099 figure, the year's estimated payments… */
  label: string;
  document: string;
  documentValue: number;
  /** The same figure from the ledger (stubs, statements, bank rows); null when the ledger has none. */
  ledgerValue: number | null;
  status: "MATCH" | "DIFFERENT" | "LEDGER_MISSING";
  note: string | null;
};

/** A change to the tax profile that would close a gap: the UI applies `set` to the year's inputs. */
export type Suggestion = { id: string; text: string; set: { path: (string | number)[]; value: unknown }[] };

export type FiledCheck = {
  filingStatus: string | null;
  federal: CheckLine[];
  ct: CheckLine[];
  ny: CheckLine[];
  sources: SourceCheck[];
  suggestions: Suggestion[];
  /** Income on documents that the filed return left out (a K-1 that came late): what amending would change. */
  amendment: { reason: string; federal: number; ct: number; ny: number } | null;
  summary: { federal: CheckStatus | null; ct: CheckStatus | null; ny: CheckStatus | null; differences: number };
};

const dollars = (cents: number | null) => (cents == null ? null : Math.round(cents / 100));
const usd = (cents: number) => `${cents < 0 ? "−" : ""}$${Math.abs(Math.round(cents / 100)).toLocaleString("en-US")}`;

const usdCents = (cents: number) => `${cents < 0 ? "−" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function compare(filed: number | null, model: number | null, tolerance = 3): CheckStatus {
  if (filed == null && model == null) return "MATCH";
  if (filed == null) return model === 0 ? "MATCH" : "MODEL_ONLY";
  if (model == null) return filed === 0 ? "MATCH" : "FILED_ONLY";
  const gap = Math.abs(dollars(filed)! - dollars(model)!);
  return gap === 0 ? "MATCH" : gap <= tolerance ? "ROUNDING" : "DIFFERENT";
}

type FedRow = [FederalKey, string, string, (f: FederalResult) => number | null];

const FED_ROWS: FedRow[] = [
  ["wages", "1040 · 1z", "Wages (W-2 box 1)", (f) => f.wages],
  ["taxableInterest", "1040 · 2b", "Taxable interest", (f) => f.interest],
  ["qualifiedDividends", "1040 · 3a", "Qualified dividends", (f) => f.qualifiedDividends],
  ["ordinaryDividends", "1040 · 3b", "Ordinary dividends", (f) => f.ordinaryDividends],
  ["iraTaxable", "1040 · 4b", "Taxable IRA distributions", (f) => f.retirementTaxable],
  ["capitalGain", "1040 · 7", "Capital gain or loss", (f) => f.capitalGainAllowed],
  ["additionalIncome", "1040 · 8", "Other income (Schedule 1)", (f) => f.otherIncome],
  ["totalIncome", "1040 · 9", "Total income", (f) => f.totalIncome],
  ["adjustments", "1040 · 10", "Adjustments to income", (f) => f.adjustments],
  ["agi", "1040 · 11", "Adjusted gross income", (f) => f.agi],
  ["deduction", "1040 · 12", "Standard or itemized deduction", (f) => f.deduction],
  ["qbiDeduction", "1040 · 13", "Qualified business income deduction", (f) => f.qbiDeduction],
  ["taxableIncome", "1040 · 15", "Taxable income", (f) => f.taxableIncome],
  ["tax", "1040 · 16", "Tax", (f) => f.regularTax],
  ["amt", "1040 · 17", "Alternative minimum tax (Schedule 2)", (f) => f.amt],
  ["childCredit", "1040 · 19", "Child / other dependent credit", (f) => f.childTaxCredit + f.otherDependentCredit],
  ["otherCredits", "1040 · 20", "Other credits (Schedule 3)", (f) => f.foreignTaxCredit + f.dependentCareCredit],
  ["additionalMedicareTax", "Sch 2 · 11", "Additional Medicare tax", (f) => f.additionalMedicareTax],
  ["niit", "Sch 2 · 12", "Net investment income tax", (f) => f.niit],
  ["totalTax", "1040 · 24", "Total tax", (f) => f.totalTax],
  ["w2Withholding", "1040 · 25a", "Federal tax withheld (W-2s)", (f) => f.withholding],
  ["otherWithholding", "1040 · 25c", "Additional Medicare tax withheld", (f) => f.additionalMedicareWithheld],
  ["estimatedPayments", "1040 · 26", "Estimated tax payments", (f) => f.estimatedPayments],
  ["excessSsCredit", "Sch 3 · 11", "Excess Social Security withheld", (f) => f.excessSsCredit],
  ["totalPayments", "1040 · 33", "Total payments", (f) => f.totalPayments],
];

type CtRow = [StateKey, string, string, (c: CtResult) => number | null, boolean?];

const CT_ROWS: CtRow[] = [
  ["federalAgi", "1", "Federal AGI", (c) => c.federalAgi],
  ["usObligationSubtraction", "Sch 1", "US government interest subtracted", (c) => c.usObligationSubtraction],
  ["chet", "Sch 1", "CHET 529 contributions subtracted", (c) => c.chetDeduction],
  ["stateAgi", "5", "Connecticut AGI", (c) => c.ctAgi],
  ["sourceIncome", "6", "Income from Connecticut sources", (c) => c.sourceIncome],
  ["incomePercentage", "9", "Connecticut share of income", (c) => (c.incomePercentage == null ? null : Math.round(c.incomePercentage * 10_000)), true],
  ["taxBeforeAllocation", "8", "Tax on all income (resident tables)", (c) => c.taxBeforeAllocation],
  ["otherStateCredit", "11", "Credit for taxes paid to other states", (c) => c.otherStateCredit],
  ["totalTax", "18", "Total tax", (c) => c.totalTax],
  ["withheld", "20", "Connecticut tax withheld", (c) => c.withholding],
  ["estimatedPayments", "21", "Estimated payments", (c) => c.estimatedPayments],
  ["totalPayments", "23", "Total payments", (c) => c.totalPayments],
];

type NyRow = [StateKey, string, string, string, (n: NyResult) => number | null, boolean?];

/** IT-201 / IT-203 lines: [key, IT-201 line, IT-203 line, label, model]. */
const NY_ROWS: NyRow[] = [
  ["federalAgi", "19", "19", "Federal AGI", (n) => n.federalAgi],
  ["usObligationSubtraction", "28", "28", "US government interest subtracted", (n) => n.subtractions],
  ["stateAgi", "33", "31", "New York AGI", (n) => n.nyAgi],
  ["sourceIncome", "—", "31", "New York amount column (income while a resident + NY-source)", (n) => n.sourceIncome],
  ["taxBeforeAllocation", "39", "44", "New York State tax on all income (with recapture)", (n) => n.baseTax],
  ["incomePercentage", "—", "45", "New York share of income", (n) => (n.incomePercentage == null ? null : Math.round(n.incomePercentage * 10_000)), true],
  ["incomeTax", "46", "50", "New York State tax", (n) => n.stateTax],
  ["cityTax", "58", "55", "New York City tax", (n) => n.cityTax],
  ["totalTax", "61", "58", "Total New York taxes", (n) => n.totalTax],
  ["withheld", "72", "62", "New York State tax withheld", (n) => n.withholding],
  ["cityWithheld", "73", "63", "New York City tax withheld", (n) => n.cityWithholding],
  ["estimatedPayments", "75", "65", "Estimated payments", (n) => n.estimatedPayments],
  ["totalPayments", "76", "66", "Total payments and refundable credits", (n) => n.totalPayments],
];

export function checkFiled(report: TaxReport, docs: YearDocs): FiledCheck {
  const status = docs.federal?.filingStatus ?? "MFJ";
  // A separate return covers one spouse only; the joint model is what the household compares against.
  const { result: scenario, amendment } = asFiled(report, docs);
  const fed = docs.federal?.federal ?? null;
  const federal: CheckLine[] = [];
  const suggestions: Suggestion[] = [];
  const sources: SourceCheck[] = [];

  if (fed) {
    const f = scenario.federal;
    for (const [key, where, label, model] of FED_ROWS) {
      let filed = fed[key];
      if (key === "iraTaxable") filed = (fed.iraTaxable ?? 0) + (fed.pensionsTaxable ?? 0);
      const m = model(f);
      // Lines the return leaves blank are zero.
      const st = compare(filed ?? (m === 0 ? null : 0), m, ["tax", "totalTax", "taxableIncome", "agi", "totalIncome", "totalPayments"].includes(key) ? 3 : 2);
      federal.push({ key, where, label, filed: filed ?? null, model: m, status: st, note: null });
    }
    const filedBalance = fed.amountOwed ? fed.amountOwed : -((fed.refund ?? 0) + (fed.appliedToNextYear ?? 0));
    // The form subtracts its own rounded lines (24 − 33), so the model does too.
    const owed = dollar(f.totalTax) - dollar(f.totalPayments);
    federal.push({ key: "balance", where: "1040 · 37 / 34", label: "Owed at filing (refund negative)", filed: filedBalance, model: owed, status: compare(filedBalance, owed, 5), note: null });
    explainFederal(federal, report, docs, suggestions);
  }

  // ---------------------------------------------------------------- Connecticut
  const ctLines: CheckLine[] = [];
  const ctFiled = docs.ct?.state ?? null;
  if (ctFiled) {
    const c = scenario.ct;
    for (const [key, line, label, model, percent] of CT_ROWS) {
      const filed = ctFiled[key];
      const m = model(c);
      if (filed == null && (m == null || m === 0)) continue;
      const st = percent ? (filed === m ? "MATCH" : filed != null && m != null && Math.abs(filed - m) <= 1 ? "ROUNDING" : filed == null ? "MODEL_ONLY" : "DIFFERENT") : compare(filed, m, 2);
      ctLines.push({ key, where: `${docs.ct!.form} · ${line}`, label, filed, model: m, status: st, note: null, percent });
    }
    const filedBalance = ctFiled.amountOwed ? ctFiled.amountOwed : -(ctFiled.refund ?? 0);
    const ctOwed = dollar(c.totalTax) - dollar(c.totalPayments);
    ctLines.push({ key: "balance", where: `${docs.ct!.form} · 28 / 24`, label: "Owed at filing (refund negative)", filed: filedBalance, model: ctOwed, status: compare(filedBalance, ctOwed, 5), note: null });
    explainCt(ctLines, report, docs, federal);
  }

  // ---------------------------------------------------------------- New York
  const nyLines: CheckLine[] = [];
  const nyFiled = docs.ny?.state ?? null;
  if (nyFiled) {
    const n = scenario.ny;
    const it201 = docs.ny!.form === "IT-201";
    for (const [key, line201, line203, label, model, percent] of NY_ROWS) {
      const line = it201 ? line201 : line203;
      if (line === "—") continue;
      // Taxable income isn't in the return summary; it's read off its line.
      if (key === "taxBeforeAllocation") {
        const tiLine = it201 ? "37" : "36";
        const v = docs.ny!.lines.find((l) => l.form === docs.ny!.form && l.line === tiLine)?.values[0];
        const filedTi = v == null ? null : Math.round(v * 100);
        const modelTi = n?.taxableIncome ?? null;
        if (filedTi != null || modelTi) nyLines.push({ key: "taxableIncome", where: `${docs.ny!.form} · ${tiLine}`, label: "New York taxable income", filed: filedTi, model: modelTi, status: compare(filedTi, modelTi, 2), note: null });
      }
      const filed = nyFiled[key];
      const m = n ? model(n) : null;
      if (filed == null && (m == null || m === 0)) continue;
      const st = percent ? (filed === m ? "MATCH" : filed != null && m != null && Math.abs(filed - m) <= 1 ? "ROUNDING" : m == null ? "FILED_ONLY" : "DIFFERENT") : compare(filed, m, 2);
      nyLines.push({ key, where: `${docs.ny!.form} · ${line}`, label, filed, model: m, status: st, note: null, percent });
    }
    const filedBalance = nyFiled.amountOwed ? nyFiled.amountOwed : -(nyFiled.refund ?? 0);
    const nyOwed = n ? dollar(n.totalTax) - dollar(n.totalPayments) : null;
    nyLines.push({ key: "balance", where: `${docs.ny!.form} · ${it201 ? "80 / 78" : "70 / 68"}`, label: "Owed at filing (refund negative)", filed: filedBalance, model: nyOwed, status: compare(filedBalance, nyOwed, 5), note: null });
    explainNy(nyLines, report, federal, suggestions);
  }

  // ---------------------------------------------------------------- documents vs the ledger
  sourceChecks(report, docs, sources);
  paymentChecks(report, docs, sources, suggestions);


  const worst = (lines: CheckLine[]) =>
    lines.length ? (lines.some((l) => l.status === "DIFFERENT" || l.status === "FILED_ONLY" || l.status === "MODEL_ONLY") ? "DIFFERENT" : lines.some((l) => l.status === "ROUNDING") ? "ROUNDING" : "MATCH") : null;
  return {
    filingStatus: status,
    federal,
    ct: ctLines,
    ny: nyLines,
    sources,
    suggestions,
    amendment,
    summary: {
      federal: worst(federal),
      ct: worst(ctLines),
      ny: worst(nyLines),
      // Root causes only: a line that just follows from another, or a form figure the statements can only estimate, isn't counted.
      differences:
        [...federal, ...ctLines, ...nyLines].filter((l) => (l.status === "DIFFERENT" || l.status === "FILED_ONLY") && !l.note?.startsWith("Follows")).length +
        sources.filter((s) => s.status === "DIFFERENT" && !s.note?.startsWith("The statements can't tell")).length,
    },
  };
}

/** Why federal lines differ, where the documents can tell; and the inputs that would close the gap. */
function explainFederal(lines: CheckLine[], report: TaxReport, docs: YearDocs, suggestions: Suggestion[]) {
  const get = (k: string) => lines.find((l) => l.key === k)!;
  const other = get("additionalIncome");
  if (other.status === "DIFFERENT" && other.filed != null && other.model != null) {
    const gap = other.filed - other.model;
    const items = docs.federal?.otherIncome ?? [];
    const filedItems = `Schedule 1 reports ${usd(other.filed)}${items.length ? ` (${items.map((i) => `${i.label}: ${usd(i.amount)}`).join("; ")})` : ""}`;
    // Typed-in other income goes first when the app has more than the return: what the
    // statements prove (an excess 401(k) deferral, K-1s) stays.
    const person = gap > 0 ? report.people[0]! : (report.people.find((p) => (report.inputs.people[p.id]?.extras.otherIncome ?? 0) > 0) ?? report.people[0]!);
    const current = report.inputs.people[person.id]?.extras.otherIncome ?? 0;
    if (gap > 0) {
      other.note = `${filedItems}; the app has ${usd(other.model)}. Nothing in the statements records this income, so it has to be entered.`;
      suggestions.push({
        id: "otherIncome",
        text: `Add ${usd(gap)} of other income (Schedule 1${items[0] ? `: ${items[0].label.toLowerCase()}` : ""}) to ${person.name}'s ${report.year} inputs.`,
        set: [{ path: ["years", String(report.year), "people", person.id, "extras", "otherIncome"], value: current + gap }],
      });
    } else {
      const excess = report.people.reduce((s, p) => s + p.k401.excess.projected, 0);
      other.note = `${filedItems}; the app has ${usd(other.model)}${excess ? `, including ${usd(excess)} of excess 401(k) deferrals it reads from the pay stubs and plan statements` : ""}.${current ? ` ${usd(current)} of it was typed under Inputs.` : ""}`;
      if (current > 0) {
        const next = Math.max(0, current + gap);
        suggestions.push({
          id: "otherIncome",
          text: `Lower ${person.name}'s typed-in ${report.year} other income from ${usd(current)} to ${usd(next)}: the app already counts ${usd(-gap)} of it from the documents, so it's counted twice.`,
          set: [{ path: ["years", String(report.year), "people", person.id, "extras", "otherIncome"], value: next }],
        });
      }
    }
  }
  const interest = get("taxableInterest");
  if (interest.status === "DIFFERENT" && interest.filed != null && interest.model != null && interest.filed > interest.model) {
    const gap = interest.filed - interest.model;
    // A 1099-INT the scanner couldn't read (a scanned image) is the usual cause; its folder says whose it is.
    const unread = docs.other.find((o) => o.warnings.some((w) => /1099-INT/.test(w)));
    const personId = (unread && ownerOf([unread.doc.file], report.profile.persons)) ?? report.people[0]!.id;
    const person = report.people.find((p) => p.id === personId)!;
    interest.note = unread
      ? `The return has ${usd(gap)} more interest than the app. ${unread.doc.file} is a scanned 1099-INT the app can't read, and its account isn't in the statements for ${report.year}.`
      : `The return has ${usd(gap)} more interest than the statements and 1099s show: an account the app doesn't track?`;
    const current = report.inputs.people[person.id]?.extras.extraInterest ?? 0;
    suggestions.push({
      id: "extraInterest",
      text: `Add ${usd(gap)} of interest not in the statements to ${person.name}'s ${report.year} inputs${unread ? " (the scanned 1099-INT)" : ""}.`,
      set: [{ path: ["years", String(report.year), "people", person.id, "extras", "extraInterest"], value: current + gap }],
    });
  }
  const est = get("estimatedPayments");
  if (est.status === "DIFFERENT") {
    est.note = `The return claims ${usd(est.filed ?? 0)} of estimated payments; the bank shows ${usd(est.model ?? 0)} attributed to ${report.year}. See the payments check below.`;
  }
  const q = get("qualifiedDividends");
  if (q.status === "DIFFERENT" && report.accounts.some((a) => a.source === "STATEMENTS" && a.kind === "TAXABLE")) {
    q.note = "Some accounts have no 1099 on file, so their qualified share is the household-wide guess.";
  }
  const wages = get("wages");
  if (wages.status === "DIFFERENT") {
    const missing = report.people.flatMap((p) => p.payroll.filter((x) => !x.w2Doc).map((x) => `${p.name} · ${x.employer}`));
    if (missing.length) wages.note = `No W-2 on file for ${missing.join(", ")}; those wages come from the pay stubs.`;
  }
  const ira = get("iraTaxable");
  if (ira.status !== "MATCH" && (ira.model ?? 0) > (ira.filed ?? 0) && docs.rs.length) {
    ira.note = `The 1099-R${docs.rs.length > 1 ? "s" : ""} on file (${docs.rs.map((r) => `${r.form.payer}: ${usd(r.form.taxable)} taxable, code ${r.form.codes || "?"}`).join("; ")}) ${ira.filed ? "come to more than" : "isn't on"} the filed return.`;
  }
  const qbi = get("qbiDeduction");
  if (qbi.status === "DIFFERENT") qbi.note = "The QBI deduction here is 20% of REIT (Section 199A) dividends from the 1099s.";
  for (const k of ["tax", "taxableIncome", "agi", "totalIncome", "totalTax", "totalPayments", "balance", "niit"]) {
    const l = get(k);
    if (l.status !== "MATCH" && !l.note) l.note = "Follows from the lines above.";
  }
}

function explainCt(lines: CheckLine[], report: TaxReport, docs: YearDocs, federal: CheckLine[]) {
  const get = (k: string) => lines.find((l) => l.key === k);
  // Connecticut starts from federal AGI: when that differs, so does everything built on it.
  if (federal.find((l) => l.key === "agi")?.status === "DIFFERENT") {
    for (const k of ["federalAgi", "stateAgi", "incomePercentage", "taxBeforeAllocation", "totalTax", "balance"]) {
      const l = get(k);
      if (l && l.status !== "MATCH") l.note = "Follows from the federal lines (Connecticut starts from federal AGI).";
    }
  }
  const src = get("sourceIncome");
  if (src && src.status === "DIFFERENT") {
    const parts = report.people.filter((p) => p.ctSource).map((p) => `${p.name}: wages ${usd(p.ctSource!.wages)}, investment ${usd(p.ctSource!.investment)}, other ${usd(p.ctSource!.other)}`);
    src.note = `Worked out as ${parts.join("; ")} (${Math.round((report.residency.investmentShare ?? 0) * 1000) / 10}% of investment income). Enter the residency details under Inputs if the move date or share is off.`;
  }
  const w = get("withheld");
  if (w && w.status === "DIFFERENT") w.note = "Connecticut withholding is the W-2s' CT lines (box 17).";
  if (docs.ct?.form === "CT-1040NR/PY" && report.residency.ct === "FULL") {
    const t = get("totalTax");
    if (t) t.note = "The filed return is a part-year return, but the model treats the year as a full-year residency (set under Inputs).";
  }
}

function explainNy(lines: CheckLine[], report: TaxReport, federal: CheckLine[], suggestions: Suggestion[]) {
  const get = (k: string) => lines.find((l) => l.key === k);
  if (!report.ny) {
    for (const l of lines) if (l.status !== "MATCH") l.note = "No New York residency is set for the year (Inputs), so New York isn't computed.";
    return;
  }
  const n = report.scenarios.mfj.ny;
  // State-exempt US government interest the statements can't see (a government money fund's share).
  const sub = get("usObligationSubtraction");
  if (sub && sub.status === "DIFFERENT" && (sub.filed ?? 0) > (sub.model ?? 0)) {
    const gap = (sub.filed ?? 0) - (sub.model ?? 0);
    const person = report.people[0]!;
    sub.note = `The return subtracts ${usd(sub.filed ?? 0)} of US government interest (Treasuries or a government money fund); the statements show ${usd(sub.model ?? 0)}.`;
    suggestions.push({
      id: "usObligationIncome",
      text: `Count ${usd(gap)} of ${report.year} income as state-exempt US government interest (it's already in income; New York and Connecticut don't tax it).`,
      set: [{ path: ["years", String(report.year), "people", person.id, "extras", "usObligationIncome"], value: (report.inputs.people[person.id]?.extras.usObligationIncome ?? 0) + gap }],
    });
    for (const k of ["stateAgi", "taxableIncome", "taxBeforeAllocation", "incomeTax", "cityTax", "totalTax", "balance"]) {
      const l = get(k);
      if (l && l.status !== "MATCH" && !l.note) l.note = "Follows from the US government interest subtraction.";
    }
  }
  // Dependents: New York's $1,000 exemption each, which the return may not have claimed.
  const ti = get("taxableIncome");
  if (ti && n && ti.filed != null && ti.model != null && n.dependentExemption > 0 && Math.abs(ti.filed - ti.model - n.dependentExemption) < 200) {
    const names = report.dependents.map((d) => d.name).join(", ");
    ti.note = `The filed return claims no dependent exemption; the app counts ${names} (${usd(n.dependentExemption)}). If ${names} was your dependent in ${report.year}, the return left the exemption out (worth about ${usd(Math.round(n.dependentExemption * (n.incomePercentage ?? 1) * 0.0685 + (n.city ? n.dependentExemption * 0.03876 * (n.filing.cityMonths / 12) : 0)))}); if not, fix the birth year in Settings.`;
    for (const k of ["taxBeforeAllocation", "incomeTax", "cityTax", "totalTax", "totalPayments", "balance"]) {
      const l = get(k);
      if (l && l.status !== "MATCH" && !l.note) l.note = "Follows from the dependent exemption.";
    }
  }
  // New York starts from federal AGI too.
  if (federal.find((l) => l.key === "agi")?.status === "DIFFERENT") {
    for (const k of ["federalAgi", "stateAgi", "taxableIncome", "taxBeforeAllocation", "incomePercentage", "incomeTax", "cityTax", "totalTax", "balance"]) {
      const l = get(k);
      if (l && l.status !== "MATCH") l.note = "Follows from the federal lines (New York starts from federal AGI).";
    }
  }
  const src = get("sourceIncome");
  if (src && src.status === "DIFFERENT") {
    const parts = report.people.filter((p) => p.nySource).map((p) => `${p.name}: wages ${usd(p.nySource!.wages)}, investment ${usd(p.nySource!.investment)}, other ${usd(p.nySource!.other)}`);
    src.note = `Worked out as ${parts.join("; ")}. Set the New York move date under Inputs if it's off.`;
    for (const k of ["incomePercentage", "incomeTax", "cityTax", "totalTax", "balance"]) {
      const l = get(k);
      if (l && l.status !== "MATCH" && !l.note) l.note = "Follows from the New York amount column.";
    }
  }
  for (const k of ["withheld", "cityWithheld"]) {
    const l = get(k);
    if (l && l.status === "DIFFERENT") l.note = "New York withholding is the W-2s' New York lines (box 17) and New York City lines (box 19).";
  }
  for (const k of ["stateAgi", "taxableIncome", "taxBeforeAllocation", "incomeTax", "cityTax", "totalTax", "totalPayments", "balance"]) {
    const l = get(k);
    if (l && l.status !== "MATCH" && !l.note) l.note = "Follows from the lines above.";
  }
}

/** Each W-2 against its pay stubs; each 1099 against its statements; each 1099-INT against the bank. */
function sourceChecks(report: TaxReport, docs: YearDocs, out: SourceCheck[]) {
  /** `explained`: a known difference in how the document and the statements count (added to the ledger side); a gap it fully closes is a match, with its note. */
  const push = (label: string, document: string, documentValue: number, ledgerValue: number | null, note: string | null = null, explained?: { amount: number; note: string }) => {
    let status: SourceCheck["status"] = ledgerValue == null ? "LEDGER_MISSING" : Math.abs(documentValue - ledgerValue) <= 100 ? "MATCH" : "DIFFERENT";
    if (status === "DIFFERENT" && explained && explained.amount !== 0 && Math.abs(documentValue - (ledgerValue! + explained.amount)) <= 100) {
      status = "MATCH";
      note = explained.note;
    }
    out.push({ label, document, documentValue, ledgerValue, status, note });
  };
  for (const p of report.people) {
    for (const x of p.payroll.filter((y) => y.w2Doc)) {
      const w = x.w2Projected;
      const s = x.stubW2;
      const name = `${p.name} · ${x.employer} W-2`;
      push(`${name} · box 1 wages`, x.w2Doc!.file, w.box1Wages, s?.box1Wages ?? null, s ? null : "No pay stubs from this employer on file.");
      if (!s) continue;
      push(`${name} · box 2 federal withheld`, x.w2Doc!.file, w.federalWithheld, s.federalWithheld);
      push(`${name} · box 3 Social Security wages`, x.w2Doc!.file, w.box3SsWages, s.box3SsWages);
      push(`${name} · box 5 Medicare wages`, x.w2Doc!.file, w.box5MedicareWages, s.box5MedicareWages);
      push(`${name} · state + local withheld`, x.w2Doc!.file, w.stateWithheld + w.otherStateWithheld, s.stateWithheld + s.otherStateWithheld);
      push(`${name} · box 12 D (401k)`, x.w2Doc!.file, w.box12.D, s.box12.D);
      if (w.box12.W || s.box12.W) push(`${name} · box 12 W (HSA)`, x.w2Doc!.file, w.box12.W, s.box12.W);
    }
  }
  for (const a of report.accounts.filter((x) => x.source === "1099")) {
    const s = a.fromStatements;
    const form = docs.brokerage.find((f) => f.doc.id === a.doc!.id)?.form;
    // A January payment the 1099 doesn't print was taxed the year before (a December-declared
    // fund dividend, IRC §852(b)(7)); only when the form lists dated payments to look it up in.
    // (A scan from before these fields were read has neither: it ties as it did, until rescanned.)
    const priorYear = form?.dividendPayments?.length
      ? a.januaryDividends.filter((r) => !form.dividendPayments.some((p) => p.date === r.date && p.amount === r.amount)).reduce((t, r) => t + r.amount, 0)
      : 0;
    push(
      `${a.label} · ordinary dividends`,
      a.doc!.file,
      a.ytd.ordinaryDividends + a.ytd.capGainDistShort,
      s ? s.ordinaryDividends + s.capGainDistShort : null,
      s ? null : "No statements for this account are on file.",
      { amount: -priorYear, note: `The statements' January dividend of ${usdCents(priorYear)} isn't on this 1099: a fund dividend declared in December and paid in January is taxed in ${report.year - 1}.` },
    );
    if (!s) continue;
    push(`${a.label} · qualified dividends`, a.doc!.file, a.ytd.qualifiedDividends, s.qualifiedDividends, "The statements can't tell qualified from not; the app's estimate is checked here.");
    push(`${a.label} · interest`, a.doc!.file, a.ytd.interest, s.interest);
    // The statements net a gold trust's sponsor fees into realized gains; the 1099-B leaves
    // them out and lists them as supplemental investment expenses.
    const fees = -(form?.proceedsInvestmentExpenses ?? 0);
    push(`${a.label} · realized gains`, a.doc!.file, a.ytd.shortTermGain + a.ytd.longTermGain + a.ytd.capGainDistLong, s.shortTermGain + s.longTermGain + s.capGainDistLong, null, {
      amount: fees,
      note: `The statements net ${usdCents(fees)} of proceeds investment expenses (trust fees) into gains; the 1099 lists them as supplemental information, not in its gains.`,
    });
  }
  for (const f of docs.ints) {
    const part = report.bankInterest.parts.find((p) => p.doc?.id === f.doc.id);
    const ledger = part?.ledgerCents ?? null;
    push(`${f.form.payer} ••${f.form.account ?? "?"} · interest (1099-INT)`, f.doc.file, f.form.interest, ledger, ledger == null ? "No bank statements for this account are on file." : "The bank statements' interest rows for the year.");
  }
  const sa = report.people.reduce((s, p) => s + p.payroll.reduce((t, x) => t + x.w2Projected.box12.W, 0), 0);
  const filedSa = docs.federal?.federal?.hsaEmployer;
  if (filedSa != null) push("HSA employer + payroll contributions (Form 8889 line 9)", docs.federal!.doc.file, filedSa, sa, "W-2 box 12 W across the household.");
}

/**
 * Every figure a finished year's documents print that the ledger also shows: W-2 boxes
 * against the pay stubs, 1099s against the statements, 1099-INTs against the bank's
 * interest rows, and (with a filed return) the estimated payments, balance and refund
 * against the bank. With or without a filed return. Integrity turns each into a finding
 * (book/checks/taxDocuments.ts); the Filed return tab lists them.
 */
export function documentTies(report: TaxReport, docs: YearDocs): SourceCheck[] {
  const out: SourceCheck[] = [];
  sourceChecks(report, docs, out);
  paymentChecks(report, docs, out, []);
  return out;
}

/** Estimated payments, balance-due payments and refunds: the filed returns against the bank ledger. */
function paymentChecks(report: TaxReport, docs: YearDocs, out: SourceCheck[], suggestions: Suggestion[]) {
  const y = report.year;
  const sum = (auth: string, kind: string) => report.payments.filter((p) => p.authority === auth && p.attribution.taxYear === y && p.attribution.kind === kind).reduce((s, p) => s + p.amount, 0);
  const check = (label: string, file: string | undefined, filed: number | null | undefined, ledger: number) => {
    if (filed == null || !file) return;
    out.push({ label, document: file, documentValue: filed, ledgerValue: ledger, status: Math.abs(filed - ledger) <= 100 ? "MATCH" : "DIFFERENT", note: null });
  };
  const fed = docs.federal?.federal;
  check(`${y} federal estimated payments`, docs.federal?.doc.file, fed?.estimatedPayments ?? 0, sum("FEDERAL", "ESTIMATE"));
  if (fed?.amountOwed) check(`${y} federal balance paid at filing`, docs.federal?.doc.file, fed.amountOwed, sum("FEDERAL", "BALANCE_DUE"));
  if (fed?.refund) check(`${y} federal refund received`, docs.federal?.doc.file, fed.refund, -sum("FEDERAL", "REFUND"));
  const ct = docs.ct?.state;
  if (ct) {
    check(`${y} Connecticut estimated payments`, docs.ct?.doc.file, ct.estimatedPayments ?? 0, sum("CT", "ESTIMATE"));
    if (ct.amountOwed) check(`${y} Connecticut balance paid at filing`, docs.ct?.doc.file, ct.amountOwed, sum("CT", "BALANCE_DUE"));
    if (ct.refund) check(`${y} Connecticut refund received`, docs.ct?.doc.file, ct.refund, -sum("CT", "REFUND"));
  }
  // New York, as Connecticut: its estimates, a balance paid at filing and a refund all reach the bank (other-state tax rows).
  const ny = docs.ny?.state;
  if (ny) {
    check(`${y} New York estimated payments`, docs.ny?.doc.file, ny.estimatedPayments ?? 0, sum("OTHER_STATE", "ESTIMATE"));
    if (ny.amountOwed) check(`${y} New York balance paid at filing`, docs.ny?.doc.file, ny.amountOwed, sum("OTHER_STATE", "BALANCE_DUE"));
    if (ny.refund) check(`${y} New York refund received`, docs.ny?.doc.file, ny.refund, -sum("OTHER_STATE", "REFUND"));
  }

  // A federal estimate the bank paid but filed under another year: offer to re-attribute it.
  const fedEst = out.find((s) => s.label === `${y} federal estimated payments`);
  if (fedEst && fedEst.status === "DIFFERENT") {
    const gap = fedEst.documentValue - (fedEst.ledgerValue ?? 0);
    const candidate = report.payments.find((p) => p.authority === "FEDERAL" && p.amount === gap && p.date.startsWith(String(y)) && !(p.attribution.kind === "ESTIMATE" && p.attribution.taxYear === y));
    if (candidate) {
      fedEst.note = `The ${usd(candidate.amount)} paid ${candidate.date} is filed as ${candidate.attribution.kind.toLowerCase().replace("_", " ")} for ${candidate.attribution.taxYear}; the return counts it as a ${y} estimate.`;
      suggestions.push({
        id: `payment:${candidate.transactionId}`,
        text: `Count the ${usd(candidate.amount)} IRS payment of ${candidate.date} as a ${y} estimated payment.`,
        set: [{ path: ["years", String(y), "paymentOverrides", candidate.transactionId], value: { kind: "ESTIMATE", taxYear: y } }],
      });
    } else {
      fedEst.note = "The bank shows a different total; a payment may come from an account the app doesn't track, or be attributed to another year (Payments tab).";
    }
  }
}

/**
 * The model on the filed return's basis. A K-1 on file whose income isn't on the return
 * (no Schedule E — it came after filing) is left out, so every other line can be checked
 * to the dollar; what amending for it would change is reported separately.
 */
/**
 * The joint return as the Filed return tab compares it: in whole dollars, and without a K-1
 * the filed return left off. `exact` is the same return in cents, before the rounding.
 */
export function asFiled(report: TaxReport, docs: YearDocs): { result: ReturnResult; exact: ReturnResult; amendment: FiledCheck["amendment"] } {
  const full = report.scenarios.mfj;
  const params = taxYearParams(report.year);
  // Returns are filed in whole dollars, each W-2 box and 1099 amount rounded before it's added.
  const ny = report.ny?.filing ?? null;
  const filedWay = (people: PersonIncome[]) => computeReturn({ params, filingStatus: report.filingStatus, people: people.map(wholeDollars), dependents: report.dependents, ny });
  const k1s = report.people.flatMap((p) => p.k1s.filter((k) => !k.estimate));
  if (!k1s.length || !docs.federal || docs.federal.lines.some((l) => l.form === "SE" || l.form === "8582")) {
    return { result: filedWay(report.people.map((p) => p.income)), exact: full, amendment: null };
  }
  const without: PersonIncome[] = report.people.map((p) => {
    const mine = p.k1s.filter((k) => !k.estimate);
    const sum = (f: keyof (typeof k1s)[number]["figures"]) => mine.reduce((s, k) => s + k.figures[f], 0);
    const passive = mine.filter((k) => !k.suspendedLoss).reduce((s, k) => s + k.figures.passive, 0);
    const i = p.income;
    const out: PersonIncome = {
      ...i,
      taxableInterest: i.taxableInterest - sum("interest"),
      ordinaryDividends: i.ordinaryDividends - sum("ordinaryDividends"),
      qualifiedDividends: i.qualifiedDividends - sum("qualifiedDividends"),
      shortTermGain: i.shortTermGain - sum("shortTermGain"),
      longTermGain: i.longTermGain - sum("longTermGain"),
      otherIncome: i.otherIncome - sum("otherIncome") - passive,
      foreignTaxPaid: i.foreignTaxPaid - sum("foreignTax"),
    };
    // CT-source income again without the K-1, rounded line by line as Schedule CT-SI does.
    if (p.ctSource && i.ctSourceIncome != null) {
      const share = p.ctSource.investmentShare;
      const lines = [out.taxableInterest, out.ordinaryDividends, out.capitalGainDistributions + out.shortTermGain + out.longTermGain];
      out.ctSourceIncome = p.ctSource.wages + lines.reduce((s, x) => s + dollar(x * share), 0) + (p.ctSource.other ? out.otherIncome : 0);
    }
    // New York's amount column likewise.
    if (p.nySource && i.nySourceIncome != null) {
      const share = p.nySource.investmentShare;
      const lines = [out.taxableInterest, out.ordinaryDividends, out.capitalGainDistributions + out.shortTermGain + out.longTermGain];
      out.nySourceIncome = p.nySource.wages + lines.reduce((s, x) => s + dollar(x * share), 0) + (p.nySource.other ? dollar(out.otherIncome * share) : 0);
    }
    return out;
  });
  const before = computeReturn({ params, filingStatus: report.filingStatus, people: without, dependents: report.dependents, ny });
  const names = [...new Set(k1s.map((k) => k.partnership))].join(", ");
  return {
    result: filedWay(without),
    exact: before,
    amendment: {
      reason: `The K-1 from ${names} isn't on the filed return (it has no Schedule E), so the lines here are checked without it. Amending (Form 1040-X, and the state returns) would add its income.`,
      federal: full.federal.totalTax - before.federal.totalTax,
      ct: full.ct.totalTax - before.ct.totalTax,
      ny: (full.ny?.totalTax ?? 0) - (before.ny?.totalTax ?? 0),
    },
  };
}

const dollar = (c: number) => Math.round(c / 100) * 100;

/** A person's return inputs as a return reports them: every W-2 box and income figure in whole dollars. */
function wholeDollars(i: PersonIncome): PersonIncome {
  const out = { ...i } as Record<string, unknown>;
  for (const [k, v] of Object.entries(i)) if (typeof v === "number") out[k] = dollar(v);
  out.w2s = i.w2s.map((w) => {
    const x = { ...w } as Record<string, unknown>;
    for (const [k, v] of Object.entries(w)) if (typeof v === "number") x[k] = dollar(v);
    return x;
  });
  return out as PersonIncome;
}
