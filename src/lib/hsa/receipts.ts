import { daysBetween, isIsoDate } from "../dates/isoDate.ts";

/**
 * Receipts saved in the HSA receipts folder (HSA_RECEIPTS_DIR), matched to the logged
 * expenses they prove. Pure: receiptScan.ts reads the folder and hands each file's facts
 * here, so the matching is tested without files.
 *
 * A file is named by its date ("2025.10.3.pdf"). Text PDFs (insurer EOBs, hospital
 * receipts) are read for their dollar amounts and the dates printed just before each one
 * (an EOB puts the service date ahead of the "you owe" figure). Photos and scanned PDFs
 * have no text, so only their file-name date is known.
 */

/**
 * Bumped when what's read out of a file changes, so every file is read again on the next
 * scan. Kept here (not in receiptScan.ts) so the report can load without the PDF libraries.
 */
export const RECEIPT_READER_VERSION = 1;

export type ReceiptFileFacts = {
  /** Path inside the folder, forward slashes. */
  file: string;
  /** The date in the file's name, or null when it has none. */
  date: string | null;
  /** Text was read out of it (false: a photo or a scan). */
  readable: boolean;
  /** Each dollar amount printed in it (cents, as a string key) → the date printed closest before it, each place it appears. */
  amounts: Record<string, string[]>;
};

/**
 * LINKED: the owner tied the file to the expense (its receipt location names it).
 * AMOUNT: the receipt prints the expense's exact amount next to a date that fits it, so it
 * proves the expense. DATE: a photo or scan dated within a few days of the expense; it's
 * probably the receipt, but nothing in it could be read to be sure, so it waits for the
 * owner to tie it.
 */
export type ReceiptMatch = { file: string; how: "LINKED" | "AMOUNT" | "DATE"; date: string | null };

const HOW_ORDER: Record<ReceiptMatch["how"], number> = { LINKED: 0, AMOUNT: 1, DATE: 2 };

/** The match proves the expense has its receipt on file (a DATE match only suggests it). */
export const onFile = (m: ReceiptMatch) => m.how !== "DATE";

/** The folder file a receipt location names (its path inside the folder, or just its name), if any. */
export function linkedFile(receiptRef: string, files: ReceiptFileFacts[]): ReceiptFileFacts | undefined {
  const ref = receiptRef.trim().replace(/\\/g, "/").toLowerCase();
  if (!ref) return undefined;
  return files.find((f) => f.file.toLowerCase() === ref) ?? files.find((f) => ref.endsWith(`/${f.file.toLowerCase()}`) || f.file.split("/").pop()!.toLowerCase() === ref);
}

/** A receipt may be dated up to this many days before the expense (the bill is paid months after the EOB)… */
const DAYS_BEFORE = 200;
/** …but a round-dollar amount (a $40 copay) turns up on every EOB, so it needs a date this close. */
const ROUND_DAYS_BEFORE = 60;
/** …or this many after (an EOB issued after the visit the expense is dated by). */
const DAYS_AFTER = 14;
/** A photo or scan this close to the expense's date is offered as its receipt. */
const DATE_ONLY_DAYS = 3;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** How far before an amount a date still counts as its date (an EOB line runs a few hundred characters). */
const NEAR_CHARS = 300;

const iso = (y: number, m: number, d: number): string | null => {
  const s = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isIsoDate(s) ? s : null;
};

