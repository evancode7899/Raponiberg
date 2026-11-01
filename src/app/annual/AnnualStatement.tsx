"use client";

import { BlockedNote, BlockedValue } from "@/components/ledger/Blocked";
import { Card, QualityBadge } from "@/components/ledger/LedgerBits";
import { Badge, Segmented, StatCell, StatGrid } from "@/components/ui/kit";
import type { ProofTarget } from "@/components/ui/proof/context";
import type { AnnualBridgeLine, AnnualCashLine, AnnualDescriptor, AnnualNetWorthLine } from "@/lib/book/proof/annualProof";
import type { PayLine } from "@/lib/book/proof/payProof";
import type { BlockerRef } from "@/lib/book/reports/blockerRef";
import type { CashWaterfall } from "@/lib/profile/annualMath";
import type { AnnualProfileReport, PersonYear, YearCash, YearNetWorth, YearProfile } from "@/lib/profile/buildAnnualProfile";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { estimateFigures, type EstimateValue, type YearEstimate } from "./estimate";
import { NetWorthWaterfall } from "./NetWorthWaterfall";
import { blockedCell, pct, usd, YearTable, type Cell, type TableRow } from "./profileUi";
import { isUnswept, noFigure, unswept } from "@/lib/book/proof/clearance";
import { compositeOf } from "@/components/ui/proof/context";
import { annualPayDescriptor } from "@/lib/profile/annualPay";

/** A figure that opens its annual proof (shown: the proof's own figure, for the drawer's stale-data warning). */
const proofOf = (descriptor: AnnualDescriptor, shown: number | null): ProofTarget => ({ descriptor, shownCents: shown });
const cashP = (y: YearProfile, line: AnnualCashLine, shown: number | null) => proofOf({ report: "annual", figure: "cash", year: y.year, line }, shown);
const nwP = (y: YearProfile, line: AnnualNetWorthLine, shown: number | null) => proofOf({ report: "annual", figure: "net-worth", year: y.year, line }, shown);

/**
 * A line of the estimate column, from the one list the proof sweep enumerates
 * (lib/profile/yearEstimate.ts estimateFigures): the value and its proof, or blank where
 * the estimate doesn't model the line.
 */
