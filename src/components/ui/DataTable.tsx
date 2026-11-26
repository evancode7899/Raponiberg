"use client";

import { btn, inputCls, table as tableCls } from "@/components/ui/kit";
import { notify } from "@/components/ui/Feedback";
import { COPY_TABLE_EVENT } from "@/components/shell/keyBindings";
import { DataStampContext, SweepContext, type ProofRef } from "@/components/ui/proof/context";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { clearanceOf, isNoFigure, type SweepState } from "@/lib/book/proof/clearance";
import type { BlockerRef } from "@/lib/book/reports/blockerRef";
import { dateLabel } from "@/lib/dates/display";
import { EM_DASH, NA } from "@/lib/formatMoney";
import { filterRows, firstDirection, sortByValue, tableCsv, visibleWindow, type SortValue, type TableSort } from "@/lib/table";
import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type { TableSort } from "@/lib/table";

type Figure = { text: string; proof: ProofRef; blockers?: readonly BlockerRef[] };

export type Column<R> = {
  id: string;
  label: string;
  /** What the column means, on hover over its head. */
  help?: string;
  align?: "left" | "right";
  /** Off until picked under Columns. */
  optional?: boolean;
  /** Always shown: the Columns picker leaves it alone. */
  fixed?: boolean;
  /** What the cell draws, when more than its text (a badge, a control). */
  cell?: (r: R) => ReactNode;
  /** The words a reader sees in the cell: Copy and Filter use them. */
  text?: (r: R) => string;
  /** A figure: drawn as its ProofValue, copied as drawn (n.a. while it's withheld, a dash for zero). */
  figure?: (r: R) => Figure;
  /** A day (YYYY-MM-DD): drawn as Jun 30, 2026, sorted by day, copied as the day. */
  date?: (r: R) => string | null | undefined;
  /** How it sorts; a column with no way to sort doesn't. Dates sort by day without one. */
  sort?: (r: R) => SortValue;
  className?: string;
  thClassName?: string;
};

const PREFS = "pf-table:";
/** The render audit reads every row a list can draw (scripts/render-audit.ts sets it). */
const DRAW_EVERY_ROW = "pf-draw-every-row";

function readPicked(id: string): Record<string, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS + id) ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/** A figure's text as the page draws it right now: the number once cleared (or while the sweep checks), otherwise n.a., or a dash for nothing at all. */
export function drawnText(f: Figure, sweep: SweepState, stamp: string | null): string {
  if (isNoFigure(f.proof)) return f.proof.zero === true ? EM_DASH : NA;
  const c = clearanceOf(f.proof, sweep, stamp, f.blockers ?? []);
  return c.state === "withheld" ? NA : f.text;
}

/**
 * The shared table: sort by a column's head, filter by words, pick columns, copy what's shown
 * as CSV, pick rows for a bulk change, and move through rows with J and K (Enter opens one).
 * Long lists draw only the rows in view. Pages hand it their rows and how each column reads
 * one; it adds no figure of its own, and a copy holds exactly what the page draws.
 */
