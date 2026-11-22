import { parseMonthNameDate } from "../ingest/text.ts";
import { parseLayout, type LayoutRow } from "../statements/pdfLayout.ts";
import type { Coverage, PropertyPolicy } from "./types.ts";
import { dollarAmounts, spaced, spacedCity, spacedName, spacedStreet, titleCase } from "./words.ts";

/**
 * State Farm's home declarations (renters, homeowners, condo unit owners), read from the
 * positioned layout the scan appends (pdfLayout.ts, with mirrored runs turned back round).
 * Their plain text is unusable: no word is spaced, and every right-aligned value comes out
 * mirrored ("00.912$"). The layout puts each label beside its value on one row.
 */

const sq = (s: string) => s.replace(/\s+/g, "");
const rowText = (r: LayoutRow) => sq(r.cells.map((c) => c.text).join(""));

/** "MAY072026" → "2026-05-07". */
function sfDate(s: string | undefined): string | null {
  const m = /([A-Z]{3})(\d{2})(\d{4})/.exec(s ?? "");
  return m ? parseMonthNameDate(`${m[1]} ${Number(m[2])}, ${m[3]}`) : null;
}

/** Whether the plain text is a State Farm home declarations page (its words run together). */
export function isStateFarmHomeDeclarations(text: string): boolean {
  const s = sq(text);
  return /StateFarm/i.test(s) && /DECLARATIONS/.test(s) && /SECTIONI-PROPERTYCOVERAGES/i.test(s);
}

const LINES: [RegExp, PropertyPolicy["line"]][] = [
  [/^Renters/i, "RENTERS"],
  [/^Homeowners/i, "HOMEOWNERS"],
  [/^Condominium/i, "CONDO"],
];