const estFigs = new WeakMap<YearEstimate, Record<string, EstimateValue>>();
function estV(e: YearEstimate, line: string, extra: { title?: string } = {}): V {
  let figs = estFigs.get(e);
  if (!figs) estFigs.set(e, (figs = estimateFigures(e)));
  const v = figs[line];
  if (!v) return null;
  const proof: ProofTarget = { descriptor: { report: "planning", page: "annual-estimate", line }, shownCents: "cents" in v ? v.cents : null, ...("cents" in v ? {} : { shown: v }) };
  return { v: "cents" in v ? v.cents : "ratio" in v ? v.ratio : Number(v.text), proof, ...extra };
}
const bridgeP = (y: YearProfile, line: AnnualBridgeLine, shown: number) => proofOf({ report: "annual", figure: "bridge", year: y.year, line }, shown);
// A partner's merge year: the checks paid from the merge on, not the stub's year to date.
const payP = (y: YearProfile, p: PersonYear, line: PayLine, shown: number): ProofTarget => ({ descriptor: annualPayDescriptor(y, p, line), shownCents: shown });

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (iso: string) => `${SHORT_MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

/** One column of the statement: a calendar year (or the year to date) from the profile, or the year in progress estimated whole. */
export type Col = {
  key: string;
  head: string;
  sub: string;
  y: YearProfile | null;
  est: YearEstimate | null;
  /** The column a change is measured against (the previous full year); null = not compared. */
  prev: number | null;
};

/** A cell's figure: a number (as shown — "less" lines negative), a section that can't be proven, or nothing. */
type V = { v: number; proof?: ProofTarget; title?: string; after?: ReactNode } | { blocked: BlockerRef[] } | null;

type Line = {
  label: ReactNode;
  help?: string;
  total?: boolean;
  strong?: boolean;
  indent?: boolean;
  muted?: boolean;
  fmt?: "usd" | "pct" | "plain";
  /** Which way a change is good: "up" (default), "down", or none (ages, opening balances). */
  good?: "up" | "down" | null;
  /** The estimate holds only the year to date for this line: shown, never compared. */
  estPartial?: boolean;
  get: (c: Col) => V;
};

/** Withheld with the findings behind it; a section with nothing blocking it (the first year's change) is just blank. */
/** The partners named when the merge falls inside the years shown (a merge before the first statement changes nothing here). */
export function mergedPartner(r: AnnualProfileReport): string | null {
  if (r.persons.length < 2 || !r.mergeDate || !r.years.length || Number(r.mergeDate.slice(0, 4)) < r.years[0]!.year) return null;
  return r.persons.slice(1).map((p) => p.name).join(" & ");
}

const blocked = (bs: BlockerRef[]): V => (bs.length ? { blocked: bs } : null);
const unique = (bs: BlockerRef[]) => [...new Map(bs.map((b) => [b.id, b])).values()];

/** Columns: every calendar year, the year to date, then (when the forecast runs) the year in progress estimated whole. */
export function statementColumns(r: AnnualProfileReport, est: YearEstimate | null): Col[] {
  const mergeYear = mergedPartner(r) ? Number(r.mergeDate.slice(0, 4)) : -Infinity;
  const cols: Col[] = [];
  let lastFull: number | null = null;
  for (const y of r.years) {
    const sub = y.isCurrent
      ? `through ${shortDate(y.asOf)}`
      : y.year < mergeYear
        ? "pre-merge"
        : y.year === mergeYear
          ? `merged ${shortDate(r.mergeDate)}`
          : "";
    cols.push({ key: String(y.year) + (y.isCurrent ? "-ytd" : ""), head: y.isCurrent ? `${y.year} YTD` : String(y.year), sub, y, est: null, prev: y.isCurrent ? null : lastFull });
    if (!y.isCurrent) lastFull = cols.length - 1;
  }
  if (est) cols.push({ key: `${est.year}-est`, head: `${est.year} est.`, sub: `+ ${est.restFrom}–Dec forecast`, y: null, est, prev: lastFull });
  return cols;
}

export function AnnualStatement({ r, est }: { r: AnnualProfileReport; est: YearEstimate | null }) {
  const ys = r.years;
  const full = [...ys].reverse().find((y) => !y.isCurrent);
  const cur = ys.find((y) => y.isCurrent);
  const latest = cur ?? full;
  const [mode, setMode] = useState<"amounts" | "change">("amounts");
  const cols = useMemo(() => statementColumns(r, est), [r, est]);
  const rows = useMemo(() => statementRows(r, cols, mode), [r, cols, mode]);
  const value = (v: number | null | undefined, blockers: BlockerRef[] | undefined, fmt: (n: number) => string = (n) => usd(n)) =>
    v != null ? fmt(v) : blockers?.length ? <BlockedValue blockers={blockers} /> : "—";
  const blockedYears = ys.filter((y) => Object.values(y.blockers).some((b) => b.length > 0));
  const highlight = cols.map((c, i) => (c.y?.isCurrent || c.est ? i : -1)).filter((i) => i >= 0);
  const projected = cols.map((c, i) => (c.est ? i : -1)).filter((i) => i >= 0);
  const estChangeV = est ? estV(est, "change") : null;

  return (
    <div className="flex flex-col gap-4">
      {blockedYears.length > 0 && full && (
        <BlockedNote
          what={`every figure for ${full.year}`}
          blockers={unique([...full.blockers.pay, ...full.blockers.cash, ...full.blockers.netWorth, ...full.blockers.change])}
        />
      )}
      <StatGrid cols={6}>
        <StatCell
          label="Net worth"
          value={value(latest?.netWorth?.netWorth, latest?.blockers.netWorth)}
          proof={latest?.netWorth ? nwP(latest, "net-worth", latest.netWorth.netWorth) : noFigure("no year with a proven net worth")}
          sub={
            <>
              {latest ? `as of ${latest.netWorthAsOf}` : ""}
              {latest?.netWorth && <QualityBadge quality={latest.netWorth.quality} />}
            </>
          }
        />
        <StatCell
          label={`Change ${cur ? `${cur.year} YTD` : ""}`}
          value={value(cur?.change?.cents, cur?.blockers.change)}
          proof={cur?.change ? nwP(cur, "change", cur.change.cents) : noFigure("no proven change this year")}
          sub={cur?.change?.pct != null ? `${pct(cur.change.pct)} since Dec 31` : undefined}
        />
        <StatCell
          proof={estChangeV && "proof" in estChangeV && estChangeV.proof ? estChangeV.proof : noFigure("needs a proven starting point")}
          label={est ? `Change ${est.year} est.` : "Change, full year est."}
          value={estChangeV && "v" in estChangeV ? usd(estChangeV.v) : "—"}
          sub={est?.flows.close ? `≈ ${usd(est.flows.close.netWorth)} on Dec 31` : "needs a proven starting point"}
        />
        <StatCell
          label={`Saved incl. ret. ${full?.year ?? ""}`}
          value={value(full?.cash?.waterfall.saved, full?.blockers.cash)}
          proof={full?.cash ? cashP(full, "saved", full.cash.waterfall.saved) : noFigure("no year with proven cash")}
          sub={
            full?.cash
              ? `${pct(full.cash.waterfall.savingsOfGross)} of gross${est?.flows.saved != null ? ` · ${est.year} est. ${usd(est.flows.saved)}` : ""}`
              : undefined
          }
        />
        <StatCell
          label={`Living cost ${full?.year ?? ""}`}
          value={value(full?.cash?.waterfall.living, full?.blockers.cash)}
          proof={full?.cash ? cashP(full, "living", full.cash.waterfall.living) : noFigure("no year with proven cash")}
          sub={est?.flows.living != null ? `${est.year} est. ${usd(est.flows.living + (est.flows.bonusSpent ?? 0))}` : cur?.cash ? `${usd(cur.cash.waterfall.living)} so far in ${cur.year}` : undefined}
        />
        <StatCell
          label={`Cash tax rate ${full?.year ?? ""}`}
          value={value(full?.cash?.waterfall.cashTaxRate, full?.blockers.cash, (n) => pct(n))}
          proof={full?.cash ? cashP(full, "tax-rate", null) : noFigure("no year with proven cash")}
          sub="withheld + paid − refunds, ÷ gross"
        />
      </StatGrid>

      <Card
        title="Year by year"
        subtitle="Cash paid and kept → net worth at year end → what moved it. From pay stubs and statements that pass every check; click a figure for its proof."
        actions={
          <Segmented view
            ariaLabel="Show"
            size="xs"
            value={mode}
            onChange={setMode}
            options={[
              { value: "amounts", label: "Amounts" },
              { value: "change", label: "Change vs. prior year", title: "Each full year against the one before; the estimate against the last full year" },
            ]}
          />
        }
      >
        <YearTable
          columns={cols.map((c) => (
            <div key={c.key} className="leading-tight">
              {c.head}
              <div className="mt-0.5 text-[10px] font-normal normal-case tracking-normal text-faint">{c.sub || " "}</div>
            </div>
          ))}
          rows={rows}
          highlight={highlight}
          projected={projected}
        />
        <Footnotes r={r} est={est} />
      </Card>

      <NetWorthWaterfall r={r} cols={cols} />
      <LivingBreakdown years={ys} />
    </div>
  );
}

function Footnotes({ r, est }: { r: AnnualProfileReport; est: YearEstimate | null }) {
  const cur = r.years.find((y) => y.isCurrent);
  const partials = r.years.flatMap((y) => (y.people ?? []).flatMap((p) => p.partial.map((note) => ({ key: `${y.year}-${note}`, text: `${y.label}: ${note}` }))));
  const partner = mergedPartner(r);
  return (
    <ul className="mt-3 flex flex-col gap-0.5 text-[11px] text-muted">
      {partner && r.view === "STRICT" && (
        <li>
          Finances merged {r.mergeDate}. Before then nothing of {partner}&apos;s is shown: not their pay, nor their own accounts, which join net worth with what they held on the merge
          date. What {partner} paid into your accounts before it was their share of rent and cards: a credit against spending, here as on Cash flow and Net worth. (Settings › Household switches to pro forma.)
        </li>
      )}
      {partner && r.view === "PRO_FORMA" && (
        <li>
          Pro forma: counted as if finances had merged all along (they merged {r.mergeDate}). {partner}&apos;s pay into their own accounts is taken back out above net cash, and what they
          moved in shows as outside money. (Settings › Household switches to counting from the merge.)
        </li>
      )}
      {cur && (
        <li>
          {cur.label}: cash through {cur.asOf} (the last day every bank and card statement covers); net worth as of {cur.netWorthAsOf}.
        </li>
      )}
      {est && (
        <li>
          {est.year} est.: actual through {est.ytd.asOf}, then the{" "}
          <Link href="/forecast" className="text-accent hover:underline">
            forecast
          </Link>{" "}
          for {est.restFrom}–Dec (base pay, expected bonuses, living cost, returns). Detail lines it doesn&apos;t model are left blank.
        </li>
      )}
      {partials.map((p) => (
        <li key={p.key}>{p.text}</li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ rows

function statementRows(r: AnnualProfileReport, cols: Col[], mode: "amounts" | "change"): TableRow[] {
  const persons = r.persons;
  const lines: (Line | { heading: string; sub?: string })[] = [];
  const person = (y: YearProfile, id: string) => y.people?.find((p) => p.personId === id);

  // Each section: the year's figure when proven, the estimate's when it models it, else blank.
  const cash = (c: Col, fn: (w: CashWaterfall, cash: YearCash, y: YearProfile) => V, est?: (e: YearEstimate) => V): V =>
    c.y ? (c.y.cash ? fn(c.y.cash.waterfall, c.y.cash, c.y) : blocked(c.y.blockers.cash)) : c.est && est ? est(c.est) : null;
  const pay = (c: Col, fn: (y: YearProfile) => V): V => (c.y ? (c.y.people ? fn(c.y) : blocked(c.y.blockers.pay)) : null);
  const nw = (c: Col, fn: (n: YearNetWorth, y: YearProfile) => V, est?: (e: YearEstimate) => V): V =>
    c.y ? (c.y.netWorth ? fn(c.y.netWorth, c.y) : blocked(c.y.blockers.netWorth)) : c.est && est ? est(c.est) : null;
  const bridgeBlockers = (y: YearProfile) => unique([...y.blockers.cash, ...y.blockers.change]);
  const bridge = (c: Col, k: Exclude<AnnualBridgeLine, "total"> | "total"): V =>
    c.y ? (c.y.bridge ? { v: c.y.bridge[k], proof: bridgeP(c.y, k, c.y.bridge[k]) } : blocked(bridgeBlockers(c.y))) : c.est ? estV(c.est, `bridge:${k}`) : null;
  const any = (fn: (c: Col) => V) => cols.some((c) => {
    const v = fn(c);
    return v != null && "v" in v && v.v !== 0;
  });
  const taxesAndDeductions = (w: CashWaterfall) => w.withholding + w.additionalTaxes - w.refunds + w.otherDeductions;

  // ------------------------------------------------------------ people
  for (const p of persons.filter((p) => r.years.some((y) => person(y, p.id)?.age != null)))
    lines.push({
      label: `Age — ${p.name}`,
      muted: true,
      fmt: "plain",
      good: null,
      get: (c) => {
        if (c.est) return estV(c.est, `age:${p.id}`);
        const q = c.y && person(c.y, p.id);
        return q?.member && q.age != null ? { v: q.age } : null;
      },
    });

  // ------------------------------------------------------------ income
  lines.push({ heading: "Income", sub: "paid during the calendar year" });
  const payLines = (what: "salary" | "bonus", line: PayLine, label: string) => {
    lines.push({
      label,
      strong: false,
      get: (c) => cash(c, (w, _, y) => ({ v: w[what], proof: cashP(y, what, w[what]), title: c.y?.people?.map((p) => `${p.name}: ${usd(p[what])}`).join("\n") }), (e) => estV(e, what)),
    });
    if (persons.length > 1)
      for (const p of persons)
        lines.push({
          label: p.name,
          indent: true,
          muted: true,
          get: (c) =>
            pay(c, (y) => {
              const q = person(y, p.id)!;
              // Before the merge a partner wasn't in the household: nothing to show.
              if (!q.member) return null;
              return {
                v: q[what],
                proof: payP(y, q, line, q[what]),
                title: [what === "salary" ? q.employers.join(" + ") : "", q.from ? `Paid from the ${q.from} merge` : "", ...q.partial].filter(Boolean).join("\n") || undefined,
                after: q.partial.length ? <Badge tone="warn">partial</Badge> : undefined,
              };
            }),
        });
  };
  payLines("salary", "base", "Salary");
  payLines("bonus", "bonus", "Bonus");
  lines.push({
    label: "Investment & other income",
    help: "Bank interest, brokerage dividends and distributions, other income. The estimate has the year to date only: the forecast counts these in growth.",
    estPartial: true,
    get: (c) =>
      cash(
        c,
        (w, x, y) => ({
          v: w.otherIncome,
          proof: cashP(y, "other-income", w.otherIncome),
          title: `Bank interest ${usd(x.otherIncomeDetail.interest)} · dividends & distributions ${usd(x.otherIncomeDetail.dividends)} · other ${usd(x.otherIncomeDetail.other)}`,
        }),
        (e) => estV(e, "other-income", { title: "Year to date only: the forecast counts interest and dividends in growth." }),
      ),
  });
  lines.push({ label: "Gross income", strong: true, get: (c) => cash(c, (w, _, y) => ({ v: w.grossCash, proof: cashP(y, "gross", w.grossCash) }), (e) => estV(e, "gross")) });

  // ------------------------------------------------------------ taxes
  lines.push({ heading: "Taxes & deductions" });
  lines.push({
    label: "Taxes withheld",
    indent: true,
    help: "Federal, Social Security, Medicare, state and local income tax and state payroll programs, from pay stubs.",
    get: (c) => cash(c, (w, _, y) => ({ v: -w.withholding, proof: cashP(y, "withholding", w.withholding) })),
  });
  lines.push({ label: "Additional taxes paid", indent: true, help: "Estimated and balance-due payments in the bank ledger.", get: (c) => cash(c, (w, _, y) => ({ v: -w.additionalTaxes, proof: cashP(y, "taxes-paid", w.additionalTaxes) })) });
  lines.push({ label: "Tax refunds", indent: true, get: (c) => cash(c, (w, _, y) => ({ v: w.refunds, proof: cashP(y, "refunds", w.refunds) })) });
  lines.push({
    label: "Benefits & other deductions",
    indent: true,
    help: "Medical/dental/vision premiums, FSA and after-tax deductions on pay stubs. 401(k) and HSA deferrals aren't subtracted: they're savings.",
    get: (c) => cash(c, (w, _, y) => ({ v: -w.otherDeductions, proof: cashP(y, "deductions", w.otherDeductions) })),
  });
  lines.push({ label: "Total taxes & deductions", strong: true, get: (c) => cash(c, (w, _, y) => ({ v: -taxesAndDeductions(w), proof: cashP(y, "taxes-deductions", taxesAndDeductions(w)) }), (e) => estV(e, "taxes-deductions")) });
  lines.push({
    label: "Cash tax rate",
    muted: true,
    fmt: "pct",
    good: "down",
    help: "Withheld + paid − refunds, ÷ gross income.",
    get: (c) => cash(c, (w, _, y) => (w.cashTaxRate != null ? { v: w.cashTaxRate, proof: cashP(y, "tax-rate", null) } : null)),
  });

  // ------------------------------------------------------------ net cash
  lines.push({ heading: "Net cash" });
  lines.push({
    label: "Plus: employer retirement & HSA",
    indent: true,
    help: "Employer 401(k) and HSA contributions on pay stubs.",
    get: (c) => cash(c, (w, _, y) => ({ v: w.employer, proof: cashP(y, "employer", w.employer) }), (e) => estV(e, "employer")),
  });
  const kept = (c: Col): V => cash(c, (w, _, y) => ({ v: -w.partnerKept, proof: cashP(y, "partner-kept", w.partnerKept) }), (e) => estV(e, "partner-kept"));
  if (any(kept)) {
    const partner = persons.slice(1).map((p) => p.name).join(" & ");
    lines.push({
      label: `Less: ${partner}'s pay kept in own accounts`,
      indent: true,
      help: `Net pay since the ${r.mergeDate} merge that reached none of the household's accounts — paid into an account that stayed ${partner}'s. It was theirs, not the household's; what they moved in later is outside money below.`,
      get: kept,
    });
  }
  lines.push({ label: "Net cash", strong: true, get: (c) => cash(c, (w, _, y) => ({ v: w.netCash, proof: cashP(y, "net-cash", w.netCash) }), (e) => estV(e, "net-cash")) });

  // ------------------------------------------------------------ spending & saved
  lines.push({ heading: "Spending & saved" });
  lines.push({
    label: "Living expenses",
    indent: true,
    help: mergedPartner(r) && r.view === "STRICT"
      ? `Every expense on bank and card statements except income-tax payments and one-offs, net of reimbursements and, before the ${r.mergeDate} merge, of what ${mergedPartner(r)} paid toward rent and cards. The FIRE plan starts from the latest full year of this line.`
      : "Every expense on bank and card statements except income-tax payments and one-offs, net of reimbursements. The FIRE plan starts from the latest full year of this line.",
    get: (c) => cash(c, (w, _, y) => ({ v: -w.living, proof: cashP(y, "living", w.living) }), (e) => estV(e, "living")),
  });
  lines.push({
    label: "One-off expenses",
    indent: true,
    help: "Expenses marked one-off on the One-off expenses tab. They still count against what was saved; they're only kept out of living expenses.",
    get: (c) => cash(c, (w, _, y) => ({ v: -w.nonRecurring, proof: cashP(y, "one-offs", w.nonRecurring) }), (e) => estV(e, "one-offs")),
  });
  lines.push({ label: "Saved incl. retirement", total: true, get: (c) => cash(c, (w, _, y) => ({ v: w.saved, proof: cashP(y, "saved", w.saved) }), (e) => estV(e, "saved")) });
  lines.push({
    label: "of which to retirement accounts",
    muted: true,
    help: "Your 401(k) and HSA deferrals plus employer money.",
    get: (c) =>
      cash(
        c,
        (_, x, y) => ({ v: x.toRetirement, proof: cashP(y, "to-retirement", x.toRetirement) }),
        (e) => estV(e, "to-retirement"),
      ),
  });
  lines.push({
    label: "Savings % of gross",
    muted: true,
    fmt: "pct",
    get: (c) =>
      cash(
        c,
        (w, _, y) => (w.savingsOfGross != null ? { v: w.savingsOfGross, proof: cashP(y, "savings-of-gross", null) } : null),
        (e) => estV(e, "savings-of-gross"),
      ),
  });

  // ------------------------------------------------------------ net worth
  lines.push({ heading: "Net worth", sub: "at year end, from statements" });
  const bucket = (k: keyof YearNetWorth["buckets"], label: string, sign = 1, help?: string) =>
    lines.push({ label, indent: true, help, get: (c) => nw(c, (n, y) => ({ v: sign * n.buckets[k], proof: proofOf({ report: "annual", figure: "bucket", year: y.year, bucket: k }, sign * n.buckets[k]) })) });
  bucket("CASH", "Cash");
  bucket("LIQUID", "Taxable investments", 1, "Brokerage accounts.");
  bucket("ILLIQUID", "Retirement & other illiquid", 1, "401(k)s, IRAs, 529, HSA, private funds.");
  bucket("SHORT_DEBT", "Credit card balances", -1);
  lines.push({
    label: "Net worth",
    total: true,
    get: (c) =>
      nw(
        c,
        (n, y) => ({ v: n.netWorth, proof: nwP(y, "net-worth", n.netWorth), after: <QualityBadge quality={n.quality} /> }),
        (e) => estV(e, "net-worth"),
      ),
  });
  lines.push({ label: "Liquid", muted: true, help: "Cash + taxable investments − card debt.", get: (c) => nw(c, (n, y) => ({ v: n.liquid, proof: nwP(y, "liquid", n.liquid) }), (e) => estV(e, "liquid")) });
  lines.push({ label: "Illiquid", muted: true, get: (c) => nw(c, (n, y) => ({ v: n.illiquid, proof: nwP(y, "illiquid", n.illiquid) }), (e) => estV(e, "illiquid")) });
  const transit = (c: Col): V => nw(c, (n, y) => ({ v: n.inTransit, proof: nwP(y, "in-transit", n.inTransit) }));
  if (any(transit))
    lines.push({ label: "incl. transfers in transit", muted: true, help: "Money that had left one of your accounts by that day and reached another only after it (rent paid before the bill credits it, a rollover): already gone from the first account, so it counts where it was headed.", get: transit });

  // ------------------------------------------------------------ what moved it
  lines.push({ heading: "What moved net worth" });
  const bridgeLine = (k: Exclude<AnnualBridgeLine, "total">, label: string, help: string, always = true) => {
    const get = (c: Col) => bridge(c, k);
    if (always || any(get)) lines.push({ label, indent: true, help, get });
  };
  bridgeLine("cashSaved", "Saved incl. retirement", "From the cash flow above.");
  bridgeLine("investmentGrowth", "Investment growth, net of fees", "Market change in every account (dividends already counted as income are taken out). The estimate adds the forecast's returns for the rest of the year.");
  bridgeLine(
    "outsideMoney",
    mergedPartner(r) ? `Outside money (incl. ${mergedPartner(r)} moving money in)` : "Outside money",
    "Money from outside the tracked accounts: a partner's own savings moving in at and after the merge, untracked accounts, international transfers. Counted from the merge, what a partner paid toward rent and cards before it is a credit against spending, not outside money.",
  );
  bridgeLine("newlyTracked", "Balances first on file", "What an account already held when it joins: its first statement, or the merge for a partner's own account already on file.", false);
  bridgeLine("inTransit", "Transfers in transit", "A transfer whose other leg lands in the next year (e.g. a rollover).", false);
  bridgeLine(
    "unexplainedSavings",
    "Timing: statements vs. paychecks",
    "Saved according to statements less saved by the paycheck math: a 401(k) or HSA contribution posted after the year's last paycheck, rent paid in December for January.",
    false,
  );
  lines.push({ label: "Change in net worth", total: true, get: (c) => bridge(c, "total") });
  lines.push({
    label: "Change in net worth (%)",
    muted: true,
    fmt: "pct",
    get: (c) => {
      if (c.y) return c.y.change ? (c.y.change.pct != null ? { v: c.y.change.pct, proof: nwP(c.y, "change-pct", null) } : null) : blocked(c.y.blockers.change);
      return c.est ? estV(c.est, "change-pct") : null;
    },
  });

  return lines.map((l) => ("heading" in l ? { kind: "heading" as const, label: l.heading, sub: l.sub } : toRow(l, cols, mode)));
}

