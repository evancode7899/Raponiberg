import { csvRow } from "./csv.ts";

/**
 * The pure half of the shared table (components/ui/DataTable.tsx): which rows a filter keeps,
 * their order, which rows are drawn while scrolling a long list, and the CSV a copy writes.
 * No figure is worked out here: a table shows and copies what its page already drew.
 */

/** What a cell copies and filters by: the words or number as the page draws it. */
export type CellText<R> = (r: R) => string;

/** How a column sorts: a number, words, or a date (YYYY-MM-DD sorts as words). Null sorts last. */
export type SortValue = string | number | null | undefined;

export type TableSort = { key: string; desc: boolean };

/** Keeps the rows whose text holds every word typed (any order, any case). */
export function filterRows<R>(rows: readonly R[], query: string, texts: readonly CellText<R>[]): R[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...rows];
  return rows.filter((r) => {
    const hay = texts.map((t) => t(r)).join(" \u0000 ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Rows in a column's order; ties keep the order they came in (the page's own), and missing values sit at the end either way. */
export function sortByValue<R>(rows: readonly R[], sort: TableSort | null, value: ((r: R) => SortValue) | undefined): R[] {
  if (!sort || !value) return [...rows];
  const dir = sort.desc ? -1 : 1;
  return rows
    .map((r, i) => ({ r, i, v: value(r) }))
    .sort((a, b) => {
      const an = a.v == null || a.v === "";
      const bn = b.v == null || b.v === "";
      if (an || bn) return an === bn ? a.i - b.i : an ? 1 : -1;
      const c = typeof a.v === "number" && typeof b.v === "number" ? a.v - b.v : String(a.v).localeCompare(String(b.v), undefined, { numeric: true, sensitivity: "base" });
      return c !== 0 ? c * dir : a.i - b.i;
    })
    .map((x) => x.r);
}

/** Numbers and dates start biggest and newest first; words start A to Z. */
export function firstDirection(sample: SortValue): boolean {
  return typeof sample === "number" || (typeof sample === "string" && /^\d{4}-\d{2}(-\d{2})?/.test(sample));
}

/**
 * The rows to draw for a scroll position: those in view and a few either side, with the
 * room the rest take above and below (so the scroll bar stays true to the whole list).
 */
export function visibleWindow(count: number, rowHeight: number, scrollTop: number, viewHeight: number, overscan = 12): { start: number; end: number; padTop: number; padBottom: number } {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const span = Math.ceil(Math.max(viewHeight, rowHeight) / rowHeight);
  // Scrolled past the end (the list just got shorter): the last rows are in view.
  const first = Math.min(Math.floor(Math.max(0, scrollTop) / rowHeight), Math.max(0, count - span));
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + span + overscan);
  return { start, end, padTop: start * rowHeight, padBottom: (count - end) * rowHeight };
}

/** The CSV of the rows shown: a header of the column names, then each row's cells as the page draws them. */
export function tableCsv<R>(rows: readonly R[], columns: readonly { label: string; text: CellText<R> }[]): string {
  return [csvRow(columns.map((c) => c.label)), ...rows.map((r) => csvRow(columns.map((c) => c.text(r))))].join("\r\n") + "\r\n";
}
