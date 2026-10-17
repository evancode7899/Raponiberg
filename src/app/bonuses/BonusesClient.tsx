"use client";

import { BlockedNote } from "@/components/ledger/Blocked";
import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { cachedResponse, useApi } from "@/components/ledger/useApi";
import { Badge, btn, Callout, Card, EmptyState, ErrorNote, Loading, PageBody, StatCell, StatGrid, table, Tabs, useTabParam, type Tone } from "@/components/ui/kit";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import type { PaymentKind } from "@/lib/bonuses/awardStore";
import type { PayLine } from "@/lib/book/proof/payProof";
import type { AwardRow, BonusesReport, BonusWarning, VestWindow, WindowStatus } from "@/lib/book/reports/bonuses";
import { formatDisplayDateFromYmd } from "@/lib/displayTime";
import { formatPercentRatio, formatUsdCents, usd0 } from "@/lib/formatMoney";
import { useEffect, useState } from "react";

const TABS = ["overview", "schedule", "payouts"] as const;

const STATUS: Record<WindowStatus, { label: string; tone: Tone; cell: string }> = {
  PAID: { label: "Paid", tone: "pos", cell: "text-pos" },
  PAID_DIFFERENT: { label: "Paid, differs", tone: "warn", cell: "text-warn" },
  UPCOMING: { label: "Upcoming", tone: "info", cell: "text-info" },
  DUE: { label: "Due now", tone: "accent", cell: "text-accent" },
  FORFEITED: { label: "Forfeited", tone: "neg", cell: "text-neg line-through decoration-1" },
  NOT_ON_STUBS: { label: "Not on stubs", tone: "neg", cell: "text-neg" },
  NO_STUBS: { label: "No stubs", tone: "warn", cell: "text-warn" },
};

const StatusBadge = ({ s, title }: { s: WindowStatus; title?: string }) => (
  <Badge tone={STATUS[s].tone} title={title}>
    {STATUS[s].label}
  </Badge>
);

const KIND: Record<PaymentKind, { title: string; tag: string | null; part: string }> = {
  UPFRONT: { title: "Up-front cash", tag: "cash", part: "cash" },
  DEFERRED: { title: "Deferred tranche", tag: null, part: "deferral" },
  SIGNING: { title: "Sign-on bonus (outside the headline bonus)", tag: "sign-on", part: "sign-on" },
  MAKEWHOLE: { title: "Make-whole bonus (outside the headline bonus)", tag: "make-whole", part: "make-whole" },
};

const ratio = (part: number, whole: number | null) => (whole ? formatPercentRatio(part / whole, 1) : "—");

/** A person's calendar year of pay as the stubs give it (year to date on each employer's last stub). */
const yearPay = (personId: string, year: number, lines: PayLine[], cents: number) => ({ descriptor: { report: "pay" as const, basis: "ytd" as const, personId, year, lines }, shownCents: cents });

export function BonusesClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [tab, setTab] = useTabParam(TABS, "overview");
  const [r, setReport] = useState<BonusesReport | null>(() => cachedResponse<{ report: BonusesReport }>("/api/bonuses")?.report ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api.ready) return;
    api
      .call<{ report: BonusesReport }>("/api/bonuses")
      .then((d) => setReport(d.report))
      .catch((e: Error) => setError(e.message));
  }, [api]);

  const post = async (json: Record<string, string>) => {
    try {
      const d = await api.call<{ report: BonusesReport }>("/api/bonuses", { method: "POST", json });
      setReport(d.report);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const onReview: OnReview = (id, note) => post({ action: "review", id, note });

  return (
    <>
      <Tabs
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "schedule", label: "Vesting schedule" },
          { id: "payouts", label: "Bonus paychecks", count: r?.payments.length },
        ]}
        value={tab}
        onChange={setTab}
      />
      <PageBody>
        <ApiSecretField api={api} />
        {error && <ErrorNote>{error}</ErrorNote>}
        {!r ? (
          api.ready && !error && <Loading label="Matching letters to pay stubs…" />
        ) : (
          <>
            {r.warnings.map((w) => (
              <WarningCallout key={w.id} w={w} onReview={onReview} />
            ))}
            <BlockedNote what="which bonuses were paid" blockers={r.blockers} />
            {tab === "overview" && <Overview r={r} />}
            {tab === "schedule" && <Schedule r={r} />}
            {tab === "payouts" && <Payouts r={r} />}
          </>
        )}
      </PageBody>
    </>
  );
}