const fmtV = (v: number, fmt: Line["fmt"]) => (fmt === "pct" ? pct(v) : fmt === "plain" ? String(v) : usd(v));

/** One line's cells: the figure, or (change mode) how far it moved from the previous full year. */
function toRow(l: Line, cols: Col[], mode: "amounts" | "change"): TableRow {
  const vals = cols.map((c) => l.get(c));
  const cells: Cell[] = cols.map((c, i) => {
    const x = vals[i];
    if (x == null) return null;
    if ("blocked" in x) return blockedCell(x.blocked);
    if (mode === "amounts")
      return {
        text: x.after ? (
          <>
            {fmtV(x.v, l.fmt)} {x.after}
          </>
        ) : (
          fmtV(x.v, l.fmt)
        ),
        proof: x.proof ?? unswept(`${l.label}: no recipe for this line`),
        title: x.title,
      };
    if (l.fmt === "plain") return { text: fmtV(x.v, l.fmt), dim: true, proof: noFigure("ages aren't compared") };
    const p = c.prev != null && !(c.est && l.estPartial) ? vals[c.prev] : null;
    if (p == null || !("v" in p)) return { text: "", proof: noFigure("nothing to compare"), title: c.prev == null ? (c.y?.isCurrent ? "A partial year isn't compared." : "The first year: nothing to compare.") : undefined };
    const d = x.v - p.v;
    if (Math.abs(d) < (l.fmt === "pct" ? 0.0005 : 50)) return { text: "—", dim: true, proof: noFigure("no change worth showing") };
    const good = l.good === undefined ? "up" : l.good;
    const tone = good == null ? "" : (d > 0) === (good === "up") ? "text-pos" : "text-neg";
    const rel = l.fmt !== "pct" && p.v !== 0 ? ` (${d > 0 ? "+" : "−"}${pct(Math.abs(d / p.v), 0)})` : "";
    const text = l.fmt === "pct" ? `${d > 0 ? "+" : "−"}${(Math.abs(d) * 100).toFixed(1)} pts` : `${d > 0 ? "+" : "−"}${usd(Math.abs(d))}`;
    // The change is the difference of the two years' figures: a composite that clears from theirs (rates drawn in points).
    const both = x.proof && p.proof && !isUnswept(x.proof) && !isUnswept(p.proof);
    // A proof may hold the figure in the other sign (spending as a positive sum, drawn as an outflow): the difference follows its sign.
    const flipped = both && "shownCents" in x.proof! && x.proof!.shownCents != null && x.v !== 0 && Math.sign(x.proof!.shownCents) === -Math.sign(x.v);
    const proof = both ? compositeOf("diff", flipped ? [p.proof!, x.proof!] : [x.proof!, p.proof!], l.fmt === "pct" ? { ratio: d } : { cents: d }) : unswept("change mode: one of the two years has no proof");
    return { text: <span className={tone}>{text}</span>, proof, ...(l.fmt === "pct" ? { drawn: { per: 0.01 } } : {}), title: `${cols[c.prev!]!.head}: ${fmtV(p.v, l.fmt)} → ${fmtV(x.v, l.fmt)}${rel}` };
  });
  return { label: l.label, help: l.help, total: l.total, strong: l.strong, indent: l.indent, muted: l.muted, cells };
}

