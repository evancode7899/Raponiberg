"use client";

import { Badge, btn, Card, EmptyState, Field, inputCls, Segmented, selectCls, StatCell, StatGrid, table, type Tone } from "@/components/ui/kit";
import { sortRows, SortTh, useSort } from "@/components/ui/sort";
import type { HintMatch, RowRef, StatementCharge } from "@/lib/car/detect";
import { CAR_KINDS, carName, KIND_INFO, newId, SHARED, type CarEntry, type CarKind, type RowDecision } from "@/lib/car/settings";
import { useMemo, useState } from "react";
import type { CarCtx } from "./CarClient";
import { fmtDate, usd2 } from "./parts";

const STATUS: Record<StatementCharge["status"], { tone: Tone; label: string; help: string }> = {
  SUGGESTED: { tone: "warn", label: "confirm", help: "Might be a car cost; counts nothing until you say so" },
  COUNTED: { tone: "info", label: "counted", help: "Counted as a car cost, once, at the statement's amount" },
  COVERED: { tone: "pos", label: "in purchase", help: "Part of the purchase, which depreciation already counts, so it isn't added again" },
  IGNORED: { tone: "neutral", label: "not the car", help: "Left out" },
};

const HOW: Record<StatementCharge["how"], string> = {
  rule: "a car merchant",
  keyword: "your keyword",
  decision: "your decision",
  make: "the car's make (dealer)",
  log: "your log",
  store: "the same store as a car charge",
  merchant: "a merchant from your log",
};

const HINT: Record<HintMatch["status"], { tone: Tone; label: string }> = {
  MATCHED: { tone: "pos", label: "matched" },
  INSTALLMENTS: { tone: "pos", label: "paid monthly" },
  AWAITING: { tone: "neutral", label: "awaiting statement" },
  NOT_FOUND: { tone: "warn", label: "not on statements" },
  OFF_STATEMENT: { tone: "accent", label: "paid off-statement" },
  NO_COST: { tone: "neutral", label: "no cost" },
};

const HOW_MATCHED: Record<NonNullable<HintMatch["how"]>, string> = {
  pinned: "you picked it",
  exact: "same amount",
  close: "near amount",
  split: "rows that add up to it",
  combined: "one payment for several entries",
  installments: "monthly installments",
};