type OnReview = (id: string, note: string) => Promise<void>;

/** A note and a button: the owner's say-so, never empty. */
function NoteForm({ placeholder, label, onSubmit, hint }: { placeholder: string; label: string; onSubmit: (text: string) => Promise<void>; hint: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <input
        className="min-w-[16rem] flex-1 rounded-md border border-line-strong bg-surface px-2 py-1 text-xs"
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button
        type="button"
        className={btn.secondary}
        disabled={!text.trim() || busy}
        onClick={async () => {
          setBusy(true);
          await onSubmit(text);
          setBusy(false);
        }}
      >
        {label}
      </button>
      <span className="w-full text-xs text-faint">{hint}</span>
    </div>
  );
}

function WarningCallout({ w, onReview }: { w: BonusWarning; onReview: OnReview }) {
  const [open, setOpen] = useState(false);
  return (
    <Callout
      tone="warn"
      title="Check this"
      action={
        <button type="button" className={btn.link} onClick={() => setOpen(!open)}>
          {open ? "Cancel" : "Mark reviewed…"}
        </button>
      }
    >
      {w.text}
      {open && (
        <NoteForm
          placeholder="Why this is fine (required) — e.g. employer rounding, in my favor"
          label="Mark reviewed"
          onSubmit={(note) => onReview(w.id, note)}
          hint="It stops showing, and your note is kept on file. If the letters or stubs change this gap, it comes back."
        />
      )}
    </Callout>
  );
}