// ------------------------------------------------------------------ living by category

function LivingBreakdown({ years }: { years: YearProfile[] }) {
  const spendingOf = (y: YearProfile) => y.cash?.spending ?? [];
  const cats = [...new Set(years.flatMap((y) => spendingOf(y).map((s) => s.category)))];
  const total = (c: string) => years.reduce((s, y) => s + (spendingOf(y).find((x) => x.category === c)?.cents ?? 0), 0);
  cats.sort((a, b) => total(b) - total(a));
  const cell = (y: YearProfile, fn: (c: YearCash) => Cell): Cell => (y.cash ? fn(y.cash) : blockedCell(y.blockers.cash));
  const fig = (cents: number, proof: ProofTarget): Cell => ({ text: usd(cents), proof });
  const highlight = years.map((y, i) => (y.isCurrent ? i : -1)).filter((i) => i >= 0);
  const rows: TableRow[] = [
    ...cats.map((c) => ({
      label: c,
      indent: true,
      cells: years.map((y) =>
        cell(y, (x) => {
          const cents = x.spending.find((s) => s.category === c)?.cents;
          return cents == null ? { text: usd(0), proof: noFigure("nothing in this category that year") } : fig(cents, proofOf({ report: "annual", figure: "category", year: y.year, category: c }, cents));
        }),
      ),
    })),
    { label: "Less: reimbursements received", indent: true, cells: years.map((y) => cell(y, (x) => fig(-x.reimbursements, cashP(y, "reimbursements", x.reimbursements)))) },
    { label: "Living expenses", total: true, cells: years.map((y) => cell(y, (x) => fig(x.waterfall.living, cashP(y, "living", x.waterfall.living)))) },
  ];
  return (
    <Card title="Living expenses by category" subtitle="What's behind the living-expense line (one-offs and income-tax payments excluded).">
      <details>
        <summary className="cursor-pointer text-xs font-medium text-fg-2">Show categories</summary>
        <div className="mt-2">
          <YearTable columns={years.map((y) => y.label)} rows={rows} highlight={highlight} />
        </div>
      </details>
    </Card>
  );
}
