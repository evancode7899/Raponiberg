/**
 * The pure half of the shared chart pieces (components/charts/interact.tsx): what a compare
 * overlay draws, which points a zoom keeps, where a line's label goes, and the table each
 * chart has for those who read it rather than see it. None of it works out a figure: it
 * moves the points the page already drew.
 */

type Point = Record<string, unknown>;

/**
 * Each point with the value `lag` points before it beside it (`as`), for a dashed "the same
 * time before" line over the chart: a year before is lag 12 on months. Points with nothing
 * that far back get null, so the line starts where the history does.
 */
export function withCompare<T extends Point>(rows: readonly T[], key: keyof T & string, lag: number, as = `${key}Before`): (T & Record<string, number | null>)[] {
  return rows.map((r, i) => {
    const v = i - lag >= 0 ? rows[i - lag]![key] : null;
    return { ...r, [as]: typeof v === "number" ? v : null } as T & Record<string, number | null>;
  });
}

/** The points a zoom keeps: a window [start, end] held inside the data and at least `min` wide. */
export function zoomWindow(count: number, start: number, end: number, min = 2): { start: number; end: number } {
  if (count <= 0) return { start: 0, end: 0 };
  let s = Math.max(0, Math.min(count - 1, Math.round(start)));
  let e = Math.max(0, Math.min(count - 1, Math.round(end)));
  if (e < s) [s, e] = [e, s];
  const width = Math.min(count, min);
  if (e - s + 1 < width) {
    e = Math.min(count - 1, s + width - 1);
    s = Math.max(0, e - width + 1);
  }
  return { start: s, end: e };
}

/** The last point a series has a value at: where its name is written on the line. */
export function lastIndexWith(rows: readonly Point[], key: string): number {
  for (let i = rows.length - 1; i >= 0; i--) if (typeof rows[i]![key] === "number") return i;
  return -1;
}

/** Where to put the names at the ends of several lines so none sits on another: each label's y, nudged apart by at least `gap`. */
export function spreadLabels(ys: readonly number[], gap = 12): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k++) if (order[k]!.y - order[k - 1]!.y < gap) order[k]!.y = order[k - 1]!.y + gap;
  const out = new Array<number>(ys.length);
  for (const o of order) out[o.i] = o.y;
  return out;
}

/**
 * A chart as a table: one row per point, a column per series, the cells as the chart's own
 * tooltip writes them. For a screen reader, and anyone who wants the numbers.
 */
export function chartTable(rows: readonly Point[], x: string, series: readonly { key: string; name: string }[], format: (v: number) => string): { head: string[]; body: string[][] } {
  return {
    head: [x === "label" ? "" : x, ...series.map((s) => s.name)],
    body: rows.map((r) => [String(r[x] ?? ""), ...series.map((s) => (typeof r[s.key] === "number" ? format(r[s.key] as number) : ""))]),
  };
}