/** A word or two that names a merchant across its rows ("STATE FARM", "VALET PARK"). */
const merchantWords = (payee: string) =>
  payee
    .toUpperCase()
    .replace(/^APLPAY\s+/, "")
    .replace(/[^A-Z&' ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .slice(0, 2)
    .join(" ");

export function StatementsTab({ ctx }: { ctx: CarCtx }) {
  return (
    <>
      <Proof ctx={ctx} />
      <LogVsStatements ctx={ctx} />
      <Charges ctx={ctx} />
      <Keywords ctx={ctx} />
    </>
  );
}

/** The checks that every dollar counts once and the log adds no money of its own. */
function Proof({ ctx }: { ctx: CarCtx }) {
  const g = ctx.garage;
  const a = g.statements.audit;
  const fromLog = a.offStatementCents;
  const checks: { ok: boolean; text: string }[] = [
    { ok: a.doubleCounted.length === 0, text: a.doubleCounted.length === 0 ? "No statement row is counted twice." : `${a.doubleCounted.length} statement rows are counted twice — please report this.` },
    {
      ok: true,
      text: fromLog ? `Your log adds money only where you said it was paid outside your statements: ${a.offStatement} entr${a.offStatement === 1 ? "y" : "ies"}, ${usd2(fromLog)}.` : "Your log adds no money of its own: every cost is a statement charge.",
    },
    {
      ok: a.notFound === 0,
      text: a.notFound ? `${a.notFound} log entr${a.notFound === 1 ? "y has" : "ies have"} no statement charge (${usd2(a.notFoundCents)} logged) and count${a.notFound === 1 ? "s" : ""} nothing until you find it or mark it paid outside your statements.` : "Every log entry dated before the statements end is on them.",
    },
    { ok: a.toCheck === 0, text: a.toCheck ? `${a.toCheck} match${a.toCheck === 1 ? " is" : "es are"} worth a look (amount differs, several rows, a few days apart, or a merchant the rules don't know).` : "Every match is the same amount within days at a car merchant, or one you picked." },
  ];
  return (
    <Card
      title="Every dollar counted once"
      subtitle={`The car's costs come only from your card and bank statements (complete through ${fmtDate(g.statementsThrough)}). Each log entry is matched to the charge it describes and lends it the details a statement can't give: what it was, gallons, the odometer.`}
    >
      <StatGrid>
        <StatCell
          label="Car costs from statements"
          value={usd2(a.rowsCents - a.paymentCents)}
          sub={`${a.rows} rows (${a.rowsFromLog} matched to your log, ${a.rowsOnOwn} on their own)${a.paymentCents ? ` · plus ${usd2(a.paymentCents)} of car payments, which are the purchase` : ""}`}
        />
        <StatCell label="Log entries matched" value={`${a.matched + a.installments} of ${a.entries - a.noCost}`} sub={`you logged ${usd2(a.matchedLoggedCents)} · statements say ${usd2(a.matchedStatementCents)}`} />
        <StatCell label="Not on statements" value={String(a.notFound)} tone={a.notFound ? "warn" : "neutral"} sub={`${usd2(a.notFoundCents)} logged · counts nothing`} />
        <StatCell label="Awaiting statements" value={String(a.awaiting)} sub={`${usd2(a.awaitingCents)} logged after ${fmtDate(g.statementsThrough)}`} />
      </StatGrid>
      <ul className="mt-3 flex flex-col gap-1 text-xs">
        {checks.map((c) => (
          <li key={c.text} className="flex gap-2">
            <span className={c.ok ? "text-pos" : "text-warn"} aria-hidden>
              {c.ok ? "✓" : "!"}
            </span>
            <span className="text-fg-2">{c.text}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

type HintFilter = "NEEDS" | "ALL" | "NOT_COUNTED";

/** Every log entry beside the statement charge it is, with the owner's fixes one click away. */
function LogVsStatements({ ctx }: { ctx: CarCtx }) {
  const { garage: g, settings: s, save, saving, editEntry, accounts } = ctx;
  const hints = g.statements.hints;
  const needs = (h: HintMatch) => h.status === "NOT_FOUND" || h.confidence === "check";
  const [filter, setFilter] = useState<HintFilter>(hints.some(needs) ? "NEEDS" : "ALL");
  const list = useMemo(() => {
    const l = [...hints].reverse();
    if (filter === "NEEDS") return l.filter(needs);
    if (filter === "NOT_COUNTED") return l.filter((h) => h.status === "NOT_FOUND" || h.status === "AWAITING");
    return l.filter((h) => h.status !== "NO_COST");
  }, [hints, filter]);

  const update = (id: string, patch: (e: CarEntry) => Partial<CarEntry>, decisions?: Record<string, RowDecision>) =>
    void save({ ...s, rowDecisions: decisions ?? s.rowDecisions, entries: s.entries.map((e) => (e.id === id ? { ...e, ...patch(e) } : e)) });
  /** Ties the entry to rows; a row it had been told it isn't, or that was marked not the car, is cleared. */
  const pin = (h: HintMatch, rows: RowRef[]) => {
    const keys = rows.map((r) => r.key);
    const decisions = { ...s.rowDecisions };
    for (const r of rows) if (decisions[r.rowId]?.kind === "IGNORE") delete decisions[r.rowId];
    update(h.entryId, (e) => ({ links: rows.map((r) => ({ rowId: r.rowId, key: r.key })), rejected: e.rejected.filter((k) => !keys.includes(k)), offStatement: false }), decisions);
  };
  const reject = (h: HintMatch) => update(h.entryId, (e) => ({ links: [], rejected: [...new Set([...e.rejected, ...h.rows.map((r) => r.key)])] }));
  const account = (id: string) => accounts[id] ?? "";

  return (
    <Card
      title="Your log against your statements"
      subtitle="Each entry you logged, and the statement charge it is. A match is the statement's amount, counted once. An entry with no charge counts nothing: find its charge below, or mark it paid outside your statements if it will never be on one."
      actions={
        <Segmented
          size="xs"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "NEEDS", label: `Needs you (${hints.filter(needs).length})` },
            { value: "NOT_COUNTED", label: `Not counted (${hints.filter((h) => h.status === "NOT_FOUND" || h.status === "AWAITING").length})` },
            { value: "ALL", label: `All (${hints.filter((h) => h.status !== "NO_COST").length})` },
          ]}
        />
      }
    >
      {list.length === 0 ? (
        <EmptyState title={filter === "NEEDS" ? "Nothing needs you" : "No log entries here"}>{filter === "NEEDS" ? "Every log entry is matched to its statement charge." : "Log a fill-up or a cost with the buttons above."}</EmptyState>
      ) : (
        <div className={table.wrap}>
          <table className={table.table} style={{ minWidth: "60rem" }}>
            <thead>
              <tr className={table.head}>
                <th className={table.th}>Your log</th>
                <th className={table.thR}>Logged</th>
                <th className={table.th}>On your statements</th>
                <th className={table.th}>Status</th>
                <th className={table.th} />
              </tr>
            </thead>
            <tbody>
              {list.map((h) => {
                const e = s.entries.find((x) => x.id === h.entryId);
                const pinned = h.how === "pinned";
                const badge = h.confidence === "check" ? { tone: "warn" as Tone, label: "check" } : HINT[h.status];
                return (
                  <tr key={h.entryId} className={`${table.tr} align-top`}>
                    <td className={table.td}>
                      <div className="whitespace-nowrap text-fg">
                        {fmtDate(h.date)} · {h.item}
                      </div>
                      <div className="text-[11px] text-muted">
                        {KIND_INFO[h.kind].label}
                        {e?.note ? ` · ${e.note}` : ""}
                        {e && e.months > 1 ? ` · ${e.months} months` : ""}
                      </div>
                    </td>
                    <td className={table.tdR}>{usd2(h.cents)}</td>
                    <td className={table.td}>
                      {h.rows.length > 0 && (
                        <ul className="flex max-w-[30rem] flex-col gap-0.5">
                          {h.rows.map((r) => (
                            <li key={r.rowId} className="flex justify-between gap-3 text-xs">
                              <span className="truncate font-mono" title={`${r.payee}${account(r.accountId) ? ` · ${account(r.accountId)}` : ""}`}>
                                {fmtDate(r.date)} · {r.payee}
                              </span>
                              <span className="num shrink-0">{usd2(r.cents)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {(h.how || h.note) && (
                        <div className="mt-0.5 max-w-[30rem] text-[11px] text-muted">
                          {[h.how && h.how !== "installments" ? `By ${HOW_MATCHED[h.how]}` : "", h.note].filter(Boolean).join(" · ")}
                        </div>
                      )}
                      {(h.status === "NOT_FOUND" || h.status === "AWAITING") && h.candidates.length > 0 && (
                        <div className="mt-1.5 flex max-w-[30rem] flex-col gap-0.5 border-l-2 border-line pl-2">
                          <span className="text-[11px] font-medium text-muted">Could it be one of these?</span>
                          {h.candidates.map((r) => (
                            <div key={r.rowId} className="flex items-center justify-between gap-3 text-xs">
                              <span className="truncate font-mono" title={`${r.payee}${account(r.accountId) ? ` · ${account(r.accountId)}` : ""}`}>
                                {fmtDate(r.date)} · {r.payee}
                              </span>
                              <span className="flex shrink-0 items-center gap-2">
                                <span className="num">{usd2(r.cents)}</span>
                                <button type="button" className={btn.link} disabled={saving} onClick={() => pin(h, [r])}>
                                  This one
                                </button>
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className={table.td}>
                      <Badge tone={badge.tone} title={h.note ?? undefined}>
                        {badge.label}
                      </Badge>
                    </td>
                    <td className={`${table.td} whitespace-nowrap text-right`}>
                      <span className="flex flex-col items-end gap-1">
                        {h.status === "MATCHED" && !pinned && (
                          <button type="button" className={btn.link} disabled={saving} onClick={() => pin(h, h.rows)}>
                            Right charge
                          </button>
                        )}
                        {(h.status === "MATCHED" || h.status === "INSTALLMENTS") && (
                          <button type="button" className={btn.link} disabled={saving} onClick={() => reject(h)} title="It finds another charge, or lists it as not on your statements">
                            {pinned ? "Unlink" : "Not this"}
                          </button>
                        )}
                        {(h.status === "NOT_FOUND" || h.status === "AWAITING") && (
                          <button type="button" className={btn.link} disabled={saving} onClick={() => update(h.entryId, () => ({ offStatement: true }))} title="Cash, or an account the app doesn't have: the amount you logged counts">
                            Paid off-statement
                          </button>
                        )}
                        {h.status === "OFF_STATEMENT" && (
                          <button type="button" className={btn.link} disabled={saving} onClick={() => update(h.entryId, () => ({ offStatement: false }))}>
                            Find it on statements
                          </button>
                        )}
                        {e && (
                          <button type="button" className={btn.link} onClick={() => editEntry(e)}>
                            Edit
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

type Filter = "OPEN" | "GUESSED" | "ALL" | "IGNORED";

/** Every car charge on the statements: what it counts as, for which car, and why. */
function Charges({ ctx }: { ctx: CarCtx }) {
  const { garage: g, settings: s, save, saving, accounts } = ctx;
  const st = g.statements;
  const many = s.cars.length > 1;
  const [filter, setFilter] = useState<Filter>(st.suggested ? "OPEN" : st.guessed ? "GUESSED" : "ALL");
  const names = useMemo(() => new Map(s.cars.map((c) => [c.id, carName(c)])), [s.cars]);
  const hintItem = useMemo(() => new Map(st.hints.map((h) => [h.entryId, h])), [st.hints]);
  const { sort, toggle } = useSort();
  const charges = useMemo(() => {
    const keep = (c: StatementCharge) =>
      filter === "OPEN"
        ? c.status === "SUGGESTED"
        : filter === "GUESSED"
          ? c.status === "COUNTED" && c.carGuessed
          : filter === "IGNORED"
            ? c.status === "IGNORED"
            : c.status === "COUNTED" || c.status === "COVERED";
    return sortRows([...st.charges].reverse().filter(keep), sort, { date: (c) => c.date, amount: (c) => c.cents, name: (c) => c.payee });
  }, [st.charges, filter, sort]);
  /** Suggested rows per merchant, for "all from this merchant". */
  const openBy = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of st.charges) if (c.status === "SUGGESTED") m.set(merchantWords(c.payee), (m.get(merchantWords(c.payee)) ?? 0) + 1);
    return m;
  }, [st.charges]);

  const decide = (c: StatementCharge, patch: Partial<RowDecision> | null) => {
    const next = { ...s.rowDecisions };
    if (patch == null) delete next[c.rowId];
    // Picking a kind or a car is a decision: the charge counts from then on.
    else next[c.rowId] = { ...(s.rowDecisions[c.rowId] ?? { kind: c.kind, carId: c.carGuessed ? null : c.carId }), key: c.key, ...patch };
    void save({ ...s, rowDecisions: next });
  };
  const allFrom = (c: StatementCharge, kind: CarKind | "IGNORE") => void save({ ...s, matchRules: [...s.matchRules, { id: newId(), pattern: merchantWords(c.payee), kind, carId: null }] });
  const confirmAll = () => {
    const next = { ...s.rowDecisions };
    for (const c of st.charges) if (c.status === "SUGGESTED") next[c.rowId] = { kind: c.kind, carId: null, key: c.key };
    void save({ ...s, rowDecisions: next });
  };
  const usual = s.cars.find((c) => c.id === s.defaultCarId)?.id ?? s.cars.find((c) => !c.sale)?.id ?? "";

  return (
    <Card
      title="Car charges on your statements"
      subtitle={
        s.cars.some((c) => c.vehicle.purchaseDate)
          ? `Every card and bank row while you owned a car that's a car cost: one your log matched, a gas station, auto insurer, toll account, parking or repair shop (by name, or the same store number or phone as one), or one you decided. Parts stores, the town, car loans and merchants seen in your log wait for you. Categories are ignored: issuers file gas stations under Dining often enough.${many ? " Each goes to the car you owned that day; while you had more than one it goes to the usual car until you pick another (or Shared, to split it)." : ""}`
          : "Set the purchase date under Car details: statements are read from then on."
      }
      actions={
        <Segmented
          size="xs"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "OPEN", label: `To confirm (${st.suggested})` },
            ...(st.guessed ? [{ value: "GUESSED" as const, label: `Which car? (${st.guessed})` }] : []),
            { value: "ALL", label: `Counted (${st.counted + st.covered})` },
            { value: "IGNORED", label: `Not the car (${st.ignored})` },
          ]}
        />
      }
    >
      {many && (
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Field label="The usual car" hint="Gets charges from days you owned more than one car, until you pick.">
            <select className={selectCls} value={usual} disabled={saving} onChange={(e) => void save({ ...s, defaultCarId: e.target.value })}>
              {s.cars.map((c) => (
                <option key={c.id} value={c.id}>
                  {carName(c)}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}
      {filter === "OPEN" && st.suggested > 1 && (
        <div className="mb-3">
          <button type="button" className={btn.secondary} disabled={saving} onClick={confirmAll}>
            Count all {st.suggested} as shown
          </button>
        </div>
      )}
      {charges.length === 0 ? (
        <EmptyState title={filter === "OPEN" ? "Nothing to confirm" : filter === "GUESSED" ? "Every charge has its car" : "No charges here"}>
          {filter === "OPEN" ? "Every car-looking charge has been decided." : "Import statements, or add a keyword below for a merchant the rules don't know."}
        </EmptyState>
      ) : (
        <div className={table.wrap}>
          <table className={table.table} style={{ minWidth: many ? "66rem" : "58rem" }}>
            <thead>
              <tr className={table.head}>
                <SortTh k="date" label="Date" sort={sort} toggle={toggle} />
                <SortTh k="name" label="Statement description" sort={sort} toggle={toggle} />
                <SortTh k="amount" label="Amount" sort={sort} toggle={toggle} right />
                <th className={table.th}>Counts as</th>
                {many && <th className={table.th}>Car</th>}
                <th className={table.th}>Status</th>
                <th className={table.th} />
              </tr>
            </thead>
            <tbody>
              {charges.map((c) => {
                const locked = c.status === "COVERED";
                const h = c.entryIds.length ? hintItem.get(c.entryIds[0]!) : undefined;
                const words = merchantWords(c.payee);
                const several = c.status === "SUGGESTED" && (openBy.get(words) ?? 0) > 1 && words.length >= 4;
                return (
                  <tr key={c.rowId} className={`${table.tr} align-top`}>
                    <td className={`${table.td} whitespace-nowrap`}>{fmtDate(c.date)}</td>
                    <td className={table.td}>
                      <div className="max-w-[26rem] truncate font-mono text-xs" title={`${c.payee}${c.detail ? `\n${c.detail}` : ""}`}>
                        {c.payee}
                      </div>
                      <div className="max-w-[26rem] text-[11px] text-muted">
                        {[accounts[c.accountId], h ? `Your log: “${h.item}”${h.cents !== c.cents && h.rows.length === 1 && !h.with.length ? ` (${usd2(h.cents)})` : ""}` : c.reason, `by ${HOW[c.how]}`].filter(Boolean).join(" · ")}
                      </div>
                    </td>
                    <td className={table.tdR}>{usd2(c.cents)}</td>
                    <td className={table.td}>
                      <select className={selectCls} value={c.kind} disabled={saving || locked} onChange={(e) => decide(c, { kind: e.target.value as CarKind })} aria-label="Counts as">
                        {CAR_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {KIND_INFO[k].label}
                          </option>
                        ))}
                      </select>
                    </td>
                    {many && (
                      <td className={table.td}>
                        {locked ? (
                          <span className="text-xs text-fg-2">{c.carId === SHARED ? "shared" : (names.get(c.carId) ?? "—")}</span>
                        ) : (
                          <select
                            className={`${selectCls} ${c.carGuessed ? "border-accent" : ""}`}
                            value={c.carId}
                            disabled={saving}
                            onChange={(e) => decide(c, { carId: e.target.value })}
                            aria-label="Car"
                            title={c.carGuessed ? "Picked for it: you owned more than one car that day" : undefined}
                          >
                            {s.cars.map((car) => (
                              <option key={car.id} value={car.id}>
                                {carName(car)}
                              </option>
                            ))}
                            {c.kind !== "FUEL" && <option value={SHARED}>Shared (split)</option>}
                          </select>
                        )}
                      </td>
                    )}
                    <td className={table.td}>
                      <Badge tone={c.how === "log" ? "pos" : STATUS[c.status].tone} title={STATUS[c.status].help}>
                        {c.how === "log" ? "from your log" : STATUS[c.status].label}
                      </Badge>
                    </td>
                    <td className={`${table.td} whitespace-nowrap text-right`}>
                      <span className="flex flex-col items-end gap-1">
                        {c.status === "SUGGESTED" && (
                          <button type="button" className={btn.link} disabled={saving} onClick={() => decide(c, { kind: c.kind })}>
                            Count it
                          </button>
                        )}
                        {c.status === "COUNTED" && c.carGuessed && (
                          <button type="button" className={btn.link} disabled={saving} onClick={() => decide(c, { carId: c.carId })}>
                            Right car
                          </button>
                        )}
                        {c.status === "IGNORED" ? (
                          <button type="button" className={btn.link} disabled={saving} onClick={() => decide(c, null)}>
                            Restore
                          </button>
                        ) : (
                          !locked && (
                            <button type="button" className={btn.link} disabled={saving} onClick={() => decide(c, { kind: "IGNORE" })}>
                              Not the car
                            </button>
                          )
                        )}
                        {several && (
                          <>
                            <button type="button" className={btn.link} disabled={saving} onClick={() => allFrom(c, c.kind)} title={`Adds the keyword “${words}”`}>
                              Count all {words}
                            </button>
                            <button type="button" className={btn.link} disabled={saving} onClick={() => allFrom(c, "IGNORE")} title={`Adds the keyword “${words}” as not the car`}>
                              None of {words} is the car
                            </button>
                          </>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** The owner's own merchant words: always a car cost of a kind, or never the car. */
function Keywords({ ctx }: { ctx: CarCtx }) {
  const { settings: s, save, saving } = ctx;
  const many = s.cars.length > 1;
  const [pattern, setPattern] = useState("");
  const [patternKind, setPatternKind] = useState<CarKind | "IGNORE">("TAX_REG");
  const [patternCar, setPatternCar] = useState<string>("");
  const names = useMemo(() => new Map(s.cars.map((c) => [c.id, carName(c)])), [s.cars]);
  const carLabel = (id: string | null) => (id == null ? "the usual car" : id === SHARED ? "shared" : (names.get(id) ?? "—"));
  return (
    <Card title="Your keywords" subtitle="A word from a statement description that always means a car cost (your town's tax collector, a local garage, the parking company that bills you), or never does (your renters insurer). Your keywords come before the built-in merchants.">
      <div className="flex flex-col gap-2">
        {s.matchRules.map((m) => (
          <div key={m.id} className="flex items-center gap-3 text-xs">
            <span className="font-mono text-fg">{m.pattern}</span>
            <span className="text-muted">
              → {m.kind === "IGNORE" ? "Not the car" : KIND_INFO[m.kind].label}
              {many && m.kind !== "IGNORE" ? `, ${carLabel(m.carId)}` : ""}
            </span>
            <button type="button" className={btn.link} disabled={saving} onClick={() => void save({ ...s, matchRules: s.matchRules.filter((x) => x.id !== m.id) })}>
              Remove
            </button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <input className={`${inputCls} w-64`} value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="e.g. TOWN OF SPRINGFIELD TAX" />
          <select className={selectCls} value={patternKind} onChange={(e) => setPatternKind(e.target.value as CarKind | "IGNORE")} aria-label="Kind">
            {CAR_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_INFO[k].label}
              </option>
            ))}
            <option value="IGNORE">Not the car</option>
          </select>
          {many && patternKind !== "IGNORE" && (
            <select className={selectCls} value={patternCar} onChange={(e) => setPatternCar(e.target.value)} aria-label="Car">
              <option value="">The car owned that day</option>
              {s.cars.map((c) => (
                <option key={c.id} value={c.id}>
                  {carName(c)}
                </option>
              ))}
              <option value={SHARED}>Shared (split)</option>
            </select>
          )}
          <button
            type="button"
            className={btn.secondary}
            disabled={saving || pattern.trim().length < 3}
            onClick={() => void save({ ...s, matchRules: [...s.matchRules, { id: newId(), pattern: pattern.trim(), kind: patternKind, carId: patternKind === "IGNORE" ? null : patternCar || null }] }).then((ok) => ok && setPattern(""))}
          >
            Add keyword
          </button>
        </div>
      </div>
    </Card>
  );
}
