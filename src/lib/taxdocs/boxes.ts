import type { LayoutCell, LayoutRow } from "../statements/pdfLayout.ts";

/**
 * Reads a boxed IRS information return (W-2, 1099-INT, 1099-R, K-1) from positioned text.
 * Each box prints its label and, a line or two away, its amount; the amount belongs to the
 * nearest label above (or, on some layouts, below) whose column it falls in. Forms print
 * several copies (B, C, 2…), so every copy is read and the amount most copies agree on
 * wins.
 */

export type BoxSpec = { id: string; label: RegExp };

export type LabelHit = { id: string; page: number; y: number; x0: number; x1: number; text: string };

/** Amounts with cents ("12345.67", "1,234.56"). */
export const CENTS = /^\$?\s?\(?-?[\d,]*\d\.\d{2}\)?$/;
/** Whole dollars, possibly negative in parentheses ("(12)", "34"). */
export const WHOLE = /^\(?-?[\d,]*\d\)?$/;

export function moneyCents(text: string): number | null {
  const t = text.replace(/[\s$]/g, "");
  const neg = /^\(.*\)$/.test(t) || t.startsWith("-");
  const n = Number(t.replace(/[(),-]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) * (neg ? -1 : 1);
}

/** Every label occurrence. A cell holding several labels is split in proportion to where each starts. */
export function findLabels(rows: LayoutRow[], specs: BoxSpec[]): LabelHit[] {
  const out: LabelHit[] = [];
  for (const row of rows) {
    for (const cell of row.cells) {
      const inCell: { id: string; at: number }[] = [];
      for (const s of specs) {
        const m = s.label.exec(cell.text);
        if (m) inCell.push({ id: s.id, at: m.index });
      }
      inCell.sort((a, b) => a.at - b.at);
      const width = cell.x1 - cell.x0;
      const len = Math.max(1, cell.text.length);
      inCell.forEach((h, i) => {
        const next = inCell[i + 1];
        out.push({
          id: h.id,
          page: row.page,
          y: row.y,
          x0: cell.x0 + (width * h.at) / len,
          x1: next ? cell.x0 + (width * next.at) / len : cell.x1,
          text: cell.text.slice(h.at, next?.at),
        });
      });
    }
  }
  return out;
}

type Opts = { value: RegExp; maxDy?: number; slack?: number; lead?: number };

/**
 * Pairs every amount with its box. An amount belongs to the label nearest above it (or,
 * failing that, nearest below: some layouts print the state line over its labels) whose
 * column it falls in: it ends within `slack` points right of the label, and the label is
 * the nearest one starting left of it on that row. Labels whose ids start with "_" only
 * claim amounts (so a neighbouring box can't take them) and are dropped from the result.
 */
export function assignValues(rows: LayoutRow[], hits: LabelHit[], opts: Opts): Map<LabelHit, LayoutCell[]> {
  const { value, maxDy = 24, slack = 45, lead = 8 } = opts;
  const out = new Map<LabelHit, LayoutCell[]>();
  const byRow = new Map<string, LabelHit[]>();
  for (const h of hits) byRow.set(`${h.page}:${h.y}`, [...(byRow.get(`${h.page}:${h.y}`) ?? []), h]);
  // A label printed narrower than its box ("12a") reaches to where the next label starts.
  const right = new Map<LabelHit, number>();
  for (const row of byRow.values()) {
    const sorted = [...row].sort((a, b) => a.x0 - b.x0);
    sorted.forEach((h, i) => {
      const next = sorted[i + 1];
      right.set(h, h.x1 - h.x0 < 20 ? Math.max(h.x1 + slack, next ? next.x0 - 4 : h.x1 + 80) : h.x1 + slack);
    });
  }
  const fits = (h: LabelHit, c: LayoutCell) => {
    if (c.x0 < h.x0 - lead || c.x1 > right.get(h)!) return false;
    const owner = byRow.get(`${h.page}:${h.y}`)!.filter((o) => o.x0 <= c.x0 + lead).sort((a, b) => b.x0 - a.x0)[0];
    return owner === h;
  };
  for (const r of rows) {
    for (const c of r.cells) {
      if (!value.test(c.text.replace(/[\s$]+/g, ""))) continue;
      const near = hits.filter((h) => h.page === r.page && h.y !== r.y && Math.abs(h.y - r.y) <= maxDy && fits(h, c));
      const above = near.filter((h) => h.y > r.y).sort((a, b) => a.y - b.y)[0];
      const below = near.filter((h) => h.y < r.y).sort((a, b) => b.y - a.y)[0];
      // The label right above wins; a distant one above loses to a close one below.
      const h = above && (!below || above.y - r.y <= 18 || above.y - r.y <= r.y - below.y) ? above : below;
      if (h) out.set(h, [...(out.get(h) ?? []), c]);
    }
  }
  return out;
}

/** The value most copies agree on (the first seen on a tie). */
export function mode<T>(values: T[]): T | null {
  const counts = new Map<string, { v: T; n: number; first: number }>();
  values.forEach((v, i) => {
    const k = JSON.stringify(v);
    const c = counts.get(k);
    if (c) c.n++;
    else counts.set(k, { v, n: 1, first: i });
  });
  const best = [...counts.values()].sort((a, b) => b.n - a.n || a.first - b.first)[0];
  return best ? best.v : null;
}

/** Each box's amount in cents, voted across copies; boxes never found are absent. */
export function readBoxes(rows: LayoutRow[], specs: BoxSpec[], opts: Opts): Record<string, number> {
  const hits = findLabels(rows, specs);
  const assigned = assignValues(rows, hits, opts);
  const seen = new Map<string, number[]>();
  for (const [h, cells] of assigned) {
    if (h.id.startsWith("_")) continue;
    // A box's own amount is the one closest to its label's right edge.
    const c = [...cells].sort((a, b) => Math.abs(a.x1 - h.x1) - Math.abs(b.x1 - h.x1))[0]!;
    const cents = moneyCents(c.text);
    if (cents != null) seen.set(h.id, [...(seen.get(h.id) ?? []), cents]);
  }
  return Object.fromEntries([...seen].map(([id, vs]) => [id, mode(vs)!]));
}
