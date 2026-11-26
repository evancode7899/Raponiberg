"use client";

import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { calendarDerived } from "@/lib/book/derived/planning";
import { derivedTarget } from "@/lib/book/derived/types";
import { cachedResponse, useApi } from "@/components/ledger/useApi";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { Badge, btn, Callout, Card, EmptyState, ErrorNote, Loading, PageBody, Segmented } from "@/components/ui/kit";
import type { CalendarItem, CalendarKind, MoneyCalendarReport } from "@/lib/book/reports/moneyCalendar";
import { icsFile } from "@/lib/dates/ics";
import { usd0 } from "@/lib/formatMoney";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { weekdayLabel } from "@/lib/dates/display";
import { notify } from "@/components/ui/Feedback";
import type { Mark } from "@/lib/marks";
import type { BriefingDue } from "@/lib/dashboard/briefing";
import type { GarageReport } from "@/lib/car/report";

const CALENDAR_URL = "/api/calendar";
const DONE_URL = "/api/calendar/done";

const KIND: Record<CalendarKind, string> = { save: "Save", tax: "Tax", file: "Return" };

const daysUntil = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
const longDate = (d: string) => weekdayLabel(d);
const inDays = (n: number) => (n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`);

export function CalendarClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [r, setR] = useState(() => cachedResponse<MoneyCalendarReport>(CALENDAR_URL));
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState<"open" | "all">("open");
  const [marks, setMarks] = useState<Mark[]>([]);
  const [upcoming, setUpcoming] = useState<BriefingDue[]>([]);
  const [services, setServices] = useState<GridItem[]>([]);
  useEffect(() => {
    if (!api.ready) return;
    api
      .call<MoneyCalendarReport>(CALENDAR_URL)
      .then(setR)
      .catch((e: Error) => setError(e.message));
    api.call<{ marks: Mark[] }>(DONE_URL).then((x) => setMarks(x.marks)).catch(() => {});
    // Card credits closing and policy dates: the Dashboard's Next up, on the month grid.
    api.call<{ due: BriefingDue[] }>("/api/dashboard/upcoming").then((x) => setUpcoming(x.due)).catch(() => {});
    // Each car's next service, as the Car page works it out (its time limit, or the odometer at the current pace).
    api
      .call<{ report: GarageReport }>("/api/car")
      .then((x) => setServices(x.report.cars.flatMap((c) => (c.sold || !c.service.nextDueDate ? [] : [{ id: `car-service:${c.carId}`, date: c.service.nextDueDate, title: `Car service${c.service.next ? ` (${c.service.next.miles.toLocaleString("en-US")} mi)` : ""}`, done: false, href: "/car?tab=service" }]))))
      .catch(() => {});
  }, [api]);
  // Done stays done: a date marked done is done whatever the engines say later.
  const doneIds = useMemo(() => new Set(marks.map((m) => m.id)), [marks]);
  const toggle = (i: CalendarItem, done: boolean) =>
    api
      .call<{ marks: Mark[] }>(DONE_URL, { method: "POST", json: { op: done ? "done" : "open", id: i.id } })
      .then((x) => {
        setMarks(x.marks);
        notify(done ? `Done: ${i.title}` : `Open again: ${i.title}`, { tone: "info", undo: () => void toggle(i, !done) });
      })
      .catch((e: Error) => notify(e.message, { tone: "bad" }));
  const shownR = useMemo(() => (r ? { ...r, items: r.items.map((i) => ({ ...i, done: i.done || doneIds.has(i.id), marked: doneIds.has(i.id) })) } : null), [r, doneIds]);

  return (
    <PageBody width="medium">
      <ApiSecretField api={api} />
      {error && <ErrorNote>{error}</ErrorNote>}
      {!shownR ? api.ready && !error && <Loading label="Lining up every deadline with its amount…" /> : <Calendar r={shownR} show={show} setShow={setShow} toggle={toggle} upcoming={upcoming} services={services} />}
    </PageBody>
  );
}

type Shown = CalendarItem & { marked: boolean };

function Calendar({ r, show, setShow, toggle, upcoming, services }: { r: Omit<MoneyCalendarReport, "items"> & { items: Shown[] }; show: "open" | "all"; setShow: (s: "open" | "all") => void; toggle: (i: CalendarItem, done: boolean) => void; upcoming: BriefingDue[]; services: GridItem[] }) {
  const [layout, setLayout] = useState<"list" | "month">("list");
  const shown = useMemo(() => (show === "open" ? r.items.filter((i) => !i.done) : r.items), [r, show]);
  const groups = useMemo(() => {
    const m = new Map<string, Shown[]>();
    for (const i of shown) m.set(i.date, [...(m.get(i.date) ?? []), i]);
    return [...m];
  }, [shown]);
  const open = r.items.filter((i) => !i.done);
  const next = open[0];
  const twoYears = r.years.length > 1;

  return (
    <div className="flex flex-col gap-4">
      <Card
        tone="overview"
        title={next ? "Next up" : "Nothing open"}
        subtitle={`Each deadline for tax year${twoYears ? `s ${r.years.join(" and ")}` : ` ${r.years[0] ?? ""}`}, with the amount the Taxes and Account limits pages work out. Click an amount for its proof.`}
      >
        {next ? (
          <p className="text-sm text-fg-2">
            <span className="font-semibold text-fg">{next.title}</span> — {longDate(next.date)}, {inDays(daysUntil(r.today, next.date))}. {open.length === 1 ? "Nothing else is open." : `${open.length - 1} more open after it.`}
          </p>
        ) : (
          <p className="text-sm text-fg-2">Nothing open: every room is filled and no payment is due.</p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Segmented view
            options={[
              { value: "open", label: `Open (${open.length})` },
              { value: "all", label: `All (${r.items.length})` },
            ]}
            value={show}
            onChange={setShow}
          />
          {open.length > 0 && (
            <button type="button" className={btn.secondary} title="Every open deadline as a calendar file, with reminders 14 and 3 days before. It carries the actions and dates, no amounts." onClick={() => saveIcs(open)}>
              Add to my calendar
            </button>
          )}
        </div>
      </Card>

      <div className="flex justify-end">
        <Segmented size="xs" ariaLabel="Layout" options={[{ value: "list", label: "List" }, { value: "month", label: "Month grid" }]} value={layout} onChange={setLayout} />
      </div>
      {layout === "month" ? (
        <MonthGrid today={r.today} items={r.items} upcoming={upcoming} extra={services} />
      ) : groups.length === 0 ? (
        <EmptyState title="Nothing left to do before the next deadline" />
      ) : (
        groups.map(([date, items]) => {
          const d = daysUntil(r.today, date);
          return (
            <Card key={date} title={d === 0 ? "Now" : `By ${longDate(date)}`} subtitle={d === 0 ? "Only paychecks still to come can change these, so sooner is better." : inDays(d)}>
              <ul className="divide-y divide-line">
                {items.map((i) => (
                  <Item key={i.id} i={i} showYear={twoYears} toggle={toggle} />
                ))}
              </ul>
            </Card>
          );
        })
      )}

      {r.notes.length > 0 && (
        <Callout tone="info" title="Not on the calendar">
          <ul className="list-disc space-y-1 pl-4">
            {r.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Callout>
      )}
      <p className="text-xs leading-relaxed text-muted">
        Estimated tax uses the regular method: by each date a quarter more of the year&apos;s safe-harbor payment must be in, with withholding counted as paid evenly through the year, so the next date
        includes what earlier ones missed. The annualized-income method, which can ask for less early on when income comes late in the year, isn&apos;t worked out here. Estimates from your statements and
        pay stubs, not tax advice.
      </p>
    </div>
  );
}

/** Saves the open deadlines as a calendar file. Amounts stay in the app: a calendar is often shared or synced. */
function saveIcs(items: CalendarItem[]) {
  const text = icsFile(
    items.map((i) => ({ id: i.id, date: i.date, title: i.title, description: "From Raponiberg's money calendar. Open the app for the amount." })),
    new Date(),
  );
  const url = URL.createObjectURL(new Blob([text], { type: "text/calendar" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "money-calendar.ics";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function Item({ i, showYear, toggle }: { i: Shown; showYear: boolean; toggle: (i: CalendarItem, done: boolean) => void }) {
  const refund = i.kind === "file" && i.cents != null && i.cents < 0;
  // Zero formats as a dash (accounting style); on a to-do list it reads better in words.
  const amount = i.cents == null ? null : i.cents === 0 ? (i.kind === "save" ? "Filled" : "None due") : refund ? usd0(-i.cents) : usd0(i.cents);
  return (
    <li className={`flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0 ${i.done ? "opacity-60" : ""}`}>
      <button
        type="button"
        aria-pressed={i.done}
        aria-label={i.done ? `Done: ${i.title}` : `Mark done: ${i.title}`}
        // Done by the engines (a room filled) stays done on its own; one you marked can be opened again.
        disabled={i.done && !i.marked}
        title={i.done && !i.marked ? "Done: nothing left to do" : i.marked ? "You marked it done: click to open it again" : "Mark it done: it stays done"}
        onClick={() => toggle(i, !i.done)}
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold outline-none focus-visible:ring-2 focus-visible:ring-focus ${i.done ? "border-pos bg-pos-soft text-pos" : "border-line-strong text-faint hover:border-accent"}`}
      >
        {i.done ? "✓" : ""}
      </button>
      <div className="min-w-0 flex-1 basis-56">
        <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-fg">
          {i.title}
          <Badge tone={i.kind === "save" ? "pos" : i.kind === "tax" ? "warn" : "info"}>{KIND[i.kind]}</Badge>
          {showYear && <Badge>{i.year}</Badge>}
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">{i.detail}</p>
      </div>
      <div className="ml-8 flex shrink-0 flex-col items-end gap-0.5 sm:ml-0">
        {amount != null && (
          <span className={`num text-sm font-semibold ${refund ? "text-pos" : "text-fg"}`}>
            <ProofValue proof={i.proof ? { descriptor: i.proof, shownCents: i.cents! } : derivedTarget("calendar", calendarDerived({ items: [i] }), "item", i.id)} drawn={{ zeroWithin: 0 }}>{amount}</ProofValue>
            {i.perPaycheck ? <span className="font-normal text-muted"> /paycheck</span> : refund ? <span className="font-normal text-muted"> back</span> : null}
          </span>
        )}
        <Link href={i.href} className="text-xs text-accent hover:underline">
          Open →
        </Link>
      </div>
    </li>
  );
}