export function parseStateFarmHome(text: string): PropertyPolicy {
  const rows = parseLayout(text);
  if (!rows.length) throw new Error("State Farm declarations: the page layout wasn't read.");
  const at = (re: RegExp, from = 0) => rows.findIndex((r, i) => i >= from && re.test(sq(r.cells[0]?.text ?? "")));
  const textMatch = (re: RegExp) => {
    for (const r of rows) {
      const m = re.exec(rowText(r));
      if (m) return m;
    }
    return null;
  };
  /** The value beside a label: the next cell, with a lone "$" cell before it put back in front. */
  const valueOf = (r: LayoutRow): string | null => {
    const rest = r.cells.slice(1);
    const dollar = rest[0]?.text === "$";
    const v = rest[dollar ? 1 : 0]?.text;
    return v == null ? null : dollar ? `$${v}` : v;
  };
  const labelled = (re: RegExp) => {
    const i = at(re);
    return i < 0 ? null : valueOf(rows[i]!);
  };

  const policyNumber = labelled(/^PolicyNumber:?$/);
  const period = textMatch(/EffectiveDates:?([A-Z]{3}\d{6})to([A-Z]{3}\d{6})/);
  const periodStart = sfDate(period?.[1]);
  const periodEnd = sfDate(period?.[2]);
  const annual = dollarAmounts(labelled(/^AnnualPremium$/) ?? "")[0];
  if (!policyNumber || !periodStart || !periodEnd || annual == null) throw new Error("State Farm declarations: no policy number, policy period or annual premium found.");
  const total = dollarAmounts(labelled(/^TotalPremium$/) ?? "")[0] ?? annual;

  // The form's name stands alone in its cell ("RentersPolicy").
  const formCell = rows.flatMap((r) => r.cells).find((c) => /^(Renters|Homeowners|CondominiumUnitowners|[A-Z][a-z]+)Policy$/.test(sq(c.text)) && !/^Your/.test(c.text));
  const form = formCell ? spaced(sq(formCell.text)) : "Home Policy";

  /** The lines under a heading, in its column. */
  const under = (heading: RegExp, max: number) => {
    const i = rows.findIndex((r) => r.cells.some((c) => heading.test(sq(c.text))));
    if (i < 0) return [];
    const x = rows[i]!.cells.find((c) => heading.test(sq(c.text)))!.x0;
    const out: string[] = [];
    for (const r of rows.slice(i + 1)) {
      if (out.length >= max || r.page !== rows[i]!.page) break;
      const c = r.cells.find((c) => Math.abs(c.x0 - x) <= 4);
      if (c) out.push(c.text);
    }
    return out;
  };

  const insuredAt = at(/^NAMEDINSURED$/);
  const namedInsured: string[] = [];
  for (const r of insuredAt < 0 ? [] : rows.slice(insuredAt + 1)) {
    const name = r.cells[0]?.text ?? "";
    if (/^SECTION/i.test(sq(name)) || r.page !== rows[insuredAt]!.page || namedInsured.length >= 4) break;
    namedInsured.push(titleCase(spacedName(sq(name))));
  }

  const [street, city] = under(/^LocationofResidencePremises$/, 2);
  const agentLines = under(/^YourStateFarmAgent$/, 5);
  const phone = textMatch(/^Phone:(\(\d{3}\)\s?\d{3}-\d{4})/)?.[1] ?? null;

  const discountsAt = at(/^Yourpremiumhasalreadybeenadjustedbythefollowing:?$/);
  const totalAt = at(/^TotalPremium$/);
  const discounts = discountsAt < 0 ? [] : rows.slice(discountsAt + 1, totalAt > discountsAt ? totalAt : discountsAt + 3).flatMap((r) => r.cells.map((c) => spaced(sq(c.text))));

  const section = (start: RegExp, end: RegExp): Coverage[] => {
    const i = at(start);
    if (i < 0) return [];
    const j = at(end, i + 1);
    let additional = false;
    const out: Coverage[] = [];
    for (const r of rows.slice(i + 1, j < 0 ? undefined : j)) {
      const label = sq(r.cells[0]?.text ?? "");
      if (/^Coverage$/.test(label)) continue;
      if (/^AdditionalCoverages$/.test(label)) {
        additional = true;
        continue;
      }
      const value = valueOf(r);
      if (!value) continue;
      const coded = additional ? null : /^([A-Z])([A-Z][a-z].*)$/.exec(label);
      const words = spaced(coded ? coded[2]! : label);
      const per = /\(([^)]*)\)$/.exec(words)?.[1] ?? null;
      const limit = spaced(sq(value));
      out.push({
        code: coded?.[1] ?? null,
        name: per ? words.replace(/\s*\([^)]*\)$/, "") : words,
        per,
        limit,
        limitCents: dollarAmounts(limit),
        deductibleCents: null,
        additional,
      });
    }
    return out;
  };

  const dedAt = at(/^SectionIDeductible$/);
  const lossAt = at(/^LOSSSETTLEMENTPROVISIONS$/);
  const deductibles =
    dedAt < 0
      ? []
      : rows.slice(dedAt + 1, lossAt > dedAt ? lossAt : dedAt + 4).flatMap((r) => {
          const v = valueOf(r);
          return v ? [{ name: spaced(sq(r.cells[0]!.text)), cents: dollarAmounts(v)[0] ?? null, text: v }] : [];
        });

  const lossSettlement: string[] = [];
  for (const r of lossAt < 0 ? [] : rows.slice(lossAt + 1)) {
    const label = sq(r.cells[0]?.text ?? "");
    if (r.page !== rows[lossAt]!.page || /^o\d?F\d|^FORMS|^Page\d/i.test(label) || !label) break;
    const m = /^([A-Z]\d)(.+)$/.exec(label);
    lossSettlement.push(m ? `${m[1]} ${spaced(m[2]!)}` : spaced(label));
  }

  const formsAt = at(/^FORMS,OPTIONS,ANDENDORSEMENTS$/);
  const formsEnd = at(/^ADDITIONALMESSAGES$/, formsAt + 1);
  const forms = (formsAt < 0 ? [] : rows.slice(formsAt + 1, formsEnd < 0 ? undefined : formsEnd)).flatMap((r) => {
    const code = r.cells[0]?.text ?? "";
    const name = r.cells[1]?.text;
    if (!/^[A-Z]{1,3}\d?-[\d.]+[A-Z]?$/.test(code) || !name) return [];
    return [{ code, name: spaced(sq(name).replace(/^\*/, "")), isNew: name.startsWith("*") }];
  });

  // The row also holds the blank form lines ("____") printed beside it.
  const billed = textMatch(/^Paymentisdueby(.+)$/)?.[1]?.replace(/_+/g, "");

  return {
    kind: "PROPERTY",
    line: LINES.find(([re]) => re.test(sq(form)))?.[1] ?? "OTHER",
    form,
    insurer: ((n) => (n ? spaced(n) : "State Farm"))(textMatch(/^(StateFarm[A-Za-z]*Company)$/)?.[1]),
    policyNumber,
    namedInsured,
    premises: [street ? spacedStreet(sq(street)) : null, city ? spacedCity(sq(city)) : null].filter((x): x is string => !!x),
    periodStart,
    periodEnd,
    termMonths: ((m) => (m ? Number(m) : null))(textMatch(/^PolicyPeriod:(\d+)Months/i)?.[1]),
    renewal: rows.some((r) => /RENEWALDECLARATIONS/.test(rowText(r))),
    autoRenews: rows.some((r) => /^AutomaticRenewal$/.test(rowText(r))),
    annualPremiumCents: annual,
    totalPremiumCents: total,
    discounts,
    property: section(/^SECTIONI-PROPERTYCOVERAGES/, /^SECTIONII-/),
    liability: section(/^SECTIONII-LIABILITYCOVERAGES/, /^(INFLATION|SectionIDeductible|o\d?F\d+[A-Z]?DEDUCTIBLES|DEDUCTIBLES)/),
    deductibles,
    lossSettlement,
    forms,
    inflationIndex: textMatch(/InflationCoverageIndex:([\d.]+)/)?.[1] ?? null,
    billing: billed ? ((m) => (m ? `Billed through ${m[1]}` : spaced(billed)))(/^BILLEDTHROUGH(.+)$/.exec(billed)) : null,
    amountDue: labelled(/^AMOUNTDUE:?$/),
    agent: { name: agentLines[0] ? spacedName(sq(agentLines[0])) : null, phone },
    preparedDate: sfDate(textMatch(/Prepared([A-Z]{3}\d{6})/)?.[1]),
  };
}
