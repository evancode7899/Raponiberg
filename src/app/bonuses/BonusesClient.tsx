"use client";

import { compositeOf } from "@/components/ui/proof/context";
import { BlockedNote, BlockedValue } from "@/components/ledger/Blocked";
import { ApiSecretField } from "@/components/ledger/LedgerBits";
import { cachedResponse, useApi } from "@/components/ledger/useApi";
import { Badge, btn, Callout, Card, EmptyState, ErrorNote, Loading, PageBody, StatCell, StatGrid, table, Tabs, useTabParam, type Tone } from "@/components/ui/kit";
import { ProofValue, type FigureProps } from "@/components/ui/proof/ProofValue";
import type { ProofTarget } from "@/components/ui/proof/context";
import type { PaymentKind } from "@/lib/bonuses/awardStore";
import type { AwardMeasure, BonusesDescriptor } from "@/lib/book/proof/bonusesProof";
import type { PayLine } from "@/lib/book/proof/payProof";
import type { AwardRow, BonusesReport, BonusPayment, BonusWarning, Tranche, VestWindow, WindowStatus } from "@/lib/book/reports/bonuses";
import { estimateDescriptor, expectedBonuses, figureReads, paidYearDescriptor, stubPayFigure, yearPayDescriptor } from "@/lib/book/reports/bonusFigures";
import { formatDisplayDateFromYmd } from "@/lib/displayTime";
import { buildForecast } from "@/lib/forecast/forecast";
import type { ForecastData } from "@/lib/forecast/load";
import { formatPercentRatio, formatUsdCents, usd0 } from "@/lib/formatMoney";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

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
const yearPay = (asOf: string, personId: string, year: number, lines: PayLine[], cents: number) => ({ descriptor: yearPayDescriptor(personId, year, lines, asOf), shownCents: cents });

/** A Bonuses figure's proof (lib/book/proof/bonusesProof.ts), re-derived through the same report. */
type Fig = BonusesDescriptor extends infer D ? (D extends { report: "bonuses" } ? Omit<D, "report"> : never) : never;
const bon = (d: Fig, cents: number): ProofTarget => ({ descriptor: { report: "bonuses", ...d } as BonusesDescriptor, shownCents: cents });

/** The report the figures below are read from: what a pay finding withholds (figureReads, the rule their proofs use). */
const Report = createContext<BonusesReport | null>(null);
const heldBy = (r: BonusesReport | null, proof: ProofTarget) => {
  const d = proof.descriptor as BonusesDescriptor;
  return r && d.report === "bonuses" && d.figure !== "estimate" ? figureReads(r, d).blockers : [];
};

/** A Bonuses figure: its proof, or "missing data" with the finding when one withholds it. */
function BonusValue({ proof, children, drawn }: { proof: ProofTarget; children: ReactNode; drawn?: FigureProps["drawn"] }) {
  const held = heldBy(useContext(Report), proof);
  return held.length ? <BlockedValue blockers={held} /> : <ProofValue proof={proof} drawn={drawn}>{children}</ProofValue>;
}
const awardProof = (a: AwardRow, measure: AwardMeasure, cents: number) => bon({ figure: "award", letterId: a.letterId, year: a.year, measure }, cents);
const trancheProof = (a: AwardRow, t: Tranche) => bon({ figure: "tranche", letterId: a.letterId, year: a.year, window: t.window, kind: t.kind }, t.amountCents);
const windowProof = (w: VestWindow, measure: "scheduled" | "paid") => bon({ figure: "window", window: w.key, measure }, measure === "paid" ? w.paidCents : w.scheduledCents);
/** One stub date's bonus lines from one employer (the page shows the line; the proof re-adds the day). */
const stubPay = (p: BonusPayment, all: BonusPayment[]): ProofTarget => {
  const f = stubPayFigure(p, all);
  return { descriptor: f.descriptor, shownCents: f.cents };
};

