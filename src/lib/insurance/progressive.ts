import { parseMonthNameDate, parseSlashDate } from "../ingest/text.ts";
import { parseLayout, type LayoutCell, type LayoutRow } from "../statements/pdfLayout.ts";
import type { AutoCoverage, AutoPolicy, Coverage, InsuredVehicle, PolicyForm, PropertyPolicy } from "./types.ts";
import { dollarAmounts, titleCase } from "./words.ts";

/**
 * Progressive's policy documents. Auto (Progressive Direct and its sister companies): the
 * declarations page, and every other page of the packet (the contract, the application,
 * the card authorization, state notices) kept as reference forms. Home (written by its ASI
 * group, American Strategic Insurance): the homeowners declaration page (renters,
 * homeowners, condo), and the rest of its packet (the policy, the application, the premium
 * notice, the payment receipt) as forms. Both declarations pages are read from the
 * positioned layout the scan appends: their plain text loses which amount sits in which
 * column (a coverage's deductible beside its premium).
 */

const sq = (s: string) => s.replace(/\s+/g, "");
const first = (re: RegExp, text: string) => re.exec(text)?.[1]?.trim();
const MONTH_DATE = String.raw`[A-Z][a-z]{2,8}\.? \d{1,2}, \d{4}`;

// Progressive's print system stamps every page it produces with these markers.
const PROGRESSIVE_MARKS = /Form_SCTNID_CTGRY\.|\bBDF_AA\b/;
/** ASI's name, or one of its form codes ("ASI HOR CT 09 21", "ASI HO PHAA 12 17"). */
const ASI = /American Strategic Insurance Corp|\bASI HO[A-Z]*(?: [A-Z]+)+ \d{2} \d{2}\b/i;

export type ProgressiveKind = "AUTO" | "PROPERTY" | "FORM";

const isAutoDeclarations = (text: string) => /\bProgressive\b/.test(text) && /This is your (?:Renewal )?Declarations Page/i.test(text) && /Total \d+ month policy premium/i.test(text);
const isHomeDeclarations = (text: string) => ASI.test(text) && /Homeowners Declaration Page/.test(text) && /Total Policy Premium:/.test(text);
/** A page of a Progressive auto packet: the print markers, the welcome booklet, or the auto contract (form 9611). */
const isAutoForm = (text: string) => PROGRESSIVE_MARKS.test(text) || /Progressive Group of Insurance Companies/.test(text) || (/^AUTO POLICY$/m.test(text) && /\bForm 9611[A-Z]? [A-Z]{2} \(\d{2}\/\d{2}\)/.test(text));
/** A page of an ASI home packet: names the company (or prints its form codes) and a policy, or is its contract or an endorsement. */
const isHomeForm = (text: string) => ASI.test(text) && /Policy (?:Number|ID)|POLICY NUMBER|Copyright, American Strategic|THIS ENDORSEMENT CHANGES THE POLICY/.test(text);

export function progressiveKind(text: string): ProgressiveKind | null {
  if (isAutoDeclarations(text)) return "AUTO";
  // A whole new-business packet holds the declaration page too: it reads as the declarations.
  if (isHomeDeclarations(text)) return "PROPERTY";
  if (isHomeForm(text) || isAutoForm(text)) return "FORM";
  return null;
}

/** Whether the text is one of the Progressive declarations pages, which are read from the positioned layout. */
export const progressiveNeedsLayout = (text: string) => isAutoDeclarations(text) || isHomeDeclarations(text);

/** "$500" or "82" or "239.10" → cents; null for anything else ("Included"). */
function wholeOrCents(s: string | undefined): number | null {
  const m = /^\$?([\d,]+)(?:\.(\d{2}))?$/.exec((s ?? "").trim());
  return m ? Number(m[1]!.replace(/,/g, "")) * 100 + Number(m[2] ?? 0) : null;
}

const cellText = (r: LayoutRow) => r.cells.map((c) => c.text).join(" ");
const isRule = (s: string) => /^[….\s]+$/.test(s);

// ---------------------------------------------------------------------------- auto declarations

/** Columns of the coverage table, from its header row: where each kind of value sits. */
type Columns = { limits: LayoutCell; deductible: LayoutCell; premium: LayoutCell };

function columnOf(c: LayoutCell, cols: Columns): "limits" | "deductible" | "premium" | null {
  if (Math.abs(c.x1 - cols.premium.x1) <= 6) return "premium";
  if (c.x0 <= cols.deductible.x1 + 10 && c.x1 >= cols.deductible.x0 - 10 && c.x1 < cols.premium.x0) return "deductible";
  if (Math.abs(c.x0 - cols.limits.x0) <= 10) return "limits";
  return null;
}

