import { isIsoDate } from "../dates/isoDate.ts";
import { guessKind, type ExpenseKind } from "./qualify.ts";
import { excelSerialToIso, readXlsx, type Sheet } from "./xlsx.ts";

/**
 * Turns a receipts log kept in a spreadsheet (.xlsx, .csv, or cells pasted from Excel)
 * into expenses for the HSA page to preview. The columns are found by their headers, not
 * their position: a Date column and an Amount column are required; Reimbursed?,
 * Provider / Notes / Description, Patient / For, Receipt and Kind are used when present.
 * Rows without both a date and an amount (blank rows, a "Total" line, a side calculation
 * further right) are skipped, with the reason.
 */

export type ImportedExpense = {
  /** Spreadsheet row number (1-based), for the preview. */
  line: number;
  date: string;
  amountCents: number;
  provider: string;
  patient: string;
  kind: ExpenseKind;
  notes: string;
  receipt: boolean;
  reimbursed: boolean;
  reimbursedOn: string | null;
};

export type ImportPreview = { sheet: string; expenses: ImportedExpense[]; skipped: { line: number; reason: string }[]; columns: string[] };

type Cell = string | number | null;

const HEADERS: Record<string, RegExp> = {
  date: /^(service |paid |payment |purchase )?date( paid| of service)?$|^when$/i,
  amount: /amount|cost|paid|price|total|out of pocket|oop|\$/i,
  reimbursed: /reimburs|repaid|paid back|claimed/i,
  provider: /provider|merchant|payee|vendor|description|desc|notes?|what|item|memo/i,
  patient: /patient|for whom|^for$|^who$|person|member/i,
  receipt: /receipt|eob|documentation|docs?$/i,
  kind: /kind|type|category/i,
};

function findHeader(rows: Cell[][]): { line: number; cols: Partial<Record<keyof typeof HEADERS, number>> } | null {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const cols: Partial<Record<keyof typeof HEADERS, number>> = {};
    (rows[i] ?? []).forEach((c, j) => {
      if (typeof c !== "string" || !c.trim()) return;
      const t = c.trim();
      // First match wins per column, and "reimbursed" before "amount" ("Amount reimbursed").
      for (const key of ["date", "reimbursed", "patient", "receipt", "kind", "amount", "provider"] as const) {
        if (cols[key] == null && HEADERS[key]!.test(t)) {
          cols[key] = j;
          break;
        }
      }
    });
    if (cols.date != null && cols.amount != null) return { line: i, cols };
  }
  return null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A date cell: an Excel serial, YYYY-MM-DD, M/D/YYYY (or YY), or "Jan 5, 2026". */