export function BonusesClient({ requiresApiSecret }: { requiresApiSecret: boolean }) {
  const api = useApi(requiresApiSecret);
  const [tab, setTab] = useTabParam(TABS, "overview");
  const [r, setReport] = useState<BonusesReport | null>(() => cachedResponse<{ report: BonusesReport }>("/api/bonuses")?.report ?? null);
  const [error, setError] = useState<string | null>(null);
  const [fdata, setForecastData] = useState<ForecastData | null>(() => cachedResponse<ForecastData>("/api/forecast") ?? null);

  useEffect(() => {
    if (!api.ready) return;
    api
      .call<{ report: BonusesReport }>("/api/bonuses")
      .then((d) => setReport(d.report))
      .catch((e: Error) => setError(e.message));
    // The forecast's estimated bonuses (Overview): the page shows none if it can't be built.
    api
      .call<ForecastData>("/api/forecast")
      .then(setForecastData)
      .catch(() => setForecastData(null));
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
            <Report.Provider value={r}>
              {tab === "overview" && <Overview r={r} fdata={fdata} />}
              {tab === "schedule" && <Schedule r={r} />}
              {tab === "payouts" && <Payouts r={r} />}
            </Report.Provider>
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

function Overview({ r, fdata }: { r: BonusesReport; fdata: ForecastData | null }) {
  const t = r.totals;
  if (!r.awards.length) return <NoLetters r={r} fdata={fdata} />;
  const fullYears = r.awards.filter((a) => !a.partial).map((a) => a.year);
  // A total a pay finding withholds shows as withheld (figureReads): the tile withholds it itself.
  const total = (measure: string, cents: number) => {
    const proof = bon({ figure: "totals", measure } as Fig, cents);
    return { value: usd0(cents), proof, blockers: heldBy(r, proof) };
  };
  return (
    <>
      <StatGrid cols={6}>
        <StatCell
          label="Headline bonuses"
          {...total("headline", t.headlineCents)}
          sub={`${fullYears.length} year${fullYears.length === 1 ? "" : "s"} on letters (${[...fullYears].sort().join(", ")})`}
        />
        <StatCell label="Paid up front" {...total("upfront", t.upfrontCents)} sub={<><ProofValue proof={compositeOf("share", [total("upfront", t.upfrontCents).proof, total("headline", t.headlineCents).proof], { ratio: t.headlineCents ? t.upfrontCents / t.headlineCents : 0 })}>{ratio(t.upfrontCents, t.headlineCents)}</ProofValue> of headline</>} />
        <StatCell label="Deferred" {...total("deferred", t.deferredCents)} sub={<><ProofValue proof={compositeOf("share", [total("deferred", t.deferredCents).proof, total("headline", t.headlineCents).proof], { ratio: t.headlineCents ? t.deferredCents / t.headlineCents : 0 })}>{ratio(t.deferredCents, t.headlineCents)}</ProofValue> of headline</>} />
        <StatCell
          label="Deferred paid out"
          {...total("deferredPaid", t.deferredPaidCents)}
          tone={t.deferredPaidCents ? "pos" : "neutral"}
          sub={`${ratio(t.deferredPaidCents, t.deferredCents)} of deferred`}
        />
        <StatCell
          label="Forfeited"
          {...total("forfeited", t.forfeitedCents)}
          tone={t.forfeitedCents ? "neg" : "neutral"}
          sub={`${ratio(t.forfeitedCents, t.deferredCents)} of deferred`}
        />
        <StatCell
          label="Still to vest"
          {...total("outstanding", t.outstandingCents)}
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
                <AwardTr key={`${a.letterId}|${a.year}`} a={a} asOf={r.today} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Unlettered r={r} />
      <StubOnly r={r} />
      <Expected fdata={fdata} />
    </>
  );
}

function baseTitle(a: AwardRow): string | undefined {
  if (a.base?.from === "STUBS") return `The letter prints no base salary. Base pay on the ${a.year} stubs: ${a.base.parts.map((p) => `${p.employer} ${formatUsdCents(p.cents)}`).join(" + ")}`;
  return a.stubBaseCents != null ? `Regular pay on the ${a.year} stubs: ${formatUsdCents(a.stubBaseCents)}` : undefined;
}

function AwardTr({ a, asOf }: { a: AwardRow; asOf: string }) {
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
        {a.base?.from === "STUBS" ? (
          a.base.blockers?.length ? <BlockedValue blockers={a.base.blockers} /> : <ProofValue proof={yearPay(asOf, a.personId, a.year, ["base"], a.base.cents)}>{usd0(a.base.cents)}</ProofValue>
        ) : a.base ? (
          <BonusValue proof={awardProof(a, "base", a.base.cents)}>{usd0(a.base.cents)}</BonusValue>
        ) : (
          usd0(null)
        )}
        {baseOk && <span className="ml-1 text-pos" aria-label="matches the stubs">✓</span>}
        {a.base?.from === "STUBS" && <div className="text-[11px] text-faint">from stubs{a.base.parts.length > 1 ? `, ${a.base.parts.length} employers` : ""}</div>}
      </td>
      <td className={`${table.tdR} font-semibold`}>
        {a.totalBonusCents != null ? <BonusValue proof={awardProof(a, "headline", a.totalBonusCents)}>{usd0(a.totalBonusCents)}</BonusValue> : usd0(null)}
        {a.oneOffCents > 0 && (
          <div className="text-[11px] font-normal text-faint">
            + <BonusValue proof={awardProof(a, "oneOff", a.oneOffCents)}>{usd0(a.oneOffCents)}</BonusValue> sign-on / make-whole
          </div>
        )}
      </td>
      <td className={table.tdR} title={a.totalComp?.from === "SUM" ? "Base + headline bonus + sign-on / make-whole (the letter prints no total)" : undefined}>
        {a.totalComp ? <BonusValue proof={awardProof(a, "totalComp", a.totalComp.cents)}>{usd0(a.totalComp.cents)}</BonusValue> : usd0(null)}
      </td>
      <td className={table.tdR}>
        <BonusValue proof={awardProof(a, "upfront", a.upfrontCents)}>{usd0(a.upfrontCents)}</BonusValue>
        {a.totalBonusCents ? <span className="ml-1 text-[11px] text-faint"><ProofValue proof={compositeOf("share", [awardProof(a, "upfront", a.upfrontCents), awardProof(a, "headline", a.totalBonusCents)], { ratio: a.upfrontCents / a.totalBonusCents })}>{ratio(a.upfrontCents, a.totalBonusCents)}</ProofValue></span> : null}
      </td>
      <td className={table.tdR}>
        <BonusValue proof={awardProof(a, "deferred", a.deferredCents + a.planDeferredCents)}>{usd0(a.deferredCents + a.planDeferredCents)}</BonusValue>
        {a.totalBonusCents ? <span className="ml-1 text-[11px] text-faint"><ProofValue proof={compositeOf("share", [awardProof(a, "deferred", a.deferredCents + a.planDeferredCents), awardProof(a, "headline", a.totalBonusCents)], { ratio: (a.deferredCents + a.planDeferredCents) / a.totalBonusCents })}>{ratio(a.deferredCents + a.planDeferredCents, a.totalBonusCents)}</ProofValue></span> : null}
        {a.planDeferredCents > 0 && (
          <div className="text-[11px] text-faint" title="Deferred into a deferred compensation plan: paid out under the plan's terms, not on the pay stubs.">
            <BonusValue proof={awardProof(a, "planDeferred", a.planDeferredCents)}>{usd0(a.planDeferredCents)}</BonusValue> to the deferral plan
          </div>
        )}
      </td>
      <td className={`${table.tdR} text-pos`}>
        <BonusValue proof={awardProof(a, "paid", a.paidCents)}>{usd0(a.paidCents)}</BonusValue>
      </td>
      <td className={`${table.tdR} ${a.forfeitedCents ? "text-neg" : ""}`}>
        <BonusValue proof={awardProof(a, "forfeited", a.forfeitedCents)}>{usd0(a.forfeitedCents)}</BonusValue>
      </td>
      <td className={`${table.tdR} ${a.outstandingCents ? "text-info" : ""}`}>
        <BonusValue proof={awardProof(a, "outstanding", a.outstandingCents)}>{usd0(a.outstandingCents)}</BonusValue>
      </td>
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
                        <ProofValue proof={yearPay(r.today, y.personId, y.year, ["base"], y.baseCents)}>{usd0(y.baseCents)}</ProofValue>
                      </td>
                      <td className={`${table.tdR} font-semibold`}>
                        <ProofValue proof={yearPay(r.today, y.personId, y.year, ["bonus"], y.bonusCents)}>{usd0(y.bonusCents)}</ProofValue>
                      </td>
                      <td className={table.tdR}>
                        <ProofValue proof={yearPay(r.today, y.personId, y.year, ["base", "bonus"], y.baseCents + y.bonusCents)}>{usd0(y.baseCents + y.bonusCents)}</ProofValue>
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

function NoLetters({ r, fdata }: { r: BonusesReport; fdata: ForecastData | null }) {
  return (
    <>
      <EmptyState title="No bonus letters on file">
        Add award letters to <code>data/bonus-awards.json</code> (headline bonus, the cash paid up front, each deferred tranche and when it vests). Bonus paychecks from the stubs are listed under Bonus paychecks.
      </EmptyState>
      <Unlettered r={r} />
      <StubOnly r={r} />
      <Expected fdata={fdata} />
    </>
  );
}

/**
 * Each person's next award the forecast expects but no letter or stub shows yet, part by
 * part: the forecast on the saved assumptions (lib/forecast), as the Forecast page runs it.
 */
function Expected({ fdata }: { fdata: ForecastData | null }) {
  const next = useMemo(() => {
    const seeds = fdata?.profile.seeds;
    if (!fdata || !seeds) return [];
    return expectedBonuses(buildForecast({ seeds, bonusFacts: fdata.bonusFacts }, fdata.profile.settings.outlook));
  }, [fdata]);
  if (!next.length) return null;
  return (
    <Card title="Next award the forecast expects" subtitle="No letter or pay stub shows these yet: a share of base pay read off past bonuses (or set on the Forecast page), paid on the pattern of the latest letter.">
      <ul className="divide-y divide-line text-sm">
        {next.map((b) => (
          <li key={`${b.personId}|${b.key}|${b.label}`} className="flex items-center justify-between gap-3 py-1.5">
            <span>
              {b.personName} · {b.label} <span className="text-muted">· {b.key}</span>
              {!b.counted && b.why && <span className="block text-xs text-faint">Not counted in the forecast: {b.why}</span>}
            </span>
            <span className="num font-medium">
              <BonusValue proof={{ descriptor: estimateDescriptor(b), shownCents: b.gross }}>{usd0(b.gross)}</BonusValue>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Schedule({ r }: { r: BonusesReport }) {
  if (!r.letters.length) return <NoLetters r={r} fdata={null} />;
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
                        <td className={`${table.tdR} font-medium`}><BonusValue proof={awardProof(a, "scheduled", a.upfrontCents + a.deferredCents + a.oneOffCents)}>{usd0(a.upfrontCents + a.deferredCents + a.oneOffCents)}</BonusValue></td>
                        {windows.map((w) => {
                          const ts = a.tranches.filter((t) => t.window === w.key);
                          return (
                            <td key={w.key} className={table.tdR}>
                              {ts.map((t) => (
                                <div key={t.kind} className={STATUS[t.status].cell} title={`${KIND[t.kind].title} · ${STATUS[t.status].label}`}>
                                  <BonusValue proof={trancheProof(a, t)}>{usd0(t.amountCents)}</BonusValue>
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
                      <td className={table.tdR}><BonusValue proof={bon({ figure: "letter", letterId: l.id, measure: "scheduled" }, l.windowTotals.scheduledCents)}>{usd0(l.windowTotals.scheduledCents)}</BonusValue></td>
                      {windows.map((w) => (
                        <td key={w.key} className={table.tdR}>
                          <BonusValue proof={windowProof(w, "scheduled")}>{usd0(w.scheduledCents)}</BonusValue>
                        </td>
                      ))}
                    </tr>
                    <tr className={table.tr}>
                      <td className={`${table.td} text-muted`}>On the stubs</td>
                      <td className={table.tdR}><BonusValue proof={bon({ figure: "letter", letterId: l.id, measure: "paid" }, l.windowTotals.paidCents)}>{usd0(l.windowTotals.paidCents)}</BonusValue></td>
                      {windows.map((w) => (
                        <td key={w.key} className={table.tdR}>
                          <div>{w.paidCents ? <BonusValue proof={windowProof(w, "paid")}>{formatUsdCents(w.paidCents)}</BonusValue> : "—"}</div>
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
                          <span className="num font-medium"><BonusValue proof={trancheProof(awards.find((a) => a.year === t.awardYear)!, t)}>{usd0(t.amountCents)}</BonusValue></span>
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
                        <span className="num font-medium text-neg">{usd0(l.windowTotals.forfeitedCents)}</span> due {forfeited.map((w) => w.label).join(", ")} was forfeited. The last{" "}
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
  // Each part is its award's tranche; what was paid is the window's own figure.
  const parts = w.parts.map((p, i) => (
    <span key={i}>
      {i ? " + " : ""}
      {p.awardYear} {KIND[p.kind].part} <BonusValue proof={bon({ figure: "tranche", letterId: w.letterId, year: p.awardYear, window: w.key, kind: p.kind } as Fig, p.amountCents)}>{usd0(p.amountCents)}</BonusValue>
    </span>
  ));
  const diff = w.paidCents - w.scheduledCents;
  const paid = w.payments.length ? (
    <>
      Paid {w.payments.map((p) => p.date).join(" + ")} (<BonusValue proof={windowProof(w, "paid")}>{usd0(w.paidCents)}</BonusValue>)
      {diff ? (
        <>
          , <ProofValue proof={compositeOf("diff", [windowProof(w, "paid"), windowProof(w, "scheduled")], { cents: diff })}>{`${diff > 0 ? "+" : "−"}${usd0(Math.abs(diff))}`}</ProofValue> vs the letter.
        </>
      ) : (
        ", exactly as scheduled."
      )}
    </>
  ) : (
    w.detail
  );
  return (
    <li className="py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">{w.label}</span>
        <span className="flex items-center gap-2">
          <span className="num"><BonusValue proof={windowProof(w, "scheduled")}>{usd0(w.scheduledCents)}</BonusValue></span>
          <StatusBadge s={w.status} />
        </span>
      </div>
      <div className="mt-0.5 text-xs text-muted">{parts}</div>
      <div className="mt-0.5 text-xs text-fg-2">{paid}</div>
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
                  <td className={`${table.td} num font-medium`}>
                    {y.year}
                    {y.through && (
                      <div className="text-[11px] font-normal text-muted" title="A later paycheck has no stub yet: the year counts through the day before it.">
                        through {formatDisplayDateFromYmd(y.through)}
                      </div>
                    )}
                  </td>
                  <td className={table.td}>{y.personName}</td>
                  <td className={`${table.td} text-fg-2`}>{y.employer}</td>
                  <td className={table.tdR}>{y.payments}</td>
                  <td className={`${table.tdR} font-medium`}>
                    {/* The year's stubs from the employer, to date: a missing one could hide a bonus paid. */}
                    {y.blockers.length ? (
                      <BlockedValue blockers={y.blockers} />
                    ) : (
                      <ProofValue
                        proof={{
                          descriptor: paidYearDescriptor(y, r.today),
                          shownCents: y.cents,
                        }}
                      >
                        {formatUsdCents(y.cents)}
                      </ProofValue>
                    )}
                  </td>
                  <td className={table.td}>
                    <BonusValue proof={bon({ figure: "reconcile", year: y.year, personId: y.personId, employer: y.employer }, y.explainedCents)} drawn="words">
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
                    </BonusValue>
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
                  <td className={`${table.tdR} font-medium`}>
                    <ProofValue proof={stubPay(p, r.payments)}>{formatUsdCents(p.amountCents)}</ProofValue>
                  </td>
                  <td className={table.td}>
                    {p.explains ? <PaysCell p={p} r={r} /> : <span className="text-faint">No letter on file</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

/** The letter payment a bonus paycheck pays: opens that payment date as the stubs paid it. */
function PaysCell({ p, r }: { p: BonusPayment; r: BonusesReport }) {
  const w = r.windows.find((x) => x.payments.some((q) => q.stubId === p.stubId && q.line === p.line));
  const text = <span className="text-fg-2">{p.explains!.window} payment</span>;
  return w ? <BonusValue proof={windowProof(w, "paid")} drawn="words">{text}</BonusValue> : text;
}
