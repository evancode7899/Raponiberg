import type { LayoutCell, LayoutRow } from "../statements/pdfLayout.ts";

/**
 * Reads a filed return (federal 1040 and schedules, CT-1040 / CT-1040NR/PY, NY IT-201 /
 * IT-203) line by line from positioned text. Every return prints a line number in its own
 * cell (or at the end of the label) and the amount to its right on the same baseline, so
 * "line → amounts" survives the plain text's scrambled order. Amounts are dollars as
 * filed (whole dollars, or the decimal a form asks for, like CT's and NY's income
 * percentages).
 */

export type ReturnLine = {
  /** The form or schedule the page belongs to: "1040", "S1", "SD", "8959", "CT-1040NR/PY", "IT-203"… */
  form: string;
  page: number;
  line: string;
  /** The words printed before the line number. */
  label: string;
  /** Every amount printed after the line number on that row, left to right (dollars). */
  values: number[];
};

/** Page titles, most specific first: a schedule's page also says "Form 1040". */
const FORMS: [RegExp, string][] = [
  [/\bSCHEDULE 1\b|Schedule 1 \(Form 1040\)/, "S1"],
  [/\bSCHEDULE 2\b|Schedule 2 \(Form 1040\)/, "S2"],
  [/\bSCHEDULE 3\b|Schedule 3 \(Form 1040\)/, "S3"],
  [/\bSCHEDULE A\b|Schedule A \(Form 1040\)/, "SA"],
  [/\bSCHEDULE B\b|Schedule B \(Form 1040\)/, "SB"],
  [/\bSCHEDULE D\b|Schedule D \(Form 1040\)/, "SD"],
  [/\bSCHEDULE E\b|Schedule E \(Form 1040\)/, "SE"],
  [/\bSchedule 8812\b|Credits for Qualifying Children/, "8812"],
  [/Form 8949\b|Sales and Other Dispositions of Capital Assets/, "8949"],
  [/Form 8889\b|Health Savings Accounts \(HSAs\)/, "8889"],
  [/Form 8995-A|Form 8995\b|Qualified Business Income Deduction/, "8995"],
  [/Form 8959\b|Additional Medicare Tax/, "8959"],
  [/Form 8960\b|Net Investment Income Tax/, "8960"],
  [/Form 8606\b|Nondeductible IRAs/, "8606"],
  [/Form 2441\b|Child and Dependent Care Expenses/, "2441"],
  [/Form 1116\b|Foreign Tax Credit/, "1116"],
  [/Form 6251\b|Alternative Minimum Tax—Individuals/, "6251"],
  [/Form 8582\b|Passive Activity Loss Limitations/, "8582"],
  [/Form 8880\b/, "8880"],
  [/Form 1040-X\b|Amended U\.S\. Individual Income Tax Return/, "1040X"],
  [/Form 1040 \(\d{4}\)|U\.S\. Individual Income Tax Return/, "1040"],
  [/Schedule CT-SI\b/, "CT-SI"],
  [/Schedule CT-1040AW\b/, "CT-1040AW"],
  [/CT-1040NR\/PY/, "CT-1040NR/PY"],
  [/Form CT-1040\b|CT-1040 \d{4}/, "CT-1040"],
  [/IT-360\.1\b/, "IT-360.1"],
  [/IT-203-B\b/, "IT-203-B"],
  [/IT-196\b/, "IT-196"],
  [/IT-203\b/, "IT-203"],
  [/IT-201\b/, "IT-201"],
];

export function pageForm(rows: LayoutRow[]): string | null {
  if (!rows.length) return null;
  // The topmost title wins: a page's own header comes before any form its lines mention.
  const top = Math.max(...rows.map((r) => r.y));
  for (const r of rows.filter((x) => x.y >= top - 60).sort((a, b) => b.y - a.y)) {
    const text = r.cells.map((c) => c.text).join(" ");
    const hit = FORMS.find(([re]) => re.test(text));
    if (hit) return hit[1];
  }
  return null;
}

const clean = (t: string) => t.replace(/\s+/g, "");
const NUMBER = /^\(?-?[\d,]*\d\.?\d{0,4}\)?$/;