export function parseProgressiveAuto(text: string): AutoPolicy {
  const rows = parseLayout(text);
  if (!rows.length) throw new Error("Progressive declarations: the page layout wasn't read.");
  const flat = text.replace(/\s+/g, " ");
  const policyNumber = first(/Policy Number:\s*(\d{6,})/, text);
  const period = new RegExp(`Policy Period:\\s*(${MONTH_DATE})\\s*-\\s*(${MONTH_DATE})`).exec(flat);
  const periodStart = parseMonthNameDate(period?.[1] ?? "");
  const periodEnd = parseMonthNameDate(period?.[2] ?? "");
  const total = /Total (\d+) month policy premium\s*(\$[\d,]+\.\d{2})/i.exec(flat);
  const termPremiumCents = dollarAmounts(total?.[2] ?? "")[0];
  if (!policyNumber || !periodStart || !periodEnd || termPremiumCents == null) throw new Error("Progressive declarations: no policy number, policy period or term premium found.");

  // Drivers: each name, then (for the policyholder) "Additional information: Named insured".
  const namedInsured: string[] = [];
  const drivers: string[] = [];
  const driversAt = rows.findIndex((r) => /^Drivers and household residents$/.test(cellText(r)));
  const outlineAt = rows.findIndex((r) => /^Outline of coverage$/.test(cellText(r)));
  if (driversAt >= 0) {
    const block = rows.slice(driversAt + 1, outlineAt > driversAt ? outlineAt : undefined).map(cellText);
    block.forEach((line, i) => {
      if (/^Additional information:/i.test(line)) return;
      if (/Named insured/i.test(block[i + 1] ?? "")) namedInsured.push(titleCase(line));
      else drivers.push(titleCase(line));
    });
  }

  // Each vehicle: its name, VIN, garaging address and use, then its coverage table and total.
  const vehicles: InsuredVehicle[] = [];
  const byName = new Map<string, AutoCoverage>();
  const coverages: AutoCoverage[] = [];
  const starts = rows.flatMap((r, i) => (i > outlineAt && /^\d{4} [A-Z0-9]/.test(r.cells[0]?.text ?? "") && /^VIN:/.test(rows[i + 1]?.cells[0]?.text ?? "") ? [i] : []));
  starts.forEach((s, j) => {
    const end = starts[j + 1] ?? rows.length;
    const block = rows.slice(s, end);
    const name = /^(\d{4}) (.+)$/.exec(block[0]!.cells[0]!.text)!;
    const garageAt = block.findIndex((r) => /^Garaging Address:/.test(cellText(r)));
    const garage = garageAt < 0 ? [] : [cellText(block[garageAt]!).replace(/^Garaging Address:\s*/, ""), ...block.slice(garageAt + 1, garageAt + 3).map(cellText).filter((l) => !/:/.test(l))];
    vehicles.push({
      n: j + 1,
      year: Number(name[1]),
      make: titleCase(name[2]!),
      vin: first(/^VIN:\s*([A-HJ-NPR-Z0-9]{17})/, block[1]!.cells[0]!.text) ?? null,
      garaged: garage.length ? garage.join(", ") : null,
      lienholder: block.map(cellText).map((l) => /^(?:Lienholder|Loss payee):\s*(.+)$/i.exec(l)?.[1]).find(Boolean) ?? null,
    });

    const headAt = block.findIndex((r) => r.cells.some((c) => c.text === "Limits") && r.cells.some((c) => c.text === "Premium"));
    if (headAt < 0) return;
    const head = block[headAt]!;
    const cols: Columns = { limits: head.cells.find((c) => c.text === "Limits")!, deductible: head.cells.find((c) => c.text === "Deductible") ?? { x0: -1, x1: -1, text: "" }, premium: head.cells.find((c) => c.text === "Premium")! };
    // A coverage is a row at the table's left edge; an indented row beneath it is a part of it ("Liability To Others": bodily injury, property damage).
    type Group = { label: string; x0: number; limits: string[]; deductible: string | null; premium: number | null; parts: { label: string; limit: string }[] };
    const groups: Group[] = [];
    for (const r of block.slice(headAt + 1)) {
      const label = r.cells[0];
      if (!label || isRule(label.text)) continue;
      if (/^Total \d+ month policy premium/i.test(label.text)) break;
      const values = { limits: [] as string[], deductible: null as string | null, premium: null as number | null };
      for (const c of r.cells.slice(1)) {
        const col = columnOf(c, cols);
        if (col === "limits") values.limits.push(c.text);
        else if (col === "deductible") values.deductible = c.text;
        else if (col === "premium") values.premium = wholeOrCents(c.text);
      }
      const parent = groups.at(-1);
      if (parent && label.x0 > parent.x0 + 3) {
        parent.parts.push({ label: label.text, limit: values.limits.join(" ") });
        continue;
      }
      groups.push({ label: label.text, x0: label.x0, ...values, parts: [] });
    }
    for (const g of groups) {
      const limitText = g.parts.length ? g.parts.map((p) => p.limit).join("; ") : g.limits.join(" ");
      const deductibleCents = dollarAmounts(g.deductible ?? "")[0] ?? null;
      const limit = [limitText, deductibleCents != null ? `${g.deductible} deductible` : ""].filter(Boolean).join(", ") || "Included";
      let c = byName.get(g.label);
      if (!c) {
        c = {
          code: null,
          name: g.label + (g.parts.length ? ` (${g.parts.map((p) => p.label).join(", ")})` : ""),
          per: null,
          limit,
          limitCents: dollarAmounts(limitText),
          deductibleCents,
          additional: false,
          premiumCents: [],
        };
        byName.set(g.label, c);
        coverages.push(c);
      }
      c.premiumCents[j] = g.premium;
    }
  });
  for (const c of coverages) for (let j = 0; j < vehicles.length; j++) c.premiumCents[j] ??= null;

  // Discounts are named, not priced: one list after the policy number, ended by the next heading.
  const discountsAt = rows.findIndex((r) => /^Premium discounts$/.test(cellText(r)));
  const discountsEnd = rows.findIndex((r, i) => i > discountsAt && /^Coverage on rented vehicle|^Company officers$/.test(cellText(r)));
  const discountText =
    discountsAt < 0
      ? ""
      : rows
          .slice(discountsAt + 1, discountsEnd < 0 ? undefined : discountsEnd)
          .flatMap((r) => r.cells.filter((c) => !isRule(c.text) && c.text !== "Policy" && !/^\d{6,}$/.test(c.text)).map((c) => c.text))
          .join(" ");
  const discounts = discountText
    .split(/,\s*|\s+and\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => ({ name, cents: null }));

  return {
    kind: "AUTO",
    insurer: first(/Underwritten by:\s*\n?\s*(.+)/, text) ?? "Progressive",
    policyNumber,
    namedInsured,
    drivers,
    issuedDate: parseMonthNameDate(first(new RegExp(`Underwritten by:\\s*.+?\\s+(${MONTH_DATE})`), flat) ?? ""),
    periodStart,
    periodEnd,
    termMonths: Number(total![1]),
    renewal: /This is your Renewal Declarations Page/i.test(flat),
    termPremiumCents,
    vehicles,
    coverages,
    discounts,
    discountTotalCents: null,
    contractType: first(/The policy contract is form (\S+ [A-Z]{2} \(\d{2}\/\d{2}\))/, flat) ?? null,
    amendments: first(/contract is modified by forms? (.+?\(\d{2}\/\d{2}\))\s*\./, flat) ?? null,
    unitEndorsements: null,
    servicePhone: first(/(1-\d{3}-\d{3}-\d{4})/, text) ?? null,
  };
}

