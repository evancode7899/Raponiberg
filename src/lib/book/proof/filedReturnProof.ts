import { loadProfileSettings } from "../../profile/settings.ts";
import { buildTaxReport } from "../../tax/buildTaxReport.ts";
import type { CheckLine, CheckStatus } from "../../tax/filedCheck.ts";
import { yearDocs } from "../../tax/documents.ts";
import { FEDERAL_KEYS, federalSources, sourceValue, STATE_KEYS, stateSources, type FiledSource } from "../../taxdocs/returns.ts";
import type { FederalKey, FiledReturn, StateKey } from "../../taxdocs/types.ts";
import { formatUsdFromCents } from "../../formatMoney.ts";
import type { CheckId } from "../types.ts";
import { checksFor, sumCheck } from "./common.ts";
import type { ChainLine, Proof, ProofBlock, ProofContext, ProofKind, ProofValue } from "./types.ts";

/**
 * The proof behind a line of a filed return (Taxes › Filed return): which document it was
 * read from, the form, page and line, and the amount as printed. A filed figure is a fact
 * read off a document, so it is a chain of "proven" lines; where the tab compares it with
 * the app's own figure, the proof shows both and the difference.
 *
 * Lines are found through the same locators the return's summary uses (taxdocs/returns.ts
 * federalSources / stateSources), so the proof names exactly the lines the figure came
 * from; the few figures the tab builds from several lines (taxable IRA + pensions, the
 * balance at filing) are re-added here and checked against the tab's own figure.
 */

export type FiledJurisdiction = "FEDERAL" | "CT" | "NY";

export type FiledReturnDescriptor = {
  report: "filed-return";
  year: number;
  jurisdiction: FiledJurisdiction;
  /**
   * The line's key on the Filed return tab (lib/tax/filedCheck CheckLine.key): a federal
   * or state summary key, "balance" (owed at filing), or NY's "taxableIncome".
   *
   * TODO(tax-estimate, approved item 10): the comparison's "This app" line is the tax
   * engine's figure for the same key. Once a "tax-estimate" kind exists, that line links
   * to it ({ report: "tax-estimate", year, jurisdiction, key }); until then it has no link.
   */
  key: string;
};

const JURISDICTION: Record<FiledJurisdiction, { name: string; doc: "federal" | "ct" | "ny" }> = {
  FEDERAL: { name: "Federal", doc: "federal" },
  CT: { name: "Connecticut", doc: "ct" },
  NY: { name: "New York", doc: "ny" },
};

const FED_EXTRA = ["balance"];
const STATE_EXTRA = ["balance"];
const NY_EXTRA = ["taxableIncome"];

/** Every key the tab can ask about, per jurisdiction. */
const KEYS: Record<FiledJurisdiction, Set<string>> = {
  FEDERAL: new Set([...FEDERAL_KEYS, ...FED_EXTRA]),
  CT: new Set([...STATE_KEYS, ...STATE_EXTRA]),
  NY: new Set([...STATE_KEYS, ...STATE_EXTRA, ...NY_EXTRA]),
};

export function parseFiledReturnDescriptor(d: Record<string, unknown>): FiledReturnDescriptor | { error: string } {
  if (typeof d.year !== "number" || !Number.isInteger(d.year) || d.year < 1990 || d.year > 2100) return { error: "year must be a tax year." };
  if (typeof d.jurisdiction !== "string" || !Object.hasOwn(JURISDICTION, d.jurisdiction)) return { error: "jurisdiction must be FEDERAL, CT or NY." };
  const jurisdiction = d.jurisdiction as FiledJurisdiction;
  if (typeof d.key !== "string" || !KEYS[jurisdiction].has(d.key)) return { error: `key isn't a ${JURISDICTION[jurisdiction].name} return line.` };
  return { report: "filed-return", year: d.year, jurisdiction, key: d.key };
}

/**
 * The printed lines a tab figure is read from, each signed as it counts. Mirrors how
 * filedCheck builds the few composite figures; the proof's self-check holds it to the
 * tab's own figure.
 */
