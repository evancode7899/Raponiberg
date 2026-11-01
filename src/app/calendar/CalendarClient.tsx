"use client";

import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { calendarDerived } from "@/lib/book/derived/planning";
import { derivedTarget } from "@/lib/book/derived/types";
import { cachedResponse, useApi } from "@/components/ledger/useApi";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import { Badge, Callout, Card, EmptyState, ErrorNote, Loading, PageBody, Segmented } from "@/components/ui/kit";
import type { CalendarItem, CalendarKind, MoneyCalendarReport } from "@/lib/book/reports/moneyCalendar";
import { usd0 } from "@/lib/formatMoney";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

const CALENDAR_URL = "/api/calendar";

const KIND: Record<CalendarKind, string> = { save: "Save", tax: "Tax", file: "Return" };

const daysUntil = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
const longDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "long", day: "numeric", year: "numeric" });
const inDays = (n: number) => (n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`);

export function CalendarClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [r, setR] = useState(() => cachedResponse<MoneyCalendarReport>(CALENDAR_URL));
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState<"open" | "all">("open");
  useEffect(() => {
    if (!api.ready) return;
    api
      .call<MoneyCalendarReport>(CALENDAR_URL)
      .then(setR)
      .catch((e: Error) => setError(e.message));
  }, [api]);

  return (
    <PageBody width="medium">
      <ApiSecretField api={api} />
      {error && <ErrorNote>{error}</ErrorNote>}
      {!r ? api.ready && !error && <Loading label="Lining up every deadline with its amount…" /> : <Calendar r={r} show={show} setShow={setShow} />}
    </PageBody>
  );
}

function Calendar({ r, show, setShow }: { r: MoneyCalendarReport; show: "open" | "all"; setShow: (s: "open" | "all") => void }) {
  const shown = useMemo(() => (show === "open" ? r.items.filter((i) => !i.done) : r.items), [r, show]);
  const groups = useMemo(() => {
    const m = new Map<string, CalendarItem[]>();
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
        <div className="mt-3">
          <Segmented view
            options={[
              { value: "open", label: `Open (${open.length})` },
              { value: "all", label: `All (${r.items.length})` },
            ]}
            value={show}
            onChange={setShow}
          />
        </div>
      </Card>

      {groups.length === 0 ? (
        <EmptyState title="Nothing left to do before the next deadline" />
      ) : (
        groups.map(([date, items]) => {
          const d = daysUntil(r.today, date);
          return (
            <Card key={date} title={d === 0 ? "Now" : `By ${longDate(date)}`} subtitle={d === 0 ? "Only paychecks still to come can change these, so sooner is better." : inDays(d)}>
              <ul className="divide-y divide-line">
                {items.map((i) => (
                  <Item key={i.id} i={i} showYear={twoYears} />
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
      <p className="text-xs text-muted">Estimates from your statements and pay stubs, not tax advice.</p>
    </div>
  );
}

function Item({ i, showYear }: { i: CalendarItem; showYear: boolean }) {
  const refund = i.kind === "file" && i.cents != null && i.cents < 0;
  // Zero formats as a dash (accounting style); on a to-do list it reads better in words.
  const amount = i.cents == null ? null : i.cents === 0 ? (i.kind === "save" ? "Filled" : "None due") : refund ? usd0(-i.cents) : usd0(i.cents);
  return (
    <li className={`flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0 ${i.done ? "opacity-60" : ""}`}>
      <span
        aria-label={i.done ? "Done" : "Open"}
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold ${i.done ? "border-pos bg-pos-soft text-pos" : "border-line-strong text-faint"}`}
      >
        {i.done ? "✓" : ""}
      </span>
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
