"use client";

import { Badge, btn, Card, EmptyState, inputCls, selectCls, table, type Tone } from "@/components/ui/kit";
import { sortRows, SortTh, useSort } from "@/components/ui/sort";
import type { LogRow } from "@/lib/car/report";
import { CAR_KINDS, carName, KIND_INFO, SHARED, type CarKind } from "@/lib/car/settings";
import { useMemo, useState } from "react";
import type { CarCtx } from "./CarClient";
import { blankEntry, isReading } from "./EntryEditor";
import { fmtDate, miles, usd2 } from "./parts";

type CarFilter = "ALL" | "THIS" | typeof SHARED;
type Show = "ALL" | "COUNTED" | "NOT_COUNTED";

/** Where a log line's money comes from, or why it counts nothing. */
export function logStatus(i: LogRow): { tone: Tone; label: string; help: string } {
  if (i.source === "RENT") return { tone: "accent", label: "in rent", help: "Parking paid inside the rent (Car details)" };
  if (i.source === "OFF_STATEMENT") return { tone: "accent", label: "paid off-statement", help: "You said this was paid outside your statements, so the amount you logged counts" };
  const m = i.match;
  if (!i.counted) {
    if (m?.status === "AWAITING") return { tone: "neutral", label: "awaiting statement", help: m.note ?? "" };
    if (m?.status === "INSTALLMENTS") return { tone: "neutral", label: "paid monthly", help: m.note ?? "" };
    if (m?.status === "NO_COST" || isReading(i)) return { tone: "neutral", label: i.cents === 0 && i.kind === "OTHER" ? "reading" : "no cost", help: "Nothing paid; its odometer (and gallons) still count" };
    return { tone: "warn", label: "not on statements", help: m?.note ?? "No statement charge is this entry, so it counts nothing" };
  }
  if (!m) return { tone: "info", label: "statement", help: "A car charge on your statements nobody logged" };
  if (m.confidence === "check") return { tone: "warn", label: "check match", help: m.note ?? "Matched to the statement, but worth a look" };
  return { tone: "pos", label: "✓ statement", help: "Your log entry and its statement charge: counted once, at the statement's amount" };
}

/**
 * Every car cost, for all the cars, newest first: each one a statement charge named as
 * the statement prints it, with what the log says about it beneath. Log entries that
 * count nothing (no charge found, awaiting a statement, paid monthly) are listed too,
 * greyed. Click a row to change it; a charge nobody logged opens as a new entry tied to
 * it (to add gallons or an odometer reading), so it still counts once.
 */