function Overview({ r }: { r: BonusesReport }) {
  const t = r.totals;
  if (!r.awards.length) return <NoLetters r={r} />;
  const fullYears = r.awards.filter((a) => !a.partial).map((a) => a.year);
  return (
    <>
      <StatGrid cols={6}>
        <StatCell label="Headline bonuses" value={usd0(t.headlineCents)} sub={`${fullYears.length} year${fullYears.length === 1 ? "" : "s"} on letters (${[...fullYears].sort().join(", ")})`} />
        <StatCell label="Paid up front" value={usd0(t.upfrontCents)} sub={`${ratio(t.upfrontCents, t.headlineCents)} of headline`} />
        <StatCell label="Deferred" value={usd0(t.deferredCents)} sub={`${ratio(t.deferredCents, t.headlineCents)} of headline`} />
        <StatCell label="Deferred paid out" value={usd0(t.deferredPaidCents)} tone={t.deferredPaidCents ? "pos" : "neutral"} sub={`${ratio(t.deferredPaidCents, t.deferredCents)} of deferred`} />
        <StatCell label="Forfeited" value={usd0(t.forfeitedCents)} tone={t.forfeitedCents ? "neg" : "neutral"} sub={`${ratio(t.forfeitedCents, t.deferredCents)} of deferred`} />
        <StatCell
          label="Still to vest"
          value={usd0(t.outstandingCents)}
          tone={t.outstandingCents ? "info" : "neutral"}
          sub={t.next ? `Next: ${usd0(t.next.amountCents)} in ${t.next.label}` : "Nothing left to vest"}
        />
      </StatGrid>

      <Card title="Bonus by year" subtitle="Each year's bonus as the letter states it: the cash paid up front, the part deferred, and what became of the deferral. Paid amounts come from the bonus lines on the pay stubs.">
        <div className={table.wrap}>
          <table className={table.table}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Year</th>
                <th className={table.th}>Employer</th>
                <th className={table.thR}>Base</th>
                <th className={table.thR}>Headline bonus</th>
                <th className={table.thR}>Total comp</th>
                <th className={table.thR}>Up front</th>
                <th className={table.thR}>Deferred</th>
                <th className={table.thR}>Paid so far</th>
                <th className={table.thR}>Forfeited</th>
                <th className={table.thR}>To vest</th>
              </tr>
            </thead>
            <tbody>
              {r.awards.map((a) => (
                <AwardTr key={`${a.letterId}|${a.year}`} a={a} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Unlettered r={r} />
      <StubOnly r={r} />
    </>
  );
}

function baseTitle(a: AwardRow): string | undefined {
  if (a.base?.from === "STUBS") return `The letter prints no base salary. Base pay on the ${a.year} stubs: ${a.base.parts.map((p) => `${p.employer} ${formatUsdCents(p.cents)}`).join(" + ")}`;
  return a.stubBaseCents != null ? `Regular pay on the ${a.year} stubs: ${formatUsdCents(a.stubBaseCents)}` : undefined;
}

function AwardTr({ a }: { a: AwardRow }) {
  const baseOk = a.baseCents != null && a.stubBaseCents != null && Math.abs(a.baseCents - a.stubBaseCents) <= 100;
  return (
    <tr className={table.tr}>
      <td className={`${table.td} num font-medium`}>
        {a.year}
        {a.partial && (
          <span className="ml-1.5">
            <Badge title="The letter shows only some of this year's payments; the headline bonus is on another letter.">Partial</Badge>
          </span>
        )}
      </td>
      <td className={`${table.td} text-fg-2`}>{a.employer}</td>
      <td className={table.tdR} title={baseTitle(a)}>
        {a.base?.from === "STUBS" ? <ProofValue proof={yearPay(a.personId, a.year, ["base"], a.base.cents)}>{usd0(a.base.cents)}</ProofValue> : usd0(a.base?.cents ?? null)}
        {baseOk && <span className="ml-1 text-pos" aria-label="matches the stubs">✓</span>}
        {a.base?.from === "STUBS" && <div className="text-[11px] text-faint">from stubs{a.base.parts.length > 1 ? `, ${a.base.parts.length} employers` : ""}</div>}
      </td>
      <td className={`${table.tdR} font-semibold`}>
        {usd0(a.totalBonusCents)}
        {a.oneOffCents > 0 && <div className="text-[11px] font-normal text-faint">+ {usd0(a.oneOffCents)} sign-on / make-whole</div>}
      </td>
      <td className={table.tdR} title={a.totalComp?.from === "SUM" ? "Base + headline bonus + sign-on / make-whole (the letter prints no total)" : undefined}>
        {usd0(a.totalComp?.cents ?? null)}
      </td>
      <td className={table.tdR}>
        {usd0(a.upfrontCents)}
        {a.totalBonusCents ? <span className="ml-1 text-[11px] text-faint">{ratio(a.upfrontCents, a.totalBonusCents)}</span> : null}
      </td>
      <td className={table.tdR}>
        {usd0(a.deferredCents + a.planDeferredCents)}
        {a.totalBonusCents ? <span className="ml-1 text-[11px] text-faint">{ratio(a.deferredCents + a.planDeferredCents, a.totalBonusCents)}</span> : null}
        {a.planDeferredCents > 0 && (
          <div className="text-[11px] text-faint" title="Deferred into a deferred compensation plan: paid out under the plan's terms, not on the pay stubs.">
            {usd0(a.planDeferredCents)} to the deferral plan
          </div>
        )}
      </td>
      <td className={`${table.tdR} text-pos`}>{usd0(a.paidCents)}</td>
      <td className={`${table.tdR} ${a.forfeitedCents ? "text-neg" : ""}`}>{usd0(a.forfeitedCents)}</td>
      <td className={`${table.tdR} ${a.outstandingCents ? "text-info" : ""}`}>{usd0(a.outstandingCents)}</td>
    </tr>
  );
}

function Unlettered({ r }: { r: BonusesReport }) {
  if (!r.unlettered.length) return null;
  return (
    <Callout tone="info" title="Bonuses with no letter on file">
      <ul className="mt-1 space-y-0.5">
        {r.unlettered.map((u) => (
          <li key={u.employer}>
            {u.personName} · {u.employer}: <span className="num font-medium text-fg">{usd0(u.cents)}</span> in {u.count} bonus paycheck{u.count === 1 ? "" : "s"}.
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-muted">
        Without the letter, the headline figure and any deferral aren&apos;t known. Add it to <code>data/bonus-awards.json</code> to see its schedule here.
      </p>
    </Callout>
  );
}

/** Base and bonus by year for each person paid by an employer that issues no bonus letters. */
function StubOnly({ r }: { r: BonusesReport }) {
  const people = [...new Set(r.payYears.map((y) => y.personId))];
  const notes = r.stubOnly.filter((s) => s.note).map((s) => `${s.employer}: ${s.note}`);
  return (
    <>
      {people.map((id) => {
        const years = r.payYears.filter((y) => y.personId === id);
        return (
          <Card
            key={id}
            title={`${years[0]!.personName}: base and bonus by year`}
            subtitle={`No bonus letters, so everything here is from the pay stubs: base is regular pay and bonus is the gross bonus paid that year.${notes.length ? ` ${notes.join(" ")}` : ""}`}
          >
            <div className={table.wrap}>
              <table className={table.table}>
                <thead className={table.head}>
                  <tr>
                    <th className={table.th}>Year</th>
                    <th className={table.th}>Employer</th>
                    <th className={table.thR}>Base</th>
                    <th className={table.thR}>Bonus</th>
                    <th className={table.thR}>Total comp</th>
                    <th className={table.thR}>Bonus ÷ base</th>
                  </tr>
                </thead>
                <tbody>
                  {years.map((y) => (
                    <tr key={y.year} className={table.tr}>
                      <td className={`${table.td} num font-medium`}>
                        {y.year}
                        {y.inProgress && (
                          <span className="ml-1.5">
                            <Badge title={`Stubs through ${formatDisplayDateFromYmd(y.last)}`}>so far</Badge>
                          </span>
                        )}
                      </td>
                      <td className={`${table.td} text-fg-2`}>{y.employers.join(", ")}</td>
                      <td className={table.tdR}>
                        <ProofValue proof={yearPay(y.personId, y.year, ["base"], y.baseCents)}>{usd0(y.baseCents)}</ProofValue>
                      </td>
                      <td className={`${table.tdR} font-semibold`}>
                        <ProofValue proof={yearPay(y.personId, y.year, ["bonus"], y.bonusCents)}>{usd0(y.bonusCents)}</ProofValue>
                      </td>
                      <td className={table.tdR}>
                        <ProofValue proof={yearPay(y.personId, y.year, ["base", "bonus"], y.baseCents + y.bonusCents)}>{usd0(y.baseCents + y.bonusCents)}</ProofValue>
                      </td>
                      <td className={`${table.tdR} text-muted`}>{ratio(y.bonusCents, y.baseCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })}
    </>
  );
}

function NoLetters({ r }: { r: BonusesReport }) {
  return (
    <>
      <EmptyState title="No bonus letters on file">
        Add award letters to <code>data/bonus-awards.json</code> (headline bonus, the cash paid up front, each deferred tranche and when it vests). Bonus paychecks from the stubs are listed under Bonus paychecks.
      </EmptyState>
      <Unlettered r={r} />
      <StubOnly r={r} />
    </>
  );
}

function Schedule({ r }: { r: BonusesReport }) {
  if (!r.letters.length) return <NoLetters r={r} />;
  return (
    <>
      {r.letters.map((l) => {
        const windows = r.windows.filter((w) => w.letterId === l.id);
        const awards = r.awards.filter((a) => a.letterId === l.id).sort((a, b) => a.year - b.year);
        const upcoming = awards.flatMap((a) => a.tranches).filter((t) => t.status === "UPCOMING" || t.status === "DUE");
        const forfeited = windows.filter((w) => w.status === "FORFEITED");
        return (
          <div key={l.id} className="flex flex-col gap-4">
            <Card
              title={l.title}
              subtitle={
                l.employment
                  ? `${l.employment.personName}'s ${l.employer} paychecks run ${formatDisplayDateFromYmd(l.employment.first)} – ${formatDisplayDateFromYmd(l.employment.last)}${
                      l.employment.nextEmployer ? `, then ${l.employment.nextEmployer}` : ""
                    }. Each column is one payment date; every amount due then is paid together.`
                  : "No pay stubs from this employer are on file."
              }
            >
              <div className={table.wrap}>
                <table className={table.table}>
                  <thead className={table.head}>
                    <tr>
                      <th className={table.th}>Award</th>
                      <th className={table.thR}>Total</th>
                      {windows.map((w) => (
                        <th key={w.key} className={table.thR}>
                          {w.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {awards.map((a) => (
                      <tr key={a.year} className={table.tr}>
                        <td className={`${table.td} whitespace-nowrap`}>
                          {a.year} bonus{a.partial ? " (part)" : ""}
                        </td>
                        <td className={`${table.tdR} font-medium`}>{usd0(a.upfrontCents + a.deferredCents + a.oneOffCents)}</td>
                        {windows.map((w) => {
                          const ts = a.tranches.filter((t) => t.window === w.key);
                          return (
                            <td key={w.key} className={table.tdR}>
                              {ts.map((t) => (
                                <div key={t.kind} className={STATUS[t.status].cell} title={`${KIND[t.kind].title} · ${STATUS[t.status].label}`}>
                                  {usd0(t.amountCents)}
                                  {KIND[t.kind].tag && <span className="ml-1 text-[10px] uppercase text-faint">{KIND[t.kind].tag}</span>}
                                </div>
                              ))}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                    <tr className="border-t border-line-strong font-semibold">
                      <td className={table.td}>Due</td>
                      <td className={table.tdR}>{usd0(windows.reduce((s, w) => s + w.scheduledCents, 0))}</td>
                      {windows.map((w) => (
                        <td key={w.key} className={table.tdR}>
                          {usd0(w.scheduledCents)}
                        </td>
                      ))}
                    </tr>
                    <tr className={table.tr}>
                      <td className={`${table.td} text-muted`}>On the stubs</td>
                      <td className={table.tdR}>{usd0(windows.reduce((s, w) => s + w.paidCents, 0))}</td>
                      {windows.map((w) => (
                        <td key={w.key} className={table.tdR}>
                          <div>{w.paidCents ? formatUsdCents(w.paidCents) : "—"}</div>
                          <div className="mt-0.5">
                            <StatusBadge s={w.status} title={w.detail} />
                          </div>
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            </Card>

            <div className="grid items-start gap-4 lg:grid-cols-2">
              <Card title="Future vesting dates">
                {upcoming.length ? (
                  <ul className="divide-y divide-line text-sm">
                    {upcoming.map((t) => (
                      <li key={`${t.awardYear}|${t.window}|${t.kind}`} className="flex items-center justify-between gap-3 py-1.5">
                        <span>
                          {t.label} <span className="text-muted">· {t.awardYear} bonus</span>
                        </span>
                        <span className="flex items-center gap-2">
                          <span className="num font-medium">{usd0(t.amountCents)}</span>
                          <StatusBadge s={t.status} />
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-fg-2">
                    Nothing left to vest on this letter.
                    {forfeited.length > 0 && l.employment && (
                      <>
                        {" "}
                        <span className="num font-medium text-neg">{usd0(forfeited.reduce((s, w) => s + w.scheduledCents, 0))}</span> due {forfeited.map((w) => w.label).join(", ")} was forfeited. The last{" "}
                        {l.employer} paycheck was {formatDisplayDateFromYmd(l.employment.last)} and pay moved to {l.employment.nextEmployer} before any of it vested. Under the letter&apos;s
                        terms, leaving forfeits every unvested deferral. Only a termination without cause would have vested it, and no such payout is on the stubs.
                      </>
                    )}
                  </p>
                )}
              </Card>
              <Card title="Payment by payment">
                <ul className="divide-y divide-line text-sm">
                  {windows.map((w) => (
                    <WindowLi key={w.key} w={w} />
                  ))}
                </ul>
              </Card>
            </div>

            {(l.terms || l.notes.length > 0) && (
              <Card title="Terms and notes">
                {l.terms && <p className="text-sm leading-relaxed text-fg-2">{l.terms}</p>}
                {l.notes.length > 0 && (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-fg-2">
                    {l.notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                )}
              </Card>
            )}
          </div>
        );
      })}
    </>
  );
}

function WindowLi({ w }: { w: VestWindow }) {
  const parts = w.parts.map((p) => `${p.awardYear} ${KIND[p.kind].part} ${usd0(p.amountCents)}`).join(" + ");
  return (
    <li className="py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">{w.label}</span>
        <span className="flex items-center gap-2">
          <span className="num">{usd0(w.scheduledCents)}</span>
          <StatusBadge s={w.status} />
        </span>
      </div>
      <div className="mt-0.5 text-xs text-muted">{parts}</div>
      <div className="mt-0.5 text-xs text-fg-2">{w.detail}</div>
    </li>
  );
}

function Payouts({ r }: { r: BonusesReport }) {
  if (!r.payments.length) return <EmptyState title="No bonus paychecks">No pay stub on file has a bonus line.</EmptyState>;
  return (
    <>
      <Card title="Bonus cash by year" subtitle="Every bonus line on the pay stubs, by the year it was paid (a year's bonus is usually paid early the next year).">
        <div className={table.wrap}>
          <table className={table.table}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Paid in</th>
                <th className={table.th}>Person</th>
                <th className={table.th}>Employer</th>
                <th className={table.thR}>Paychecks</th>
                <th className={table.thR}>Bonus paid</th>
                <th className={table.th}>Letter</th>
              </tr>
            </thead>
            <tbody>
              {r.byYear.map((y) => (
                <tr key={`${y.year}|${y.personId}|${y.employer}`} className={table.tr}>
                  <td className={`${table.td} num font-medium`}>{y.year}</td>
                  <td className={table.td}>{y.personName}</td>
                  <td className={`${table.td} text-fg-2`}>{y.employer}</td>
                  <td className={table.tdR}>{y.payments}</td>
                  <td className={`${table.tdR} font-medium`}>
                    <ProofValue
                      proof={{
                        descriptor: { report: "pay", basis: "paid", personId: y.personId, employerKeys: y.employerKeys, lines: ["bonus"], start: `${y.year}-01-01`, end: `${y.year}-12-31` },
                        shownCents: y.cents,
                      }}
                    >
                      {formatUsdCents(y.cents)}
                    </ProofValue>
                  </td>
                  <td className={table.td}>
                    {y.explainedCents === y.cents ? (
                      <Badge tone="pos">On a letter</Badge>
                    ) : y.explainedCents ? (
                      <Badge tone="warn" title={`${formatUsdCents(y.explainedCents)} of it is a payment on a letter; the rest isn't on any letter on file.`}>
                        Partly
                      </Badge>
                    ) : r.stubOnly.some((s) => s.employer === y.employer) ? (
                      <Badge title="This employer doesn't issue bonus letters; the gross on the stubs is the whole bonus.">Stubs only</Badge>
                    ) : (
                      <Badge>None</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Every bonus paycheck" subtitle="Which letter payment each one is, where a letter explains it.">
        <div className={table.wrap}>
          <table className={table.table}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Date</th>
                <th className={table.th}>Person</th>
                <th className={table.th}>Employer</th>
                <th className={table.th}>Stub line</th>
                <th className={table.thR}>Amount</th>
                <th className={table.th}>Pays</th>
              </tr>
            </thead>
            <tbody>
              {[...r.payments].reverse().map((p) => (
                <tr key={`${p.stubId}|${p.line}`} className={table.trHover}>
                  <td className={`${table.td} num whitespace-nowrap`}>{formatDisplayDateFromYmd(p.date)}</td>
                  <td className={table.td}>{p.personName}</td>
                  <td className={`${table.td} text-fg-2`}>{p.employer}</td>
                  <td className={`${table.td} text-muted`} title={p.document}>
                    {p.line}
                  </td>
                  <td className={`${table.tdR} font-medium`}>{formatUsdCents(p.amountCents)}</td>
                  <td className={table.td}>{p.explains ? <span className="text-fg-2">{p.explains.window} payment</span> : <span className="text-faint">No letter on file</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
