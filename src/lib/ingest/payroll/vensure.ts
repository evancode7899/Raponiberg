import { collapseSpaces, lines, parseMoney, parseSlashDate } from "../text.ts";
import { classifyDeduction, classifyEarning, classifyEmployer } from "./classify.ts";
import { CASH_EARNING_KINDS, type PayStubFacts, type StubLine } from "./types.ts";

/**
 * Vensure's text layer prints each table column-wise: a run of row names followed by a
 * run of current amounts and then a run of year-to-date amounts. A voucher spans two
 * pages (the second continues the employer-contribution table); a PDF often holds many
 * vouchers, and repeats some.
 *
 * Printed totals used to check each voucher: the deductions/taxes pair (YTD, current)
 * right under the earnings, "Gross Earnings $x" (this period's cash pay), the YTD gross
 * (which includes imputed group-term life), total net pay YTD and the deposit lines.
 */

const VALUE_LINE = /^(-|-?[\d,]+\.\d{2})$/;
const PAIR_LINE = /^([\d,]+\.\d{2})\s+([\d,]+\.\d{2})$/;
const value = (l: string) => (l === "-" ? null : parseMoney(l));

export function extractVensureStubs(text: string): PayStubFacts[] {
  const ls = lines(text);
  const pages: string[][] = [];
  for (let i = 0; i < ls.length; i++) {
    if (ls[i] === "TOTAL" && ls[i + 1] === "TOTAL") pages.push([]);
    pages.at(-1)?.push(ls[i]!);
  }
  const vouchers = new Map<string, string[][]>();
  for (const p of pages) {
    const v = p.find((l) => /^Voucher #:/.test(l));
    const key = v ? /Voucher #:\s*(\S+)/.exec(v)![1]! : `page${vouchers.size}`;
    vouchers.set(key, [...(vouchers.get(key) ?? []), p]);
  }
  const out: PayStubFacts[] = [];
  const seen = new Set<string>();
  for (const pagesOfVoucher of vouchers.values()) {
    const stub = parseVoucher(pagesOfVoucher);
    if (!stub) continue;
    const key = `${stub.payDate}|${stub.printed.netCurrent}|${stub.printed.netYtd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(stub);
  }
  return out;
}

/** Names then values starting at `start`; returns the parsed run and where it ended. */
function namesThenValues(ls: string[], start: number): { names: string[]; values: (number | null)[]; end: number } {
  const names: string[] = [];
  let i = start;
  while (i < ls.length && !VALUE_LINE.test(ls[i]!) && !PAIR_LINE.test(ls[i]!)) names.push(ls[i++]!);
  const values: (number | null)[] = [];
  while (i < ls.length && VALUE_LINE.test(ls[i]!)) values.push(value(ls[i++]!));
  return { names, values, end: i };
}

/** Pair names with current/YTD runs; a short run means the current column was left blank. */
function pairRuns(names: string[], values: (number | null)[], hasCurrent: boolean) {
  const n = names.length;
  const ytd = values.slice(-n);
  const current = hasCurrent && values.length >= 2 * n ? values.slice(0, n) : [];
  return names.map((name, i) => ({ name: collapseSpaces(name), current: current[i] ?? null, ytd: ytd[i] ?? null }));
}

/**
 * A one-row table prints its name and amount on one line ("REGULAR PAY 5000.00"), and
 * the current-earnings row can run into the first deduction's name ("06-15-2025 REGULAR
 * PAY 5000.00 FEDERAL TAX"). Split such lines into the name/value runs the multi-row
 * layout uses.
 */
function splitInline(ls: string[]): string[] {
  return ls.flatMap((l) => {
    if (!/[A-Za-z]/.test(l) || !/\d\.\d{2}\b/.test(l) || /^(Gross Earnings|Voucher|CHECKING|SAVINGS)\b/i.test(l)) return [l];
    const parts = l
      .replace(/^\d{2}-\d{2}-\d{4}\s+/, "")
      .split(/\s+(-?[\d,]+\.\d{2})(?=\s|$)/)
      .map((p) => p.trim())
      .filter(Boolean);
    return parts.length > 1 ? parts : [l];
  });
}

function parseVoucher(pages: string[][]): PayStubFacts | null {
  const raw1 = pages[0]!;
  const p1 = splitInline(raw1);
  const dates = p1.filter((l) => /\d{2}-\d{2}-\d{4}$/.test(l)).map((l) => parseSlashDate(l.split(" ").at(-1)!)!);
  if (dates.length < 3) return null;
  const employerLine = p1.find((l) => / - .* -/.test(l) && /\b(LP|LLC|INC|CORP|LTD)\b/.test(l)) ?? "";
  const filing = p1.find((l) => /^[A-Z]{1,3}\/(Married|Single|Head)/i.test(l));
  const warnings: string[] = [];

  const out: StubLine[] = [];
  let withheldYtd: number | null = null;
  let withheldCurrent: number | null = null;
  const ytdHeader = p1.findIndex((l) => /^Description\s+YTD$/.test(l));
  if (ytdHeader >= 0) {
    const run = namesThenValues(p1, ytdHeader + 1);
    for (const r of pairRuns(run.names, run.values, false)) out.push({ ...r, kind: classifyEarning(r.name) });
    const pair = PAIR_LINE.exec(p1[run.end] ?? "");
    if (pair) {
      withheldYtd = parseMoney(pair[1]!);
      withheldCurrent = parseMoney(pair[2]!);
    }
  }
  // Current earnings and the deductions/taxes table sit between "Pay Method" and the
  // column-header line; leading date/dash cells belong to the earnings date column.
  const pm = p1.findIndex((l) => /^Pay Method:/.test(l));
  const hdr = p1.findIndex((l) => /^Date\s+Pay Description/.test(l));
  if (pm >= 0 && hdr > pm) {
    let i = pm + 1;
    while (i < hdr && (/^\d{2}-\d{2}-\d{4}$/.test(p1[i]!) || p1[i] === "-")) i++;
    const earnings = namesThenValues(p1, i);
    // This run has a single (current) column, which pairRuns returns as `ytd`.
    for (const e of pairRuns(earnings.names, earnings.values, false)) {
      const line = out.find((o) => o.name === e.name);
      if (line) line.current = e.ytd;
      else out.push({ name: e.name, kind: classifyEarning(e.name), current: e.ytd, ytd: null });
    }
    const deductions = namesThenValues(p1, earnings.end);
    for (const d of pairRuns(deductions.names, deductions.values, true)) out.push({ ...d, kind: classifyDeduction(d.name) });
  } else warnings.push("Current earnings and deductions table not found.");
  for (const page of pages) {
    const h = page.findIndex((l) => /^Description\s+Balance\s+Description\s+Amount\s+YTD$/.test(l));
    if (h < 0) continue;
    const run = namesThenValues(page, h + 1);
    for (const r of pairRuns(run.names, run.values, true)) out.push({ ...r, kind: classifyEmployer(r.name) });
  }
  for (const l of out) if (l.current == null && CASH_EARNING_KINDS.has(l.kind)) l.current = 0;

  const deposits: PayStubFacts["deposits"] = [];
  let lastDeposit = -1;
  p1.forEach((l, i) => {
    const m = /^(CHECKING|SAVINGS)\s+(\d+)\s+([\d,]+\.\d{2})$/i.exec(l);
    if (m) {
      deposits.push({ last4: m[2]!.slice(-4), amount: parseMoney(m[3]!)! });
      lastDeposit = i;
    }
  });
  // After the deposit lines: "$<total deposited>", "$<gross YTD incl. imputed>".
  const dollars = (from: number) => p1.slice(from).filter((l) => /^\$[\d,]+\.\d{2}$/.test(l)).map((l) => parseMoney(l)!);
  const afterDeposits = lastDeposit >= 0 ? dollars(lastDeposit + 1) : [];
  const typeAmount = p1.findIndex((l, i) => i > lastDeposit && /^Type\s+Amount$/.test(l));
  const netYtd = typeAmount >= 0 ? (dollars(typeAmount + 1)[0] ?? null) : null;
  const imputedYtd = out.filter((l) => l.kind === "IMPUTED").reduce((t, l) => t + (l.ytd ?? 0), 0);
  const grossYtdPrinted = afterDeposits[1] ?? null;
  const grossCurrent = parseMoney(/^Gross Earnings (\$[\d,]+\.\d{2})/m.exec(p1.join("\n"))?.[1] ?? "");
  const netCurrent = deposits.length ? deposits.reduce((t, d) => t + d.amount, 0) : (afterDeposits[0] ?? null);
  if (netCurrent == null) throw new Error(`Vensure: net pay not found on the ${dates[2]} voucher`);

  return {
    source: "VENSURE",
    employee: collapseSpaces(employerLine.replace(/^.* -\s*/, "")) || "Employee",
    employer: collapseSpaces(employerLine.split(" - ")[0] ?? "Employer"),
    payDate: dates[2]!,
    periodStart: dates[0]!,
    periodEnd: dates[1]!,
    federalFilingStatus: filing ? filing.split("/")[1]!.trim() : null,
    lines: out,
    printed: {
      grossCurrent,
      // Vensure's YTD gross includes imputed group-term life, which is never paid in cash.
      grossYtd: grossYtdPrinted != null ? grossYtdPrinted - imputedYtd : null,
      withheldCurrent,
      withheldYtd,
      netCurrent,
      netYtd,
    },
    deposits,
    warnings,
  };
}