/**
 * The month grid: this month and the next two, every dated thing on its day (the calendar's
 * deadlines, card credits closing, policy dates), what's done struck through. Titles only:
 * the amounts are on the list, each with its proof.
 */
type GridItem = { id: string; date: string; title: string; done: boolean; href: string };

function MonthGrid({ today, items, upcoming, extra }: { today: string; items: Shown[]; upcoming: BriefingDue[]; extra: GridItem[] }) {
  const byDay = new Map<string, { id: string; title: string; done: boolean; href: string }[]>();
  for (const x of [...items.map((i) => ({ id: i.id, date: i.date, title: i.title, done: i.done, href: i.href })), ...upcoming.map((u) => ({ id: u.id, date: u.date, title: u.title, done: u.done, href: u.href })), ...extra])
    byDay.set(x.date, [...(byDay.get(x.date) ?? []), x]);
  const months = [0, 1, 2].map((k) => {
    const d = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 + k, 1));
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
  });
  return (
    <div className="flex flex-col gap-4">
      {months.map(({ y, m }) => {
        const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
        const lead = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7;
        return (
          <Card key={`${y}-${m}`} title={new Date(Date.UTC(y, m, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}>
            <div className="grid grid-cols-7 gap-px bg-line text-[11px]">
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((w) => (
                <div key={w} className="bg-surface-2 px-1 py-0.5 text-muted">
                  {w}
                </div>
              ))}
              {Array.from({ length: lead }, (_, k) => (
                <div key={`lead${k}`} className="bg-surface" />
              ))}
              {Array.from({ length: days }, (_, k) => {
                const iso = `${y}-${String(m + 1).padStart(2, "0")}-${String(k + 1).padStart(2, "0")}`;
                const list = byDay.get(iso) ?? [];
                return (
                  <div key={iso} className={`min-h-[4.2rem] bg-surface px-1 py-0.5 ${iso === today ? "ring-1 ring-inset ring-accent" : ""} ${iso < today ? "opacity-50" : ""}`}>
                    <div className="num text-faint">{k + 1}</div>
                    {list.map((x) => (
                      <Link key={x.id} href={x.href} title={x.title} className={`block truncate leading-tight hover:underline ${x.done ? "text-faint line-through" : "text-fg-2"}`}>
                        {x.title}
                      </Link>
                    ))}
                  </div>
                );
              })}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