// ---------------------------------------------------------------------------- home declarations

const PLAN_LINES: [RegExp, PropertyPolicy["line"]][] = [
  [/^HO-?R$|^HO-?4$|Renters/i, "RENTERS"],
  [/^HO-?6$|Condo/i, "CONDO"],
  [/^HO-?[1-35]$|Homeowners/i, "HOMEOWNERS"],
];

export function parseProgressiveHome(text: string): PropertyPolicy {
  // Only the declaration page's own pages: a whole packet holds the notice, the application and the contract too.
  const all = parseLayout(text);
  const decPages = new Set(all.filter((r) => r.cells.some((c) => /\bASI HO[A-Z]* [A-Z]{2} DEC \d{2} \d{2}\b/.test(c.text))).map((r) => r.page));
  const rows = all.filter((r) => decPages.has(r.page));
  if (!rows.length) throw new Error("Progressive home declarations: the declaration page wasn't found in the layout.");

  /** The cell to the right of a label, on its row. */
  const beside = (re: RegExp): string | null => {
    for (const r of rows) {
      const i = r.cells.findIndex((c) => re.test(c.text.trim()));
      if (i >= 0 && r.cells[i + 1]) return r.cells[i + 1]!.text.trim();
    }
    return null;
  };
  /** The rows under a label, in its column, until a blank gap or another label. */
  const under = (re: RegExp, max: number): string[] => {
    const i = rows.findIndex((r) => r.cells.some((c) => re.test(c.text.trim())));
    if (i < 0) return [];
    const x = rows[i]!.cells.find((c) => re.test(c.text.trim()))!.x0;
    const out: string[] = [];
    for (const r of rows.slice(i + 1)) {
      const c = r.cells.find((c) => Math.abs(c.x0 - x) <= 4);
      if (!c || /:$/.test(c.text.trim()) || out.length >= max || r.page !== rows[i]!.page) break;
      out.push(c.text.trim());
    }
    return out;
  };

  const policyNumber = beside(/^Policy Number:$/);
  const periodStart = parseSlashDate(beside(/^Policy Inception:$/) ?? "");
  const periodEnd = parseSlashDate(beside(/^Policy Expiration:$/) ?? "");
  const totalCents = dollarAmounts(beside(/^Total Policy Premium:$/) ?? "")[0];
  if (!policyNumber || !periodStart || !periodEnd || totalCents == null) throw new Error("Progressive home declarations: no policy number, policy period or premium found.");

  // Section I and II coverages: "C. Personal Property  $75,000  239.10".
  const property: Coverage[] = [];
  const liability: Coverage[] = [];
  const tableAt = rows.findIndex((r) => /^Coverages and Limits of Liability$/.test(r.cells[0]?.text.trim() ?? ""));
  // A row under a section label (or continuing the one above it) is "C. Name - Per", then its limit, then its premium.
  let section: Coverage[] = property;
  for (const r of tableAt < 0 ? [] : rows.slice(tableAt + 1)) {
    const cells = r.cells.map((c) => c.text.trim());
    if (/^OTHER COVERAGES/i.test(cells[0] ?? "")) break;
    if (/^SECTION II:?$/.test(cells[0] ?? "")) section = liability;
    else if (/^SECTION I:?$/.test(cells[0] ?? "")) section = property;
    const i = cells.findIndex((t) => /^[A-Z]\.\s+\S/.test(t));
    const limit = i < 0 ? undefined : cells[i + 1];
    if (i < 0 || !limit) continue;
    const m = /^([A-Z])\.\s+(.+)$/.exec(cells[i]!)!;
    const [name, per] = m[2]!.split(/\s+-\s+/);
    section.push({ code: m[1]!, name: name!, per: per ?? null, limit, limitCents: dollarAmounts(limit), deductibleCents: null, additional: false });
  }

  // Page 2: the policy form and endorsements (with their form numbers), additional coverages, and the premium's line items.
  const forms: PropertyPolicy["forms"] = [];
  const discounts: string[] = [];
  let deductibleName: string | null = null;
  const otherAt = rows.findIndex((r) => /^Other Coverages and Endorsements:$/.test(r.cells[0]?.text.trim() ?? ""));
  const otherEnd = rows.findIndex((r, i) => i > otherAt && /^Scheduled Items:$/.test(r.cells[0]?.text.trim() ?? ""));
  for (const r of otherAt < 0 ? [] : rows.slice(otherAt + 1, otherEnd < 0 ? undefined : otherEnd)) {
    const [label, ...rest] = r.cells.map((c) => c.text.trim());
    if (!label || /^Form Number$/.test(rest[0] ?? "") || label === "Premium") continue;
    const code = rest.find((t) => /^ASI HO/.test(t));
    if (code) {
      forms.push({ code, name: label, isNew: false });
      continue;
    }
    const additional = /^(.+?)\s+(\$[\d,]+(?:\/\$[\d,]+)*)$/.exec(label);
    if (additional) {
      property.push({ code: null, name: additional[1]!, per: null, limit: additional[2]!, limitCents: dollarAmounts(additional[2]!), deductibleCents: null, additional: true });
      continue;
    }
    if (/Deductible$/i.test(label)) {
      deductibleName = label.replace(/\s*Deductible$/i, "");
      continue;
    }
    // A line item that takes money off the premium (a rating factor that happens to be negative isn't a discount).
    if (rest.some((t) => /^-[\d,]+\.\d{2}$/.test(t)) && !/Factor|Premium$/i.test(label)) discounts.push(label);
  }

  const deductible = beside(/^DEDUCTIBLE:$/);
  const formName = forms.find((f) => /Policy$/.test(f.name))?.name ?? "Home Policy";
  const plan = beside(/^Plan Type:$/) ?? "";
  const insured = under(/^Named Insured:$/, 1)[0] ?? "";
  const insurer = rows.flatMap((r) => r.cells).find((c) => /^AMERICAN STRATEGIC INSURANCE CORP/i.test(c.text.trim()))?.text.trim().replace(/\.$/, "");

  return {
    kind: "PROPERTY",
    line: PLAN_LINES.find(([re]) => re.test(plan) || re.test(formName))?.[1] ?? "OTHER",
    form: formName,
    insurer: insurer ? titleCase(insurer) : "American Strategic Insurance Corp",
    policyNumber,
    namedInsured: insured ? insured.split(/\s+AND\s+/i).map((n) => titleCase(n.trim())) : [],
    premises: under(/^Residence Premises:$/, 2),
    periodStart,
    periodEnd,
    termMonths: Math.round((Date.parse(periodEnd) - Date.parse(periodStart)) / (30.44 * 86_400_000)) || null,
    renewal: /^Renewal/i.test(beside(/^Activity of This Transaction:$/) ?? ""),
    autoRenews: false,
    annualPremiumCents: totalCents,
    totalPremiumCents: totalCents,
    discounts,
    property,
    liability,
    deductibles: deductible ? [{ name: deductibleName ?? "Deductible", cents: dollarAmounts(deductible)[0] ?? null, text: deductible }] : [],
    lossSettlement: [],
    forms,
    inflationIndex: null,
    billing: null,
    amountDue: null,
    // The agency's name is printed under its label (the cell beside it is the next column's label).
    agent: { name: under(/^Agent:$/, 1)[0] ?? null, phone: beside(/^For Policy Service, Call:$/) },
    preparedDate: null,
  };
}

