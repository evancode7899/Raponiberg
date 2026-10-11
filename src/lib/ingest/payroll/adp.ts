import { parseLayout, type LayoutCell, type LayoutRow } from "../../statements/pdfLayout.ts";
import { collapseSpaces, parseSlashDate } from "../text.ts";
import { classifyDeduction, classifyEarning, classifyEmployer } from "./classify.ts";
import type { PayStubFacts, StubLine, StubLineKind } from "./types.ts";

/** "$3 446 54", "-225 00", "9 27*": ADP prints spaces in place of separators. */
const ADP_MONEY = /^-?\$?\d[\d ]* \d{2}\*?$/;
const adpCents = (s: string) => Number(s.replace(/\D/g, ""));

type AdpPrinted = { grossCurrent: number | null; grossYtd: number | null; netCurrent: number | null; netYtd: number | null; federalTaxableCurrent: number | null };

/**
 * ADP "Earnings Statement", read from the positioned layout (see statements/pdfLayout.ts):
 * the plain text scatters amounts away from their labels. Each amount is assigned to the
 * column header it is right-aligned under: rate / hours / this period / year to date on
 * the left, this period / total to date in the "Other Benefits" panel on the right.
 *
 * Rows above "Gross Pay" are earnings; rows below it, through "Net Pay", are taxes and
 * deductions ("*" marks pre-tax). ADP leaves year-to-date blank on some deductions; the
 * year-to-date total of those is gross YTD − net YTD − the printed lines (two printed
 * figures), carried as one labelled line rather than lost.
 */
export function extractAdpStubs(text: string): PayStubFacts[] {
  const rows = parseLayout(text);
  const pages = [...new Set(rows.map((r) => r.page))];
  return pages.flatMap((p) => {
    const s = parseAdpPage(rows.filter((r) => r.page === p));
    return s ? [s] : [];
  });
}