export function parseDateCell(v: Cell): string | null {
  if (typeof v === "number") return v > 20_000 && v < 80_000 ? excelSerialToIso(v) : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  let iso: string | null = null;
  if (m) iso = `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s))) {
    const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    iso = `${y}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  } else if ((m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/.exec(s))) {
    const mo = MONTHS.indexOf(m[1]!.toLowerCase());
    if (mo >= 0) iso = `${m[3]}-${String(mo + 1).padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  } else if (/^\d{5}(\.\d+)?$/.test(s)) return parseDateCell(Number(s));
  return iso && isIsoDate(iso) ? iso : null;
}

/** A money cell → positive cents ("$1,234.56", "(22.00)", 805.54). */
export function parseAmountCell(v: Cell): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v !== 0 ? Math.round(Math.abs(v) * 100) : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "$1");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Math.round(Math.abs(Number(s)) * 100);
  return n > 0 ? n : null;
}

/** A yes/no cell: 1, "yes", "y", "x", "✓", TRUE, or a date (reimbursed on that day). */
function parseFlag(v: Cell): { yes: boolean; date: string | null } {
  if (v == null) return { yes: false, date: null };
  if (typeof v === "number") return v > 20_000 ? { yes: true, date: parseDateCell(v) } : { yes: v !== 0, date: null };
  const s = v.trim().toLowerCase();
  const date = parseDateCell(v);
  if (date) return { yes: true, date };
  return { yes: /^(1|y|yes|x|✓|✔|true|done|reimbursed|paid)$/.test(s), date: null };
}

/** The household member a note names ("Robin ER visit" → the member called Robin). */
function findPatient(text: string, names: string[]): string {
  for (const n of names) {
    const first = n.split(/\s+/)[0];
    if (first && first.length > 1 && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) return n;
  }
  return "";
}

export function sheetToExpenses(sheet: Sheet, patientNames: string[] = []): ImportPreview {
  const header = findHeader(sheet.rows);
  if (!header) {
    return { sheet: sheet.name, expenses: [], skipped: [{ line: 0, reason: "No header row with a Date and an Amount column." }], columns: [] };
  }
  const { cols } = header;
  const get = (row: Cell[], k: keyof typeof HEADERS) => (cols[k] == null ? null : (row[cols[k]!] ?? null));
  const expenses: ImportedExpense[] = [];
  const skipped: ImportPreview["skipped"] = [];
  for (let i = header.line + 1; i < sheet.rows.length; i++) {
    const row = sheet.rows[i] ?? [];
    const rawDate = get(row, "date");
    const rawAmount = get(row, "amount");
    const text = String(get(row, "provider") ?? "").trim();
    if (rawDate == null && rawAmount == null && !text) continue;
    if (typeof rawDate === "string" && /total/i.test(rawDate)) continue;
    const date = parseDateCell(rawDate);
    const amountCents = parseAmountCell(rawAmount);
    if (!date || !amountCents) {
      // A row with only a filled-in "Reimbursed?" default (0) is an unused template row.
      if (rawDate == null && rawAmount == null && !text) continue;
      skipped.push({ line: i + 1, reason: !date ? `no date${rawDate != null ? ` ("${rawDate}")` : ""}` : "no amount" });
      continue;
    }
    const flag = parseFlag(get(row, "reimbursed"));
    const patientCell = String(get(row, "patient") ?? "").trim();
    const kindCell = String(get(row, "kind") ?? "").trim();
    const provider = text || "Medical expense";
    expenses.push({
      line: i + 1,
      date,
      amountCents,
      provider,
      patient: patientCell || findPatient(provider, patientNames),
      kind: guessKind(`${kindCell} ${provider}`),
      notes: "",
      receipt: parseFlag(get(row, "receipt")).yes,
      reimbursed: flag.yes,
      reimbursedOn: flag.date,
    });
  }
  const names = Object.entries(cols).map(([k, j]) => `${k}: ${String(sheet.rows[header.line]?.[j!] ?? "").trim()}`);
  return { sheet: sheet.name, expenses, skipped, columns: names };
}

/** CSV or tab-separated text (cells pasted from Excel) → one sheet. */
export function parseDelimited(text: string): Sheet {
  const delim = (text.split(/\r?\n/, 1)[0] ?? "").includes("\t") ? "\t" : ",";
  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let cell = "";
  let quoted = false;
  const push = () => {
    const t = cell.trim();
    row.push(t === "" ? null : t);
    cell = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delim) push();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      push();
      rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell || row.length) {
    push();
    rows.push(row);
  }
  return { name: delim === "\t" ? "Pasted cells" : "CSV", rows };
}

/** Reads an uploaded file (or pasted text) and previews the expenses in it: the first sheet that has a Date and an Amount column. */
/** The workbook's sheets; a truncated or damaged file says so instead of failing on a byte offset. */
function readXlsxOrExplain(bytes: Buffer): Sheet[] {
  try {
    return readXlsx(bytes);
  } catch (e) {
    if (e instanceof RangeError) throw new Error("That file isn't a readable .xlsx (it may be damaged or cut short). Save it again from Excel, or export it as .csv.");
    throw e;
  }
}

export function previewImport(input: { fileName?: string; bytes?: Buffer; text?: string }, patientNames: string[] = []): ImportPreview {
  const isXlsx = input.bytes && (/\.xlsx$/i.test(input.fileName ?? "") || (input.bytes.length >= 4 && input.bytes.readUInt32LE(0) === 0x04034b50));
  const sheets: Sheet[] = isXlsx ? readXlsxOrExplain(input.bytes!) : [parseDelimited(input.text ?? input.bytes?.toString("utf8").replace(/^﻿/, "") ?? "")];
  let best: ImportPreview | null = null;
  for (const s of sheets) {
    const p = sheetToExpenses(s, patientNames);
    if (!best || p.expenses.length > best.expenses.length) best = p;
  }
  if (!best || best.expenses.length === 0) {
    throw new Error(best?.skipped[0]?.line === 0 ? "No sheet has a header row with a Date and an Amount column." : "No expenses found (each needs a date and an amount).");
  }
  return best;
}