export function filedSources(ret: FiledReturn, jurisdiction: FiledJurisdiction, key: string): FiledSource[] {
  const neg = (s: FiledSource[]) => s.map((x) => ({ ...x, sign: -x.sign as 1 | -1 }));
  const nonZero = (s: FiledSource[]) => s.length > 0 && sourceValue(s[0]!) !== 0;
  if (jurisdiction === "FEDERAL") {
    const fed = (k: FederalKey) => federalSources(ret.lines, k);
    // The tab counts pensions and annuities (5b) with IRA distributions (4b).
    if (key === "iraTaxable") return [...fed("iraTaxable"), ...fed("pensionsTaxable")];
    if (key === "balance") return nonZero(fed("amountOwed")) ? fed("amountOwed") : neg([...fed("refund"), ...fed("appliedToNextYear")]);
    return fed(key as FederalKey);
  }
  const st = (k: StateKey) => stateSources(ret.lines, jurisdiction, k);
  if (key === "balance") return nonZero(st("amountOwed")) ? st("amountOwed") : neg(st("refund"));
  if (key === "taxableIncome") {
    // Not in the return summary: read off its line (IT-201 37, IT-203 36).
    const line = ret.lines.find((l) => l.form === ret.form && l.line === (ret.form === "IT-201" ? "37" : "36"));
    return line ? [{ line, column: "first", sign: 1 }] : [];
  }
  return st(key as StateKey);
}

/** The checks over a filed line: the year's tax law (the app's side of the comparison) and whether its inputs were read by current code. */
export const FILED_RETURN_CHECKS: CheckId[] = ["tax.params", "ledger.freshness"];

const STATUS_WORDS: Record<CheckStatus, string> = {
  MATCH: "Matches the filed return to the dollar.",
  ROUNDING: "Within rounding: the return adds whole-dollar lines, the app adds cents.",
  DIFFERENT: "Differs from the filed return.",
  FILED_ONLY: "On the filed return, not in the app's figures.",
  MODEL_ONLY: "In the app's figures, not on the filed return.",
};

const usd = (cents: number) => formatUsdFromCents(cents);
const percentLine = (key: string) => key === "incomePercentage";
const cents = (dollars: number) => Math.round(dollars * 100);

/** The tab's line for this key, as the tax engine compares it; null when the year's report is withheld. */
async function compared(ctx: ProofContext, d: FiledReturnDescriptor): Promise<CheckLine | null> {
  // Birth years set the 401(k) catch-up limit, as on the Taxes page (api/tax). A filed
  // year is a finished one, so the forecast the page passes for the current year doesn't apply.
  const { birthYears } = await loadProfileSettings(ctx.db);
  const report = buildTaxReport(ctx.book, d.year, { birthYears });
  if (report.blocked) return null;
  const lines = report.documents?.check?.[JURISDICTION[d.jurisdiction].doc] ?? [];
  return lines.find((l) => l.key === d.key) ?? null;
}