export function DataTable<R>({
  id,
  label,
  rows,
  columns,
  rowKey,
  sort: controlled,
  onSort,
  defaultSort = null,
  filter = true,
  filterPlaceholder = "Filter these rows…",
  maxHeight,
  virtualize = 400,
  rowHeight = 32,
  select,
  onOpen,
  rowClassName,
  toolbar,
  empty,
  footer,
}: {
  /** Remembers the columns picked, per table. */
  id: string;
  /** Says what the rows are: the table's name to a screen reader, and the CSV file's. */
  label: string;
  rows: readonly R[];
  columns: readonly Column<R>[];
  rowKey: (r: R) => string;
  /** A list the server sorts (one page of many): the order shown, and what a head asks for. */
  sort?: TableSort | null;
  onSort?: (key: string) => void;
  defaultSort?: TableSort | null;
  filter?: boolean;
  filterPlaceholder?: string;
  maxHeight?: string;
  /** Draw only the rows in view past this many rows (false: always all). */
  virtualize?: number | false;
  /** About how tall a row is, until one is measured. */
  rowHeight?: number;
  /** Rows can be picked; `actions` acts on the picked ones (clear() unpicks them). */
  select?: { actions: (picked: R[], clear: () => void) => ReactNode };
  onOpen?: (r: R) => void;
  rowClassName?: (r: R) => string;
  toolbar?: ReactNode;
  empty?: ReactNode;
  footer?: ReactNode;
}) {
  const sweep = useContext(SweepContext);
  const stamp = useContext(DataStampContext);
  const captionId = useId();
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [localSort, setLocalSort] = useState<TableSort | null>(defaultSort);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const [everyRow, setEveryRow] = useState(false);
  useEffect(() => {
    // Read after mount: the server render can't see this browser's storage.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPicked(readPicked(id));
    try {
      setEveryRow(sessionStorage.getItem(DRAW_EVERY_ROW) === "1");
    } catch {
      /* storage unavailable */
    }
  }, [id]);

  const shownCols = useMemo(() => columns.filter((c) => c.fixed || (picked[c.id] ?? !c.optional)), [columns, picked]);
  const textOf = useCallback(
    (c: Column<R>) =>
      (r: R): string => {
        if (c.figure) return drawnText(c.figure(r), sweep, stamp);
        if (c.text) return c.text(r);
        if (c.date) return c.date(r) ?? "";
        return "";
      },
    [sweep, stamp],
  );
  const sortOf = (c: Column<R> | undefined) => c && (c.sort ?? (c.date ? (r: R) => c.date!(r) ?? null : undefined));

  const sort = controlled !== undefined ? controlled : localSort;
  const filtered = useMemo(() => (filter && query ? filterRows(rows, query, shownCols.map(textOf)) : [...rows]), [rows, query, filter, shownCols, textOf]);
  const ordered = useMemo(() => (onSort ? filtered : sortByValue(filtered, sort, sortOf(columns.find((c) => c.id === sort?.key)))), [filtered, sort, onSort, columns]); // eslint-disable-line react-hooks/exhaustive-deps -- sortOf reads only `columns`
  const toggleSort = (c: Column<R>) => {
    if (onSort) return onSort(c.id);
    setLocalSort((s) => (s?.key === c.id ? { key: c.id, desc: !s.desc } : { key: c.id, desc: firstDirection(sortOf(c)?.(rows[0]!) ?? null) }));
  };

  const pick = (colId: string, on: boolean) => {
    setPicked((p) => {
      const next = { ...p, [colId]: on };
      try {
        localStorage.setItem(PREFS + id, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  };

  const copy = async (download: boolean) => {
    const csv = tableCsv(ordered, shownCols.map((c) => ({ label: c.label, text: textOf(c) })));
    if (download) {
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "table"}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return notify(`Saved ${ordered.length.toLocaleString()} row${ordered.length === 1 ? "" : "s"} as CSV.`);
    }
    try {
      await navigator.clipboard.writeText(csv);
      notify(`Copied ${ordered.length.toLocaleString()} row${ordered.length === 1 ? "" : "s"} as CSV: amounts as the page shows them.`);
    } catch {
      notify("The browser didn't allow copying. Use Save CSV instead.", { tone: "bad" });
    }
  };

  // C on the table (components/shell/KeyMap.tsx) copies every row it holds, not just those drawn.
  const wrap = useRef<HTMLDivElement>(null);
  const copyRef = useRef(copy);
  useEffect(() => {
    copyRef.current = copy;
  });
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onCopy = () => void copyRef.current(false);
    el.addEventListener(COPY_TABLE_EVENT, onCopy);
    return () => el.removeEventListener(COPY_TABLE_EVENT, onCopy);
  }, []);

  // ---- drawing only the rows in view
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 800 });
  const [measured, setMeasured] = useState(rowHeight);
  const windowed = virtualize !== false && !everyRow && ordered.length > virtualize;
  useEffect(() => {
    const el = scroller.current;
    if (!windowed || !el) return;
    const read = () => setView({ top: el.scrollTop, height: el.clientHeight });
    read();
    el.addEventListener("scroll", read, { passive: true });
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", read);
      ro.disconnect();
    };
  }, [windowed]);
  const win = windowed ? visibleWindow(ordered.length, measured, view.top, view.height) : { start: 0, end: ordered.length, padTop: 0, padBottom: 0 };
  useLayoutEffect(() => {
    if (!windowed || !scroller.current) return;
    const drawn = [...scroller.current.querySelectorAll<HTMLElement>("tbody > tr[data-row]")];
    if (drawn.length < 4) return;
    const avg = drawn.reduce((s, tr) => s + tr.offsetHeight, 0) / drawn.length;
    if (avg > 0 && Math.abs(avg - measured) > 2) setMeasured(avg);
  }, [windowed, measured, win.start, ordered.length]);

  // ---- J / K through the rows, Enter opens one, X picks it
  const [cursor, setCursor] = useState<number | null>(null);
  useEffect(() => {
    if (cursor == null || !scroller.current) return;
    const el = scroller.current;
    const tr = el.querySelector<HTMLElement>(`tr[data-row-index="${cursor}"]`);
    if (tr) {
      tr.focus({ preventScroll: true });
      tr.scrollIntoView({ block: "nearest" });
    } else if (windowed) el.scrollTop = Math.max(0, cursor * measured - el.clientHeight / 2);
  }, [cursor, windowed, measured, win.start]);
  const onKey = (e: React.KeyboardEvent<HTMLTableSectionElement>) => {
    const t = e.target as HTMLElement;
    if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName) || !t.matches("tr[data-row]")) return;
    const at = Number(t.getAttribute("data-row-index"));
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const move = (to: number) => {
      e.preventDefault();
      e.stopPropagation();
      setCursor(Math.max(0, Math.min(ordered.length - 1, to)));
    };
    if (key === "j" || key === "ArrowDown") move(at + 1);
    else if (key === "k" || key === "ArrowUp") move(at - 1);
    else if (key === "Home") move(0);
    else if (key === "End") move(ordered.length - 1);
    else if (key === "Enter" && onOpen) {
      e.preventDefault();
      onOpen(ordered[at]!);
    } else if ((key === "x" || key === " ") && select) {
      e.preventDefault();
      toggleChosen(rowKey(ordered[at]!));
    }
  };

  const toggleChosen = (k: string) =>
    setChosen((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const chosenRows = select ? ordered.filter((r) => chosen.has(rowKey(r))) : [];
  const allChosen = ordered.length > 0 && chosenRows.length === ordered.length;
  const clearChosen = useCallback(() => setChosen(new Set()), []);
  // Rows that left the list (filtered out, changed) are no longer picked.
  const keys = useMemo(() => new Set(ordered.map(rowKey)), [ordered, rowKey]);
  const [seenKeys, setSeenKeys] = useState(keys);
  if (keys !== seenKeys) {
    setSeenKeys(keys);
    if ([...chosen].some((k) => !keys.has(k))) setChosen(new Set([...chosen].filter((k) => keys.has(k))));
  }

  const optional = columns.filter((c) => !c.fixed);
  const width = shownCols.length + (select ? 1 : 0);

  return (
    <div ref={wrap} className="flex min-w-0 flex-col gap-2" data-table={id}>
      {(filter || toolbar || optional.length > 0) && (
        <div className="flex flex-wrap items-center gap-2">
          {filter && (
            <input
              type="search"
              className={`${inputCls} !py-1 w-56 text-xs`}
              placeholder={filterPlaceholder}
              aria-label={`Filter ${label}`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          {query && (
            <span className="num text-xs text-muted">
              {ordered.length.toLocaleString()} of {rows.length.toLocaleString()}
            </span>
          )}
          {toolbar}
          <div className="ml-auto flex items-center gap-1">
            {optional.length > 1 && <ColumnPicker columns={optional} isOn={(c) => !!(picked[c.id] ?? !c.optional)} onPick={pick} />}
            <button type="button" className={btn.ghost} onClick={() => void copy(false)} title="Copy the rows shown as CSV, each amount as the page shows it">
              Copy
            </button>
            <button type="button" className={btn.ghost} onClick={() => void copy(true)} title="Save the rows shown as a CSV file">
              Save CSV
            </button>
          </div>
        </div>
      )}
      {select && chosenRows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-accent/50 bg-accent-soft px-2 py-1.5 text-xs" role="region" aria-label="Picked rows">
          <span className="num font-semibold text-fg">{chosenRows.length.toLocaleString()} picked</span>
          {select.actions(chosenRows, clearChosen)}
          <button type="button" className={`${btn.link} ml-auto`} onClick={clearChosen}>
            Unpick all
          </button>
        </div>
      )}
      <div ref={scroller} className={tableCls.wrap} style={maxHeight || windowed ? { maxHeight: maxHeight ?? "calc(100dvh - 18rem)", overflowY: "auto" } : undefined}>
        <table className={tableCls.table} aria-labelledby={captionId}>
          <caption id={captionId} className="sr-only">
            {label}
          </caption>
          <thead className={`${tableCls.head} sticky top-0 z-10 bg-[var(--card-bg,var(--surface))]`}>
            <tr>
              {select && (
                <th className={`${tableCls.th} w-6`}>
                  <input type="checkbox" aria-label={allChosen ? "Unpick every row" : "Pick every row shown"} checked={allChosen} onChange={() => setChosen(allChosen ? new Set() : new Set(ordered.map(rowKey)))} />
                </th>
              )}
              {shownCols.map((c) => {
                const sorts = !!(onSort ? c.sort || c.date : sortOf(c));
                const on = sort?.key === c.id;
                return (
                  <th
                    key={c.id}
                    scope="col"
                    title={c.help}
                    className={c.thClassName ?? (c.align === "right" ? tableCls.thR : tableCls.th)}
                    aria-sort={on ? (sort!.desc ? "descending" : "ascending") : undefined}
                  >
                    {sorts ? (
                      <button type="button" className="uppercase tracking-wide outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus" onClick={() => toggleSort(c)} title={c.help ?? `Sort by ${c.label.toLowerCase()}`}>
                        {c.label}
                        {on ? (sort!.desc ? " ↓" : " ↑") : ""}
                      </button>
                    ) : (
                      c.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody onKeyDown={onKey}>
            {win.padTop > 0 && (
              <tr aria-hidden style={{ height: win.padTop }}>
                <td colSpan={width} />
              </tr>
            )}
            {ordered.slice(win.start, win.end).map((r, j) => {
              const i = win.start + j;
              const k = rowKey(r);
              return (
                <tr
                  key={k}
                  data-row=""
                  data-row-index={i}
                  tabIndex={i === (cursor ?? 0) ? 0 : -1}
                  aria-selected={select ? chosen.has(k) : undefined}
                  onFocus={() => setCursor((c) => (c === i ? c : i))}
                  onClick={onOpen ? (e) => !(e.target as HTMLElement).closest("button, a, input, select, textarea, label") && onOpen(r) : undefined}
                  className={`group ${tableCls.trHover} outline-none focus:bg-accent-soft focus:shadow-[inset_2px_0_0_var(--accent)] ${onOpen ? "cursor-pointer" : ""} ${select && chosen.has(k) ? "bg-accent-soft/60" : ""} ${rowClassName?.(r) ?? ""}`}
                >
                  {select && (
                    <td className={`${tableCls.td} w-6`}>
                      <input type="checkbox" aria-label="Pick this row" tabIndex={-1} checked={chosen.has(k)} onChange={() => toggleChosen(k)} />
                    </td>
                  )}
                  {shownCols.map((c) => (
                    <td key={c.id} className={c.className ?? (c.align === "right" ? tableCls.tdR : tableCls.td)}>
                      <Cell c={c} r={r} />
                    </td>
                  ))}
                </tr>
              );
            })}
            {win.padBottom > 0 && (
              <tr aria-hidden style={{ height: win.padBottom }}>
                <td colSpan={width} />
              </tr>
            )}
            {!ordered.length && (
              <tr>
                <td colSpan={width} className="px-2 py-6 text-center text-xs text-muted">
                  {query ? "No rows hold those words." : (empty ?? "Nothing to list.")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {footer}
    </div>
  );
}

function Cell<R>({ c, r }: { c: Column<R>; r: R }) {
  if (c.cell) return <>{c.cell(r)}</>;
  if (c.figure) {
    const f = c.figure(r);
    return (
      <ProofValue proof={f.proof} blockers={f.blockers}>
        {f.text}
      </ProofValue>
    );
  }
  if (c.date) {
    const d = c.date(r);
    return d ? <span className="num whitespace-nowrap">{dateLabel(d)}</span> : <>{NA}</>;
  }
  return <>{c.text?.(r) ?? ""}</>;
}

function ColumnPicker<R>({ columns, isOn, onPick }: { columns: readonly Column<R>[]; isOn: (c: Column<R>) => boolean; onPick: (id: string, on: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open]);
  return (
    <div ref={root} className="relative">
      <button type="button" className={btn.ghost} aria-expanded={open} onClick={() => setOpen((o) => !o)} title="Pick which columns show">
        Columns
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+4px)] z-30 flex min-w-[12rem] flex-col gap-0.5 rounded-md border border-line-strong bg-surface p-1.5 shadow-xl">
          {columns.map((c) => (
            <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs text-fg hover:bg-surface-2">
              <input type="checkbox" checked={isOn(c)} onChange={(e) => onPick(c.id, e.target.checked)} />
              {c.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