export function LogTab({ ctx }: { ctx: CarCtx }) {
  const { garage: g, settings: s, car, editEntry, goTo } = ctx;
  const many = s.cars.length > 1;
  const [carFilter, setCarFilter] = useState<CarFilter>(many ? "THIS" : "ALL");
  const [kind, setKind] = useState<CarKind | "ALL">("ALL");
  const [show, setShow] = useState<Show>("ALL");
  const [q, setQ] = useState("");
  const names = useMemo(() => new Map(s.cars.map((c) => [c.id, carName(c)])), [s.cars]);
  const { sort, toggle } = useSort();

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = [...g.log]
      .reverse()
      .filter((i) => carFilter === "ALL" || (carFilter === "THIS" ? i.carId === car.id || i.carId === SHARED : i.carId === carFilter))
      .filter((i) => kind === "ALL" || i.kind === kind)
      .filter((i) => show === "ALL" || (show === "COUNTED") === i.counted)
      .filter((i) => !needle || `${i.item} ${i.label ?? ""} ${i.note}`.toLowerCase().includes(needle));
    return sortRows(list, sort, { date: (i) => i.date, amount: (i) => i.cents, name: (i) => i.item });
  }, [g.log, carFilter, car.id, kind, show, q, sort]);
  const total = items.filter((i) => i.counted && i.date <= g.today).reduce((t, i) => t + i.cents, 0);

  const open = (i: LogRow) => {
    if (i.source === "RENT") {
      ctx.selectCar(i.carId);
      return goTo("setup");
    }
    const e = i.entryIds.length ? s.entries.find((x) => x.id === i.entryIds[0]) : undefined;
    if (e) return editEntry(e);
    // A statement charge nobody logged: log it with its details, tied to its rows so it counts once.
    const links = i.rowIds.map((rowId) => ({ rowId, key: g.statements.charges.find((c) => c.rowId === rowId)?.key ?? "" }));
    editEntry({ ...blankEntry(i.kind === "FUEL" ? "FUEL" : "COST", i.carId, i.date), kind: i.kind, item: i.kind === "FUEL" ? "Gas" : (i.label ?? KIND_INFO[i.kind].label), cents: i.cents, links, months: i.months });
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {many && (
          <select className={selectCls} value={carFilter} onChange={(e) => setCarFilter(e.target.value as CarFilter)} aria-label="Car">
            <option value="THIS">{carName(car)} (with shared)</option>
            <option value="ALL">All cars</option>
            <option value={SHARED}>Shared only</option>
          </select>
        )}
        <select className={selectCls} value={kind} onChange={(e) => setKind(e.target.value as CarKind | "ALL")} aria-label="Kind">
          <option value="ALL">All kinds</option>
          {CAR_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_INFO[k].label}
            </option>
          ))}
        </select>
        <select className={selectCls} value={show} onChange={(e) => setShow(e.target.value as Show)} aria-label="Show">
          <option value="ALL">Counted and not</option>
          <option value="COUNTED">Counted only</option>
          <option value="NOT_COUNTED">Not counted only</option>
        </select>
        <input className={`${inputCls} w-48`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search charge, item or note" aria-label="Search" />
        <span className="text-xs text-muted">
          {items.length} rows · {usd2(total)} counted
        </span>
      </div>

      {items.length === 0 ? (
        <EmptyState title={g.log.length ? "Nothing matches" : "Nothing logged yet"}>
          {g.log.length ? "Try another car, kind or search." : "Car charges on your statements show up here on their own. Use the buttons above to add gallons, an odometer reading or what a charge was."}
        </EmptyState>
      ) : (
        <Card>
          <div className={table.wrap}>
            <table className={table.table} style={{ minWidth: many ? "62rem" : "56rem" }}>
              <thead>
                <tr className={table.head}>
                  <SortTh k="date" label="Date" sort={sort} toggle={toggle} />
                  {many && <th className={table.th}>Car</th>}
                  <SortTh k="name" label="Charge" sort={sort} toggle={toggle} />
                  <th className={table.th}>Kind</th>
                  <SortTh k="amount" label="Cost" sort={sort} toggle={toggle} right />
                  <th className={table.thR}>Gallons</th>
                  <th className={table.thR}>Odometer</th>
                  <th className={table.th}>Source</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => {
                  const reading = !i.counted && isReading(i);
                  const st = logStatus(i);
                  const sub = [
                    i.label && i.label !== i.item ? `Logged as “${i.label}”` : "",
                    i.loggedCents != null ? `you logged ${usd2(i.loggedCents)}` : "",
                    i.note,
                    i.months > 1 ? `covers ${i.months} months` : "",
                    !i.counted && i.match?.status === "NOT_FOUND" ? "counts nothing" : "",
                  ].filter(Boolean);
                  return (
                    <tr
                      key={i.id}
                      className={`${table.trHover} cursor-pointer ${i.date > g.today || !i.counted ? "text-muted" : ""}`}
                      onClick={() => open(i)}
                      title={i.entryIds.length ? "Edit the log entry" : i.source === "STATEMENT" ? "Add details (gallons, odometer, what it was) or move it to another car" : "Edit"}
                    >
                      <td className={`${table.td} whitespace-nowrap`}>{fmtDate(i.date)}</td>
                      {many && <td className={`${table.td} whitespace-nowrap text-xs text-fg-2`}>{i.carId === SHARED ? <Badge tone="accent">shared</Badge> : (names.get(i.carId) ?? "—")}</td>}
                      <td className={table.td}>
                        <div className={`max-w-[26rem] truncate ${i.counted && i.source === "STATEMENT" ? "font-mono text-xs" : ""}`} title={i.item}>
                          {i.item}
                        </div>
                        {sub.length > 0 && <div className="max-w-[26rem] truncate text-[11px] text-muted">{sub.join(" · ")}</div>}
                      </td>
                      <td className={`${table.td} text-xs text-fg-2`}>{reading ? "Odometer reading" : KIND_INFO[i.kind].label}</td>
                      <td className={`${table.tdR} ${i.counted ? "" : "line-through decoration-muted"}`}>{reading ? "" : usd2(i.cents)}</td>
                      <td className={table.tdR}>{i.gallons != null ? i.gallons.toFixed(3) : ""}</td>
                      <td className={table.tdR}>{i.odometer != null ? miles(i.odometer) : ""}</td>
                      <td className={table.td}>
                        <Badge tone={st.tone} title={st.help}>
                          {st.label}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <p className="text-xs text-muted">
        Every cost is a statement charge, under the name the statement prints. Your log entries add what the statement can&apos;t say (what it was, gallons, the odometer) and never add money of their own; one with no charge is struck through and counts nothing.{" "}
        <button type="button" className={btn.link} onClick={() => goTo("statements")}>
          Log vs statements
        </button>
      </p>
    </>
  );
}
