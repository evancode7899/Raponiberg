/** Columns a transaction-style table sorts by: when, how big, and who (merchant, payee, description). */
export type SortKey = "date" | "amount" | "name";
export type Sort = { key: SortKey; desc: boolean };

/** How to read each sortable column off a row; a table only needs the getters for the columns it sorts. */
export type SortGetters<T> = { date: (r: T) => string; amount?: (r: T) => number; name?: (r: T) => string | null | undefined };

/** The first direction a column sorts in: names A→Z, dates newest first, amounts biggest first. */
export const firstDesc = (key: SortKey) => key !== "name";

/**
 * Sorts rows by the chosen column. Amount sorts by size, so a $500 refund and a $500
 * charge sit together; ties fall back to the date, newest first. No sort keeps the order.
 */
export function sortRows<T>(rows: readonly T[], sort: Sort | null, get: SortGetters<T>): T[] {
  if (!sort) return [...rows];
  const dir = sort.desc ? -1 : 1;
  const cmp = (a: T, b: T): number => {
    if (sort.key === "amount" && get.amount) return Math.abs(get.amount(a)) - Math.abs(get.amount(b));
    if (sort.key === "name" && get.name) return (get.name(a) ?? "").localeCompare(get.name(b) ?? "", undefined, { sensitivity: "base", numeric: true });
    return get.date(a).localeCompare(get.date(b));
  };
  return [...rows].sort((a, b) => {
    const c = cmp(a, b);
    return c !== 0 ? c * dir : get.date(b).localeCompare(get.date(a));
  });
}
