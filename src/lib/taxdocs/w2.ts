import type { LayoutRow } from "../statements/pdfLayout.ts";
import { CENTS, findLabels, mode, moneyCents, readBoxes, type BoxSpec, type LabelHit } from "./boxes.ts";
import type { W2Form } from "./types.ts";

/**
 * Form W-2, from any payroll provider's PDF: every copy on the page
 * is read by position and the copies vote. Box numbers are matched by their words, since
 * providers print "1 6 State wages" or "15 State … 16 State wages" run together.
 */

export const BOXES: BoxSpec[] = [
  { id: "1", label: /Wages, tips, other comp/i },
  { id: "2", label: /Federal income tax withheld/i },
  { id: "3", label: /Social security wages/i },
  { id: "4", label: /Social security tax withheld/i },
  { id: "5", label: /Medicare wages and tips/i },
  { id: "6", label: /Medicare tax withheld/i },
  { id: "10", label: /Dependent care benefits/i },
  { id: "16", label: /State wages, tips/i },
  { id: "17", label: /State income tax/i },
  { id: "18", label: /Local wages, tips/i },
  { id: "19", label: /Local income tax/i },
  // Neighbouring boxes, so their amounts aren't taken by the boxes above.
  { id: "_7", label: /Social security tips/i },
  { id: "_8", label: /Allocated tips/i },
  { id: "_11", label: /Nonqualified plans/i },
  { id: "_12", label: /\b1 ?2[a-d]\b/ },
  { id: "_13", label: /Statutory employee|Stat emp/i },
  { id: "_14", label: /\b1 ?4 Other\b/ },
  { id: "_15", label: /Employer.s state I\.?D/i },
  { id: "_20", label: /Locality name/i },
];

const BOX12: BoxSpec[] = ["a", "b", "c", "d"].map((l) => ({ id: `12${l}`, label: new RegExp(`\\b1 ?2${l}\\b`) }));
const STATE: BoxSpec[] = [{ id: "15", label: /\b1 ?5\s+State\b/ }];
const LOCALITY: BoxSpec[] = [{ id: "20", label: /Locality name/i }];
const US_STATES = new Set(
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" "),
);

export function parseW2(rows: LayoutRow[]): { w2: W2Form; warnings: string[] } {
  const warnings: string[] = [];
  const page1 = rows.filter((r) => r.page === 1);
  const b = readBoxes(page1, BOXES, { value: CENTS });
  const amount = (id: string) => b[id] ?? 0;
  for (const id of ["1", "2", "3", "4", "5", "6"]) if (b[id] == null) warnings.push(`Box ${id} wasn't found.`);

  const box12 = readBox12(page1);
  // The state is its own cell ("CT") or leads the employer's state ID ("2025 NY 123456789").
  const stateCode = mode(textUnder(page1, STATE, (t) => t.split(/\s+/).find((w) => US_STATES.has(w)) ?? null));
  const locality = mode(textUnder(page1, LOCALITY, (t) => (/^[A-Z][A-Z .]{1,20}$/.test(t) && !US_STATES.has(t) ? t : null)));
  const w2: W2Form = {
    employer: firstTextUnder(page1, /Employer.s name/i) ?? "",
    ein: page1.flatMap((r) => r.cells).find((c) => /^\d{2}-\d{7}$/.test(c.text.trim()))?.text.trim() ?? null,
    employee: firstTextUnder(page1, /Employee.s name/i) ?? "",
    wages: amount("1"),
    federalWithheld: amount("2"),
    ssWages: amount("3"),
    ssWithheld: amount("4"),
    medicareWages: amount("5"),
    medicareWithheld: amount("6"),
    dependentCare: amount("10"),
    box12,
    states: stateCode || b["16"] != null ? [{ state: stateCode ?? "", wages: amount("16"), withheld: amount("17") }] : [],
    locals: b["18"] != null || b["19"] != null ? [{ name: locality ?? "", wages: amount("18"), withheld: amount("19") }] : [],
  };
  if (!w2.employer) warnings.push("Employer name wasn't found.");
  if (w2.states.length && !w2.states[0]!.state) warnings.push("Box 15's state wasn't found.");
  return { w2, warnings };
}

/** Box 12: a code (inline after "12b", or in the row under the label) and its amount. */
function readBox12(rows: LayoutRow[]): W2Form["box12"] {
  const hits = findLabels(rows, BOX12);
  const seen = new Map<string, { code: string; amount: number }[]>();
  for (const h of hits) {
    const inline = /^1 ?2[a-d]\s+([A-Z]{1,2})\b/.exec(h.text)?.[1] ?? null;
    const candidates = rows
      .filter((r) => r.page === h.page && r.y <= h.y && h.y - r.y <= 14)
      .sort((a, b) => b.y - a.y);
    let found: { code: string; amount: number } | null = null;
    for (const r of candidates) {
      const cells = r.cells.filter((c) => c.x0 >= h.x0 - 6 && c.x1 <= h.x1 + 100);
      // The code prints alone ("D") or after its caption ("Code D").
      const codeCell = cells.find((c) => /^(?:Code\s+)?[A-Z]{1,2}$/.test(c.text.trim()) && c.x0 >= h.x0 - 6);
      const code = inline ?? codeCell?.text.trim().replace(/^Code\s+/, "");
      const amt = cells.find((c) => CENTS.test(c.text.replace(/\s+/g, "")) && c.x0 > h.x0);
      if (code && amt) {
        found = { code, amount: moneyCents(amt.text)! };
        break;
      }
    }
    if (found) seen.set(h.id, [...(seen.get(h.id) ?? []), found]);
  }
  return [...seen.keys()]
    .sort()
    .map((k) => mode(seen.get(k)!)!)
    .filter((e) => e.amount !== 0);
}

/** Short text cells printed near a label (a state code, a locality), one per copy. */
function textUnder(rows: LayoutRow[], specs: BoxSpec[], pick: (t: string) => string | null): string[] {
  const out: string[] = [];
  for (const h of findLabels(rows, specs)) {
    const near = rows.filter((r) => r.page === h.page && Math.abs(r.y - h.y) <= 20 && r.y !== h.y).sort((a, b) => Math.abs(a.y - h.y) - Math.abs(b.y - h.y));
    for (const r of near) {
      const c = r.cells.find((c) => pick(c.text.trim()) != null && c.x0 >= h.x0 - 8 && c.x0 <= h.x1 + 10);
      if (c) {
        out.push(pick(c.text.trim())!);
        break;
      }
    }
  }
  return out;
}

/** The first line of text printed under a label (the employer's or employee's name), voted across copies. */
function firstTextUnder(rows: LayoutRow[], label: RegExp): string | null {
  const hits: LabelHit[] = findLabels(rows, [{ id: "x", label }]);
  const names: string[] = [];
  for (const h of hits) {
    const below = rows.filter((r) => r.page === h.page && r.y < h.y && h.y - r.y <= 22).sort((a, b) => b.y - a.y);
    for (const r of below) {
      const c = r.cells.find((c) => Math.abs(c.x0 - h.x0) <= 30 && /[A-Za-z]{2}/.test(c.text) && !/\d{3}-\d{2}-\d{4}|number|Batch/i.test(c.text));
      if (c) {
        names.push(c.text.trim());
        break;
      }
    }
  }
  return mode(names);
}
