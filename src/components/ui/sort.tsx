"use client";

import { table } from "@/components/ui/kit";
import { firstDesc, type Sort, type SortKey } from "@/lib/sortRows";
import { useState } from "react";

export { firstDesc, sortRows, type Sort, type SortGetters, type SortKey } from "@/lib/sortRows";

/**
 * Sort state for a table: newest first to start; a click on the current column flips it,
 * on another starts it in its first direction. Pass `null` to keep the rows' own order
 * (say, marked ones first) until a header is clicked.
 */
export function useSort<S extends Sort | null = Sort>(initial: S = { key: "date", desc: true } as S) {
  const [sort, setSort] = useState<Sort | S>(initial);
  const toggle = (key: SortKey) => setSort((s) => ({ key, desc: s?.key === key ? !s.desc : firstDesc(key) }));
  return { sort, toggle };
}

/** A header cell that sorts its table by `k`. `className` replaces the kit's header style for tables that use their own. */
export function SortTh({
  k,
  label,
  sort,
  toggle,
  right = false,
  className,
}: {
  k: SortKey;
  label: string;
  sort: Sort | null;
  toggle: (k: SortKey) => void;
  right?: boolean;
  className?: string;
}) {
  return (
    <th className={className ?? (right ? table.thR : table.th)} aria-sort={sort?.key === k ? (sort.desc ? "descending" : "ascending") : undefined}>
      <button type="button" className={className ? "hover:text-fg" : "uppercase tracking-wide hover:text-fg"} onClick={() => toggle(k)} title={`Sort by ${label.toLowerCase()}`}>
        {label}
        {sort?.key === k ? (sort.desc ? " ↓" : " ↑") : ""}
      </button>
    </th>
  );
}