// ---------------------------------------------------------------------------- packet pages

/** Lines that are a page's letterhead or boilerplate, never its title. */
const NOT_TITLE = /^(Form_SCTNID|<docindex>|\d{6,} N |Policy (Number|ID)|Underwritten by|Page (of|\d)|Policyholder|Named Insured|Applicant|Agent|P\.?O\.? Box|PO BOX|Progressive$|PROGRESSIVE$|Customer Service|24 hours|Online Service|progressive\.com|THIS ENDORSEMENT|Copyright|-- \d)/i;
const PERSON = /^[A-Z][a-z]+ (?:[A-Z]\.? )?[A-Z][a-z]+(?: and [A-Z][a-z]+ (?:[A-Z]\.? )?[A-Z][a-z]+)?$/;

/** A packet page kept for reference: its title and form code, and the policy it belongs to when printed. */
export function parseProgressiveForm(text: string): PolicyForm {
  const home = ASI.test(text) && !PROGRESSIVE_MARKS.test(text);
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const known: [RegExp, string][] = [
    [/^Homeowners Declaration Page$/, "Declaration page"],
    [/^Premium Notice$/, "Premium notice"],
    [/^Payment Receipt$/, "Payment receipt"],
    [/^Insurance Application$/, "Insurance application"],
    [/^YOUR (RENTERS|HOMEOWNERS|CONDO\w*) PROTECTION POLICY$/, ""],
    [/^Your Auto Policy\.$/, "Your auto policy, easier"],
    [/^Welcome to Progressive$/, "Welcome letter"],
  ];
  let title: string | null = null;
  for (const l of lines) {
    const k = known.find(([re]) => re.test(l));
    if (k) {
      title = k[1] || titleCase(l);
      break;
    }
  }
  if (/^AUTO POLICY$/m.test(text) && /\bForm 9611/.test(text)) title = "Auto policy contract";
  title ??= lines.find((l) => /^[A-Za-z][A-Za-z ,'&/()-]{6,80}$/.test(l) && l.split(" ").length >= 2 && !NOT_TITLE.test(l) && !PERSON.test(l) && !/[A-Z]{2} \d{5}/.test(l) && !/Insurance Co(rp)?\.?$/i.test(l)) ?? "Policy page";

  const code = home ? first(/\b(ASI HO[A-Z]*(?: [A-Z]+)+ \d{2} \d{2})\b/, text) : first(/\bForm ([A-Z0-9]+(?: [A-Z]{2})? \(\d{2}\/\d{2}\))/, text);
  return {
    kind: "FORM",
    insurer: home ? "American Strategic Insurance Corp" : (first(/Underwritten by:\s*\n?\s*(.+)/, text) ?? "Progressive"),
    line: home ? "HOME" : "AUTO",
    policyNumber: first(/Policy Number:[ \t]*([A-Z]{0,4}\d{6,})/, text) ?? null,
    code: code ?? null,
    title: title.length > 1 && title === title.toUpperCase() ? titleCase(title) : title,
  };
}