/** The date in a receipt's file name: "2025.10.3.pdf", "2025-10-03 eob.pdf". */
export function receiptFileDate(name: string): string | null {
  const m = /(?:^|[^\d])(20\d{2})[.\-_ ](\d{1,2})[.\-_ ](\d{1,2})(?!\d)/.exec(name.split("/").pop() ?? name);
  return m ? iso(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

/** Every date printed in the text, with where it sits: 10/3/2025, 10/3/25, Oct 3, 2025, October 3 2025. */
function textDates(text: string): { at: number; date: string }[] {
  const out: { at: number; date: string }[] = [];
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/g)) {
    const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = iso(y, Number(m[1]), Number(m[2]));
    if (d) out.push({ at: m.index, date: d });
  }
  for (const m of text.matchAll(/\b([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})\b/g)) {
    const mon = MONTHS.indexOf(m[1]!.toLowerCase());
    const d = mon >= 0 ? iso(Number(m[3]), mon + 1, Number(m[2])) : null;
    if (d) out.push({ at: m.index, date: d });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * The amounts in a receipt's text, each with the date printed closest before it (within
 * NEAR_CHARS). Only the closest: an EOB's summary reads "services between Jan 24 and
 * Oct 3 … you owe $40", and the $40 belongs to the visit, not to the period's first day.
 */
export function receiptAmounts(text: string): Record<string, string[]> {
  const dates = textDates(text);
  const out: Record<string, Set<string>> = {};
  for (const m of text.matchAll(/(?<![\d.])(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})(?![\d])/g)) {
    const cents = Number(m[1]!.replace(/,/g, "")) * 100 + Number(m[2]);
    if (!cents) continue;
    const set = (out[String(cents)] ??= new Set());
    const before = dates.filter((d) => d.at < m.index).pop();
    if (before && before.at >= m.index - NEAR_CHARS) set.add(before.date);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]));
}

/** A file's facts from its name and its text (null: no text could be read). */
export function receiptFacts(file: string, text: string | null): ReceiptFileFacts {
  const readable = text != null && /\d\.\d{2}/.test(text);
  return { file, date: receiptFileDate(file), readable, amounts: readable ? receiptAmounts(text) : {} };
}

/** Receipt dated `d` fits an expense of `cents` dated `expense` (see DAYS_BEFORE / DAYS_AFTER). */
const fits = (d: string, expense: string, cents: number) => {
  const gap = daysBetween(d, expense);
  return gap <= (cents % 100 === 0 ? ROUND_DAYS_BEFORE : DAYS_BEFORE) && gap >= -DAYS_AFTER;
};

/**
 * The receipts each expense has in the folder, the owner's tie first, then proven ones
 * (AMOUNT). One receipt can back several expenses (an EOB lists every visit of a quarter).
 */
export function matchReceipts(expenses: { id: string; date: string; amountCents: number; receiptRef?: string }[], files: ReceiptFileFacts[]): Map<string, ReceiptMatch[]> {
  const out = new Map<string, ReceiptMatch[]>();
  // A photo dated the very day of an expense is that expense's, not its neighbours'.
  const exactDay = new Set(expenses.map((e) => e.date));
  for (const e of expenses) {
    const found: ReceiptMatch[] = [];
    const linked = e.receiptRef ? linkedFile(e.receiptRef, files) : undefined;
    if (linked) found.push({ file: linked.file, how: "LINKED", date: linked.date });
    for (const f of files) {
      if (f === linked) continue;
      if (f.readable) {
        const near = f.amounts[String(e.amountCents)];
        if (!near) continue;
        // The file-name date stands in only when the amount is printed with no date before it.
        const dates = (near.length ? near : f.date ? [f.date] : []).filter((d) => fits(d, e.date, e.amountCents));
        if (!dates.length) continue;
        // The date closest to the expense is the one shown as evidence.
        dates.sort((a, b) => Math.abs(daysBetween(a, e.date)) - Math.abs(daysBetween(b, e.date)));
        found.push({ file: f.file, how: "AMOUNT", date: dates[0]! });
      } else if (f.date && (exactDay.has(f.date) ? f.date === e.date : Math.abs(daysBetween(f.date, e.date)) <= DATE_ONLY_DAYS)) {
        found.push({ file: f.file, how: "DATE", date: f.date });
      }
    }
    found.sort((a, b) => HOW_ORDER[a.how] - HOW_ORDER[b.how] || a.file.localeCompare(b.file));
    if (found.length) out.set(e.id, found);
  }
  return out;
}