export async function buildFiledReturnProof(ctx: ProofContext, d: FiledReturnDescriptor): Promise<Proof> {
  const { book } = ctx;
  const j = JURISDICTION[d.jurisdiction];
  const docs = yearDocs(book.taxDocs, d.year, book.taxProfile.persons);
  const ret = docs[j.doc];
  const percent = percentLine(d.key);
  const base = { report: "filed-return" as const, descriptor: d, withheld: false, estimates: [], through: `${d.year}-12-31`, today: book.today };

  if (!ret) {
    const { checks } = checksFor(book, { affects: "TAX", from: `${d.year}-01-01`, to: `${d.year}-12-31` }, ["tax.params"]);
    return {
      ...base,
      describes: `${j.name} return for ${d.year}`,
      figure: { text: "Not on file" },
      selfCheck: null,
      blocks: [{ kind: "chain", title: "Where it was read", lines: [{ label: `No filed ${j.name} return for ${d.year} in the tax documents folder`, value: { text: "—" }, source: "proven" }] }],
      checks,
    };
  }

  const sources = filedSources(ret, d.jurisdiction, d.key);
  const line = await compared(ctx, d);
  const label = line?.label ?? sources[0]?.line.label ?? d.key;

  // What the reader took off the return, line by line.
  const valueOf = (s: FiledSource): ProofValue => (percent ? { ratio: sourceValue(s) } : { cents: cents(Math.abs(sourceValue(s))) });
  const read: ChainLine[] = sources.map((s, i) => {
    const amounts = s.line.values.length;
    return {
      op: i === 0 ? (s.sign < 0 ? "−" : undefined) : s.sign < 0 ? "−" : "+",
      label: `Form ${s.line.form}, page ${s.line.page}, line ${s.line.line}`,
      value: valueOf(s),
      source: "proven",
      note: [
        s.line.label && `Printed as “${s.line.label}”.`,
        amounts > 1 && `The line prints ${amounts} amounts; this is the ${s.column === "first" ? "first" : "last"}${d.jurisdiction === "NY" && s.line.form === "IT-203" ? ` (the ${s.column === "first" ? "federal" : "New York"} column)` : ""}.`,
      ]
        .filter(Boolean)
        .join(" "),
    };
  });
  const readCents = percent ? null : sources.reduce((t, s) => t + cents(sourceValue(s)), 0);
  const filed = line ? line.filed : percent ? (sources[0] ? Math.round(sourceValue(sources[0]) * 10_000) : null) : sources.length ? readCents : null;
  const asValue = (v: number | null): ProofValue => (v == null ? { text: "blank" } : percent ? { ratio: v / 10_000 } : { cents: v });

  if (!read.length) read.push({ label: `${line?.where ?? ret.form}: no amount printed`, value: { text: "blank" }, source: "proven", note: "The reader found nothing on this line; the comparison counts a blank line as $0." });
  else if (read.length > 1 || sources[0]!.sign < 0) read.push({ op: "=", label, value: asValue(filed), source: "derived" });

  const blocks: ProofBlock[] = [
    {
      kind: "chain",
      title: `Read off ${ret.doc.file}`,
      lines: read,
      note: [
        `${j.name} ${ret.form} for ${d.year}${ret.printedOn ? `, printed on ${ret.printedOn}` : ""}${ret.filingStatus ? `, filed ${ret.filingStatus}` : ""}.`,
        "No integrity check covers how the return was read: the amount is what the reader took off the PDF, and the comparison with the app's own figure is the cross-check.",
      ].join(" "),
    },
  ];

  if (line) {
    const diff = line.filed != null && line.model != null ? line.filed - line.model : null;
    blocks.push({
      kind: "chain",
      title: "Filed against this app",
      lines: [
        { label: "As filed", value: asValue(line.filed), source: "proven" },
        {
          op: "−",
          label: "This app",
          value: line.model == null ? { text: "not computed" } : asValue(line.model),
          source: "estimate",
          // No link yet: the tax-estimate kind (approved item 10) will prove this side.
          note: "Worked out by the app's tax engine from the year's W-2s, 1099s, K-1s, pay stubs and ledger, under the year's tax law.",
        },
        ...(diff == null ? [] : [{ op: "=" as const, label: "Difference", value: asValue(diff), source: "derived" as const, note: [STATUS_WORDS[line.status], line.note].filter(Boolean).join(" ") }]),
      ],
      note: percent ? undefined : "Returns print whole dollars; a line matches when the app's figure rounds to it.",
    });
  }

  // tax.params and ledger.freshness bear on the app's side; with no comparison only the year's law is listed.
  const { checks } = checksFor(book, { affects: "TAX", from: `${d.year}-01-01`, to: `${d.year}-12-31` }, line ? FILED_RETURN_CHECKS : ["tax.params"]);

  return {
    ...base,
    describes: `${label}, ${j.name} ${ret.form} as filed for ${d.year}`,
    figure: asValue(filed),
    selfCheck:
      percent || filed == null || readCents == null || !sources.length
        ? null
        : sumCheck(filed, readCents, `The ${sources.length} printed line${sources.length === 1 ? "" : "s"} come${sources.length === 1 ? "s" : ""} to ${usd(readCents)}`),
    blocks,
    checks,
  };
}

export const filedReturnKind: ProofKind<FiledReturnDescriptor> = {
  report: "filed-return",
  parse: parseFiledReturnDescriptor,
  build: buildFiledReturnProof,
};