export function amount(text: string): number | null {
  const t = clean(text);
  if (!NUMBER.test(t)) return null;
  const neg = t.startsWith("(") || t.startsWith("-");
  const n = Number(t.replace(/[(),-]/g, "").replace(/\.$/, ""));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

/**
 * How each jurisdiction's software prints a line number and an amount:
 * - FED (FreeTaxUSA, Intuit): line "13a", amount "24." or "123,456." (always a dot or comma)
 * - CT: line "8." (or merged into the label: "1. Federal adjusted … 1."), amount "12345" or "0.1234"
 * - NY: line "31" (or "…….. 60a" merged into the label), amount "123456 . 00"; "4 00" is an empty line
 */
export type LineStyle = "FED" | "CT" | "NY";

function readCell(text: string, style: LineStyle): { token: string | null; value: number | null } {
  // NY runs its "no handwritten entries" margin note into whatever cell sits beside it.
  const t = text.replace(/\s*NO HANDWRITTEN ENTRIES.*$/, "").trim();
  const c = clean(t);
  if (style === "FED") {
    if (/^\d{1,2}[a-z]?$/.test(t)) return { token: t, value: null };
    return { token: null, value: /[.,]/.test(c) || /^\(.*\)$/.test(c) ? amount(c) : null };
  }
  if (style === "CT") {
    const tok = /^(\d{1,2}[a-z]?)\.$/.exec(t) ?? /\s(\d{1,2}[a-z]?)\.$/.exec(t);
    if (tok) return { token: tok[1]!, value: null };
    return { token: null, value: /\.$/.test(c) ? null : amount(c) };
  }
  const tok = /^(\d{1,2}[a-z]?)(?:\s00)?$/.exec(t) ?? /\.{2,}\s*(\d{1,2}[a-z]?)$/.exec(t);
  if (tok) return { token: tok[1]!, value: null };
  return { token: null, value: c.includes(".") ? amount(c) : null };
}

/** Every numbered line with amounts, in page order. Pages without a title continue the previous form. */
export function readReturnLines(rows: LayoutRow[], fallbackForm: string, style: LineStyle): ReturnLine[] {
  const out: ReturnLine[] = [];
  // Where each line's number was printed, and the amounts already claimed, for the second pass.
  const at = new Map<ReturnLine, { y: number; x1: number; until: number }>();
  const used = new Set<LayoutCell>();
  const pages = [...new Set(rows.map((r) => r.page))].sort((a, b) => a - b);
  let form = fallbackForm;
  for (const page of pages) {
    const pr = rows.filter((r) => r.page === page);
    form = pageForm(pr) ?? form;
    for (const row of pr) {
      let current: ReturnLine | null = null;
      let label: string[] = [];
      for (const cell of row.cells) {
        const text = cell.text.trim();
        if (/^[.\s]+$/.test(text)) continue;
        const { token, value } = readCell(text, style);
        if (token) {
          const words = [...label, /\s/.test(text) ? text : ""].join(" ").replace(/\s+/g, " ").trim();
          label = [];
          if (current) at.get(current)!.until = cell.x0;
          // The same line printed again (label column, then amount column) is one line.
          if (current && current.line === token) {
            if (!current.values.length) current.label = `${current.label} ${words}`.trim();
            at.set(current, { y: row.y, x1: cell.x1, until: Infinity });
            continue;
          }
          // CT: a token with no amount after it was part of the label ("… from Line 3." then "5.").
          if (style === "CT" && current && !current.values.length) {
            current.line = token;
            current.label = `${current.label} ${words}`.trim();
            at.set(current, { y: row.y, x1: cell.x1, until: Infinity });
            continue;
          }
          current = { form, page, line: token, label: words, values: [] };
          at.set(current, { y: row.y, x1: cell.x1, until: Infinity });
          out.push(current);
        } else if (value != null && current) {
          current.values.push(value);
          used.add(cell);
        } else if (value == null) {
          label.push(text);
        }
      }
    }
  }
  // Intuit prints some amounts a few points above or below their line's baseline: an empty
  // federal line takes the nearest unclaimed amount just right of its number, from a row
  // within half a line that has no line numbers of its own.
  if (style === "FED") {
    const empty = out.filter((x) => !x.values.length);
    for (const r of rows.filter((r) => !r.cells.some((c) => readCell(c.text, style).token))) {
      for (const c of r.cells) {
        const value = readCell(c.text, style).value;
        if (value == null || used.has(c)) continue;
        const l = empty
          .filter((x) => x.page === r.page && !x.values.length && Math.abs(at.get(x)!.y - r.y) <= 13)
          .filter((x) => c.x0 >= at.get(x)!.x1 && c.x1 <= Math.min(at.get(x)!.until, at.get(x)!.x1 + 110))
          .sort((a, b) => Math.abs(at.get(a)!.y - r.y) - Math.abs(at.get(b)!.y - r.y))[0];
        if (l) {
          l.values.push(value);
          used.add(c);
        }
      }
    }
  }
  // NY prints its second (New York) column a point or two off the federal one's baseline:
  // the same line again, straight after and with no label of its own, is the same line.
  const merged: ReturnLine[] = [];
  for (const l of out.filter((x) => x.values.length > 0)) {
    const prev = merged.at(-1);
    if (prev && prev.form === l.form && prev.page === l.page && prev.line === l.line && !l.label) prev.values.push(...l.values);
    else merged.push(l);
  }
  return merged;
}

/** The amount on a line (its last column), the first time the line appears on that form. */
export function lineValue(lines: ReturnLine[], form: string, line: string, column: "first" | "last" = "last"): number | null {
  const l = lines.find((x) => x.form === form && x.line === line);
  if (!l) return null;
  return column === "first" ? l.values[0]! : l.values.at(-1)!;
}

/** The amount on the first line whose label matches, on any of the forms. */
export function labelValue(lines: ReturnLine[], forms: string[], label: RegExp, column: "first" | "last" = "last"): number | null {
  const l = lines.find((x) => forms.includes(x.form) && label.test(x.label));
  if (!l) return null;
  return column === "first" ? l.values[0]! : l.values.at(-1)!;
}