function parseAdpPage(rows: LayoutRow[]): PayStubFacts | null {
  const pageText = rows.map((r) => r.cells.map((c) => c.text).join(" ")).join("\n");
  const date = (re: RegExp) => {
    const m = re.exec(pageText)?.[1];
    return m ? parseSlashDate(m) : null;
  };
  const payDate = date(/Pay Date:\s*(\d{2}\/\d{2}\/\d{4})/);
  if (!payDate) return null;

  const headerIdx = rows.findIndex((r) => r.cells.some((c) => c.text === "this period") && r.cells.some((c) => c.text === "year to date"));
  if (headerIdx < 0) return null;
  const panelTitle = rows.flatMap((r) => r.cells).find((c) => /^Other Benefits/.test(c.text));
  const panelLeft = panelTitle?.x0 ?? Infinity;
  const panelHeader = rows.find((r) => r.cells.some((c) => c.x0 >= panelLeft && c.text === "this period"));
  type Col = "rate" | "hours" | "current" | "ytd" | "panelCurrent" | "panelYtd";
  const columns: { col: Col; right: number }[] = [];
  for (const c of rows[headerIdx]!.cells) {
    const col = ({ rate: "rate", "salary/hours": "hours", "this period": "current", "year to date": "ytd" } as Record<string, Col>)[c.text];
    if (col) columns.push({ col, right: c.x1 });
  }
  for (const c of panelHeader?.cells ?? []) {
    if (c.x0 < panelLeft) continue;
    if (c.text === "this period") columns.push({ col: "panelCurrent", right: c.x1 });
    if (c.text === "total to date") columns.push({ col: "panelYtd", right: c.x1 });
  }
  const columnOf = (c: LayoutCell): Col | null => {
    const right = c.text.endsWith("*") ? c.x1 - 4 : c.x1;
    let best: { col: Col; d: number } | null = null;
    for (const k of columns) {
      const d = Math.abs(k.right - right);
      if (d <= 20 && (!best || d < best.d)) best = { col: k.col, d };
    }
    return best?.col ?? null;
  };

  type Raw = { name: string; current: number | null; ytd: number | null; starred: boolean };
  const earnings: Raw[] = [];
  const deductions: Raw[] = [];
  const panel: Raw[] = [];
  const printed: AdpPrinted = { grossCurrent: null, grossYtd: null, netCurrent: null, netYtd: null, federalTaxableCurrent: null };
  let section: "EARNINGS" | "DEDUCTIONS" | "DONE" = "EARNINGS";
  // The deposit advice below the ADP footer repeats the net pay; it isn't a line item.
  const footerIdx = rows.findIndex((r, i) => i > headerIdx && r.cells.some((c) => /ADP, Inc\.|^Advice number:|^Deposited/.test(c.text)));
  for (const r of rows.slice(headerIdx + 1, footerIdx < 0 ? undefined : footerIdx)) {
    const left = r.cells.filter((c) => c.x0 < panelLeft);
    const right = r.cells.filter((c) => c.x0 >= panelLeft);
    const read = (cells: LayoutCell[], cur: Col, ytd: Col): Raw | null => {
      const label = cells.find((c) => !ADP_MONEY.test(c.text));
      if (!label) return null;
      const raw: Raw = { name: collapseSpaces(label.text), current: null, ytd: null, starred: false };
      for (const c of cells) {
        if (c === label || !ADP_MONEY.test(c.text)) continue;
        const col = columnOf(c);
        if (col === cur) {
          raw.current = adpCents(c.text);
          raw.starred = c.text.endsWith("*");
        } else if (col === ytd) raw.ytd = adpCents(c.text);
      }
      return raw;
    };

    const l = section === "DONE" ? null : read(left, "current", "ytd");
    if (l) {
      if (l.name === "Gross Pay") {
        printed.grossCurrent = l.current;
        printed.grossYtd = l.ytd;
        section = "DEDUCTIONS";
      } else if (l.name === "Net Pay") {
        printed.netCurrent = l.current;
        section = "DONE";
      } else if (l.current != null || l.ytd != null) (section === "EARNINGS" ? earnings : deductions).push(l);
    }
    // The deposit line under Net Pay carries the year-to-date net.
    const check = read(left, "current", "ytd");
    if (check?.name === "Check" && check.ytd != null) printed.netYtd = check.ytd;

    const p = read(right, "panelCurrent", "panelYtd");
    if (p && (p.current != null || p.ytd != null) && !/\b(Hrs|Hours)\b/i.test(p.name)) panel.push(p);
  }
  const fedTaxable = /federal taxable wages this period are \$?(\d[\d ]*\d)/.exec(rows.filter((r) => r.cells.some((c) => c.x0 >= panelLeft)).map((r) => r.cells.filter((c) => c.x0 >= panelLeft).map((c) => c.text).join(" ")).join(" "));
  if (fedTaxable) printed.federalTaxableCurrent = adpCents(fedTaxable[1]!);

  const lines: StubLine[] = [];
  for (const e of earnings) lines.push({ name: e.name, kind: classifyEarning(e.name), current: e.current ?? 0, ytd: e.ytd });
  for (const d of deductions) {
    let kind = classifyDeduction(d.name);
    // "*" = excluded from federal taxable wages: a pre-tax deduction whatever its name.
    if (d.starred && kind === "AFTER_TAX") kind = "SECTION125";
    lines.push({ name: d.name, kind, current: d.current ?? 0, ytd: d.ytd });
  }
  for (const b of panel) {
    // Group-term life over $50k is imputed income, taxed but not part of gross pay.
    if (/GROUP TERM|\bGTL\b/i.test(b.name)) lines.push({ name: `Imputed: ${b.name}`, kind: "IMPUTED", current: b.current ?? 0, ytd: b.ytd });
    else lines.push({ name: b.name, kind: classifyEmployer(b.name), current: b.current ?? 0, ytd: b.ytd });
  }

  const warnings: string[] = [];
  const sum = (pick: "current" | "ytd", kinds: (k: StubLineKind) => boolean) => lines.filter((x) => kinds(x.kind)).reduce((s, x) => s + (x[pick] ?? 0), 0);
  const isEarning = (k: StubLineKind) => k === "REGULAR" || k === "BONUS" || k === "NONTAXABLE" || k === "OTHER_EARNING";
  const isDeduction = (k: StubLineKind) => !isEarning(k) && k !== "IMPUTED" && !k.startsWith("EMPLOYER_");
  const $ = (c: number) => `$${(c / 100).toFixed(2)}`;
  if (printed.federalTaxableCurrent != null && printed.grossCurrent != null) {
    const preTax = sum("current", (k) => k === "RETIREMENT_PRETAX" || k === "HSA" || k === "SECTION125" || k === "DEPENDENT_CARE_FSA");
    const taxable = printed.grossCurrent - sum("current", (k) => k === "NONTAXABLE") - preTax;
    if (taxable !== printed.federalTaxableCurrent) warnings.push(`${payDate}: federal taxable wages work out to ${$(taxable)}, but the stub prints ${$(printed.federalTaxableCurrent)}.`);
  }
  if (printed.grossYtd != null && printed.netYtd != null) {
    const unprinted = printed.grossYtd - sum("ytd", isDeduction) - printed.netYtd;
    if (unprinted > 0) lines.push({ name: "Deductions ADP leaves without a printed YTD (gross YTD − net YTD − printed lines)", kind: "AFTER_TAX", current: 0, ytd: unprinted });
    else if (unprinted < 0) warnings.push(`${payDate}: year-to-date deductions exceed gross minus net by ${$(-unprinted)}.`);
  }

  // The employer's name sits left of "Period Beginning:"; the employee's under "Deposited to the account of".
  const periodRow = rows.find((r) => r.cells.some((c) => /^Period Beginning:/.test(c.text)));
  const periodX = periodRow?.cells.find((c) => /^Period Beginning:/.test(c.text))!.x0 ?? 0;
  const employerCell = periodRow?.cells.filter((c) => c.x0 < periodX).map((c) => c.text).join(" ") || "Employer";
  // The payroll company code sits under the "CO." heading (e.g. ABC, XYZ).
  const coIdx = rows.findIndex((r) => r.cells.some((c) => c.text === "CO."));
  const coCell = coIdx >= 0 ? rows[coIdx]!.cells.find((c) => c.text === "CO.")! : null;
  const payrollCode = coCell ? (rows[coIdx + 1]?.cells.find((c) => c.x0 <= coCell.x1 && c.x1 >= coCell.x0 && /^[A-Z0-9]{2,6}$/.test(c.text))?.text ?? null) : null;
  const isName = (c: LayoutCell) => c.x0 < panelLeft && /^[A-Z][A-Z .'-]+$/.test(c.text);
  const depositIdx = rows.findIndex((r) => r.cells.some((c) => /^Deposited/.test(c.text)));
  const employee = depositIdx >= 0 ? rows.slice(depositIdx + 1).find((r) => r.cells[0] && isName(r.cells[0]))?.cells.filter(isName).map((c) => c.text).join(" ") : undefined;
  if (printed.netCurrent == null) throw new Error(`ADP: net pay not found on the ${payDate} stub`);
  const last4 = /x{3,}(\d{4})/i.exec(pageText)?.[1] ?? null;
  return {
    source: "ADP",
    employee: employee ? collapseSpaces(employee) : "Employee",
    employer: collapseSpaces(employerCell.replace(/\.$/, "").toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())),
    payrollCode,
    payDate,
    periodStart: date(/Period Beginning:\s*(\d{2}\/\d{2}\/\d{4})/),
    periodEnd: date(/Period Ending:\s*(\d{2}\/\d{2}\/\d{4})/),
    federalFilingStatus: /Filing Status:\s*([A-Za-z ]+)/.exec(pageText)?.[1]?.trim() ?? null,
    lines,
    printed: { grossCurrent: printed.grossCurrent, grossYtd: printed.grossYtd, withheldCurrent: null, withheldYtd: null, netCurrent: printed.netCurrent, netYtd: printed.netYtd },
    deposits: [{ last4, amount: printed.netCurrent }],
    warnings,
  };
}
