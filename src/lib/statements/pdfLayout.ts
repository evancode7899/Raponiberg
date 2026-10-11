/**
 * Positioned PDF text for layouts whose plain text is unusable (ADP prints label, current
 * and year-to-date as separate text runs in an order unrelated to the rows they belong
 * to). Text items are grouped into rows by baseline, and runs of nearby items are merged
 * into cells that keep their horizontal extent, so a parser can assign each amount to the
 * column header it sits under.
 *
 * Rendered as a plain-text block appended to the document text, so it flows through the
 * same text-only parser and fingerprint paths as every other statement:
 *
 *   [pdf-layout]
 *   @1:587	21-53 Regular	110-145 3446 54	216-256 3 446 54
 */

export const LAYOUT_HEADER = "[pdf-layout]";

export type LayoutCell = { x0: number; x1: number; text: string };
export type LayoutRow = { page: number; y: number; cells: LayoutCell[] };
export type PositionedItem = { page: number; x: number; y: number; width: number; str: string };

/** Items closer than this (in points) are one cell: ADP splits "3 446 54" into three runs ~5pt apart. */
const MERGE_GAP = 8;
/** Baselines within this distance are the same row. */
const ROW_TOLERANCE = 2;

export function rowsFromItems(items: PositionedItem[]): LayoutRow[] {
  const sorted = items
    .filter((i) => i.str.trim())
    .map((i) => ({ ...i, x: Math.round(i.x), y: Math.round(i.y), x1: Math.round(i.x + i.width) }))
    .sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const rows: { page: number; y: number; items: typeof sorted }[] = [];
  for (const it of sorted) {
    const row = rows.find((r) => r.page === it.page && Math.abs(r.y - it.y) <= ROW_TOLERANCE);
    if (row) row.items.push(it);
    else rows.push({ page: it.page, y: it.y, items: [it] });
  }
  return rows
    .sort((a, b) => a.page - b.page || b.y - a.y)
    .map((r) => {
      const cells: LayoutCell[] = [];
      for (const it of r.items.sort((a, b) => a.x - b.x)) {
        const last = cells.at(-1);
        if (last && it.x - last.x1 <= MERGE_GAP) {
          last.text = `${last.text} ${it.str.trim()}`;
          last.x1 = Math.max(last.x1, it.x1);
        } else cells.push({ x0: it.x, x1: it.x1, text: it.str.trim() });
      }
      return { page: r.page, y: r.y, cells: cells.map((c) => ({ ...c, text: c.text.replace(/\s+/g, " ") })) };
    });
}

export function renderLayout(rows: LayoutRow[]): string {
  const body = rows.map((r) => `@${r.page}:${r.y}\t${r.cells.map((c) => `${c.x0}-${c.x1} ${c.text}`).join("\t")}`);
  return [LAYOUT_HEADER, ...body].join("\n");
}

/** The rows of a layout block inside document text; empty when the text has none. */
export function parseLayout(text: string): LayoutRow[] {
  const start = text.indexOf(LAYOUT_HEADER);
  if (start < 0) return [];
  const rows: LayoutRow[] = [];
  for (const line of text.slice(start + LAYOUT_HEADER.length).split(/\r?\n/)) {
    const m = /^@(\d+):(-?\d+)\t(.*)$/.exec(line);
    if (!m) continue;
    const cells = m[3]!.split("\t").flatMap((c) => {
      const cm = /^(-?\d+)-(-?\d+) (.+)$/.exec(c);
      return cm ? [{ x0: Number(cm[1]), x1: Number(cm[2]), text: cm[3]! }] : [];
    });
    rows.push({ page: Number(m[1]), y: Number(m[2]), cells });
  }
  return rows;
}
