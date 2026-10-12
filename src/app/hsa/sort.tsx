"use client";

import { table } from "@/components/ui/kit";
import { useState } from "react";

/** Columns the HSA tables sort by. */
export type SortKey = "date" | "amount";
export type Sort = { key: SortKey; desc: boolean };

/** Sort state for a table: newest first to start; a click on the current column flips it, on another starts it descending. */
export function useSort(initial: Sort = { key: "date", desc: true }) {
  const [sort, setSort] = useState<Sort>(initial);
  const toggle = (key: SortKey) => setSort((s) => ({ key, desc: s.key === key ? !s.desc : true }));
  return { sort, toggle };
}

/** Sorts rows with a date and a positive amount by the chosen column; ties fall back to the date, newest first. */
export function sortRows<T extends { date: string; amountCents: number }>(rows: T[], sort: Sort): T[] {
  const dir = sort.desc ? -1 : 1;
  return [...rows].sort((a, b) => {
    const c = sort.key === "amount" ? a.amountCents - b.amountCents : a.date.localeCompare(b.date);
    return c !== 0 ? c * dir : b.date.localeCompare(a.date);
  });
}

/** A header cell that sorts its table by `k`. */
export function SortTh({ k, label, sort, toggle, right = false }: { k: SortKey; label: string; sort: Sort; toggle: (k: SortKey) => void; right?: boolean }) {
  return (
    <th className={right ? table.thR : table.th} aria-sort={sort.key === k ? (sort.desc ? "descending" : "ascending") : undefined}>
      <button type="button" className="uppercase tracking-wide hover:text-fg" onClick={() => toggle(k)} title={`Sort by ${label.toLowerCase()}`}>
        {label}
        {sort.key === k ? (sort.desc ? " ↓" : " ↑") : ""}
      </button>
    </th>
  );
}
