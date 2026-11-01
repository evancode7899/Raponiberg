"use client";

import { Card } from "@/components/ledger/LedgerBits";
import { ProofValue } from "@/components/ui/proof/ProofValue";
import type { ProofRef } from "@/components/ui/proof/context";
import type { ChildIncome, PersonReport } from "@/lib/tax/buildTaxReport";
import type { W2Boxes } from "@/lib/tax/facts/payroll";
import type { ProvenTaxResponse as TaxResponse } from "./TaxClient";
import type { EstimateKey } from "@/lib/tax/estimateLines";
import { EstimateValue, formatDate, lawLabel, NumberTable, pct, usd, type Row } from "./taxUi";
import { NotFigure } from "@/components/ui/kit";
import { taxesDerived } from "@/lib/book/derived/taxes";
import { cellKey, derivedTarget } from "@/lib/book/derived/types";
import { ACCOUNT_ROWS, accountRow, employerRow, lineRow, showsChet, showsIraMoves, showsProjectedW2, W2_ROWS, w2Value, type W2Row } from "@/lib/tax/incomeExtras";

/** A cell of the year's income figures (lib/tax/incomeExtras), drawn as its figure. */
type Cell = (row: string, col: string, cents: number) => ReactNode;
import { isUnswept, unswept } from "@/lib/book/proof/clearance";
import { useMemo, type ReactNode } from "react";

const FREQ: Record<string, string> = { WEEKLY: "weekly", BIWEEKLY: "every two weeks", SEMIMONTHLY: "twice a month", MONTHLY: "monthly" };

/** Per person: gross pay → W-2 boxes, investment accounts, IRA moves; then the joint AGI build-up. */
export function TaxIncome({ r }: { r: TaxResponse }) {
  const derived = useMemo(() => taxesDerived(r), [r]);
  const cell: Cell = (row, col, cents) => <ProofValue proof={derivedTarget("taxes", derived, "income", cellKey(r.year, row, col))}>{usd(cents)}</ProofValue>;
  const f = r.scenarios.mfj.federal;
  const ct = r.scenarios.mfj.ct;
  // The joint return projected to Dec 31 (a finished year: the full year), each figure opening its proof.
  const est = (k: EstimateKey, cents: number, neg = false) => (
    <EstimateValue year={r.year} k={k} cents={cents}>
      {usd(neg ? -cents : cents)}
    </EstimateValue>
  );
  return (
    <div className="flex flex-col gap-4">
      {r.people.map((p) => (
        <PersonIncome key={p.id} p={p} year={r.year} isCurrentYear={r.isCurrentYear} cell={cell} />
      ))}
      {r.children.map((c) => (
        <ChildIncomeCard key={c.name} c={c} showProjected={r.isCurrentYear} cell={cell} />
      ))}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Federal: income to taxable income (${r.filingStatus === "SINGLE" ? "single" : "joint"})`}>
          <NumberTable
            columns={[""]}
            rows={[
              { label: "Wages (box 1, both spouses)", values: [est("fed.wages", f.wages)] },
              { label: "Taxable interest", values: [est("fed.taxableInterest", f.interest)] },
              { label: "Ordinary dividends", values: [est("fed.ordinaryDividends", f.ordinaryDividends)] },
              { label: "Capital gain/loss", values: [est("fed.capitalGain", f.capitalGainAllowed)], help: f.capitalLossCarryover ? `Net ${usd(f.capitalGainNet)}; ${usd(-f.capitalLossCarryover)} of loss carries to next year.` : undefined },
              { label: "IRA / retirement distributions", values: [est("fed.iraTaxable", f.retirementTaxable)] },
              { label: "Other income", values: [est("fed.additionalIncome", f.otherIncome)] },
              { label: "Adjustments to income", values: [est("fed.adjustments", f.adjustments, true)] },
              { label: "Adjusted gross income (AGI)", values: [est("fed.agi", f.agi)], strong: true },
              {
                label: f.itemizes ? "Itemized deductions" : "Standard deduction",
                values: [est("fed.deduction", f.deduction, true)],
                help: `Itemized would be ${usd(f.itemized.total)} (SALT ${usd(f.itemized.salt)} of ${usd(f.itemized.saltPaid)} paid, cap ${usd(f.itemized.saltCap)}; mortgage interest ${usd(f.itemized.mortgageInterest)}; charity ${usd(f.itemized.charitable)}).`,
              },
              { label: "QBI deduction", values: [est("fed.qbiDeduction", f.qbiDeduction, true)] },
              { label: "Taxable income", values: [est("fed.taxableIncome", f.taxableIncome)], strong: true },
              { label: lawLabel("of which taxed at 0/15/20% (qualified dividends, LT gains)"), values: [est("fed.preferentialIncome", f.preferentialIncome)], indent: true },
            ]}
          />
        </Card>
        <Card title={`Connecticut: AGI to tax (${r.filingStatus === "SINGLE" ? "single" : "joint"})`}>
          <NumberTable
            columns={[""]}
            rows={[
              { label: "Federal AGI", values: [est("ct.federalAgi", ct.federalAgi)] },
              { label: "CHET 529 contributions", values: [est("ct.chet", ct.chetDeduction, true)], help: "Deductible up to $10,000 joint / $5,000 separate per year." },
              { label: "US-obligation interest/dividends", values: [est("ct.usObligationSubtraction", ct.usObligationSubtraction, true)] },
              { label: "Other modifications", values: [cell("ct-other", "joint", ct.additions - (ct.subtractions - ct.chetDeduction - ct.usObligationSubtraction))] },
              { label: "Connecticut AGI", values: [est("ct.stateAgi", ct.ctAgi)], strong: true },
              { label: "Personal exemption", values: [est("ct.exemption", ct.exemption, true)] },
              { label: "Connecticut taxable income", values: [est("ct.taxableIncome", ct.taxableIncome)], strong: true },
              { label: lawLabel("Tax from brackets (2%–6.99%)"), values: [cell("ct-brackets", "joint", ct.initialTax)] },
              { label: lawLabel("2% rate phase-out add-back"), values: [cell("ct-addback", "joint", ct.addBack)] },
              { label: "Benefit recapture", values: [cell("ct-recapture", "joint", ct.recapture)] },
              { label: lawLabel(`Personal tax credit (${pct(ct.personalCreditRate, 0)})`), values: [cell("ct-personal-credit", "joint", -ct.personalCredit)] },
              { label: "Child tax credit", values: [est("ct.childTaxCredit", ct.childTaxCredit, true)] },
              { label: "Connecticut income tax", values: [est("ct.totalTax", ct.totalTax)], strong: true },
            ]}
          />
        </Card>
      </div>
    </div>
  );
}

const CHILD_RULE: Record<ChildIncome["rule"], (c: ChildIncome) => string> = {
  UNDER_EXEMPT: (c) => `Under ${usd(c.limits.exempt)}: no tax, and no return needed for ${c.name}.`,
  CHILD_RATE: (c) => `Over ${usd(c.limits.exempt)}: a return must be filed for ${c.name}; the part over ${usd(c.limits.exempt)} is taxed at ${c.name}'s own rate.`,
  KIDDIE_TAX: (c) =>
    `Over ${usd(c.limits.threshold)}: kiddie tax. ${c.name}'s return (Form 8615) taxes the first ${usd(c.limits.exempt)} at 0, the next ${usd(c.limits.threshold - c.limits.exempt)} at ${c.name}'s rate, and the rest at your rate.`,
};

/** A child's custodial (UTMA/UGMA) income: theirs, so not on the parents' return. */
function ChildIncomeCard({ c, showProjected, cell }: { c: ChildIncome; showProjected: boolean; cell: Cell }) {
  return (
    <Card title={`${c.name} (custodial accounts)`} subtitle={`${c.accounts.join(", ")} — the income is ${c.name}'s, so it's not on your return.`}>
      <NumberTable
        columns={showProjected ? ["Year to date", "Projected year end"] : ["Year total"]}
        rows={[{ label: "Unearned income (dividends, interest, gains)", values: showProjected ? [cell(`child:${c.name}`, "ytd", c.ytd), cell(`child:${c.name}`, "projected", c.projected)] : [cell(`child:${c.name}`, "projected", c.projected)], strong: true }]}
      />
      <p className="mt-2 text-xs text-fg-2">
        <NotFigure why="kiddie-tax thresholds set by tax law">{CHILD_RULE[c.rule](c)}</NotFigure>
        {c.rule !== "UNDER_EXEMPT" && (c.parentElectionAllowed ? " You could report it on your return with Form 8814 instead; this estimate leaves it off." : " Form 8814 (reporting it on your return) isn't available.")}
      </p>
    </Card>
  );
}

function PersonIncome({ p, year, isCurrentYear, cell }: { p: PersonReport; year: number; isCurrentYear: boolean; cell: Cell }) {
  return (
    <Card
      title={p.name}
      subtitle={p.payrollSource === "NONE" ? `No ${year} pay stubs on file.` : p.partial.length ? `From pay stubs — partial: ${p.partial.join("; ")}` : "From pay stubs."}
    >
      <div className="flex flex-col gap-4">
        {p.payroll.map((e) => (
          <div key={e.employer} className="min-w-0">
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-fg">{e.employer}</h3>
              <span className="text-xs text-muted">
                Latest stub {formatDate(e.latestPayDate)} · paid {FREQ[e.frequency]}
                {e.active && isCurrentYear ? ` · ${e.remainingPayDates.length} paychecks left this year` : e.active ? "" : " · no longer paying"}
                {e.extraBonus ? <> · plus {cell(employerRow(p, e, "extra-bonus"), "projected", e.extraBonus)} expected bonus</> : ""}
                {e.federalFilingStatus ? ` · W-4: ${e.federalFilingStatus}` : ""}
              </span>
            </div>
            <W2Table
              cell={(row, side) => cell(employerRow(p, e, row), side, w2Value(e, row, side))}
              grossProof={isCurrentYear && e.active ? { descriptor: { report: "planning", page: "taxes", figure: "projected-gross", year, personId: p.id }, shownCents: e.projected.gross } : unswept("projected only for the year in progress")}
              ytd={e.w2Ytd} projected={e.w2Projected} gross={{ ytd: e.ytd.gross, projected: e.projected.gross }} nonTaxable={{ ytd: e.ytd.nonTaxable, projected: e.projected.nonTaxable }} pretax={{ ytd: e.ytd.section125 + e.ytd.hsa + e.ytd.dependentCareFsa, projected: e.projected.section125 + e.projected.hsa + e.projected.dependentCareFsa }} showProjected={showsProjectedW2(e)} />
            <details className="mt-2">
              <summary data-audit-drill={`${e.employer} pay stub lines`} className="cursor-pointer text-xs font-medium text-fg-2">Pay stub lines and how each is treated</summary>
              <NumberTable
                columns={["Treatment", "Latest check", "Year to date"]}
                rows={e.lines.map((l, i) => ({ label: l.name, values: [KIND_LABEL[l.kind] ?? l.kind, cell(lineRow(p, e, i), "current", l.current ?? 0), cell(lineRow(p, e, i), "ytd", l.ytd ?? 0)] }))}
              />
            </details>
          </div>
        ))}
        {p.accounts.length > 0 && <Accounts p={p} cell={cell} />}
      </div>
    </Card>
  );
}

const KIND_LABEL: Record<string, string> = {
  REGULAR: "Wages",
  BONUS: "Bonus",
  IMPUTED: "Imputed income (taxable)",
  NONTAXABLE: "Not taxable",
  OTHER_EARNING: "Wages",
  RETIREMENT_PRETAX: "Pre-tax 401(k): box 1 only",
  RETIREMENT_ROTH: "Roth 401(k): after tax",
  HSA: "HSA: pre-tax, all boxes",
  SECTION125: "Pre-tax benefit (§125)",
  DEPENDENT_CARE_FSA: "Dependent care FSA",
  AFTER_TAX: "After-tax deduction",
  FEDERAL_TAX: "Federal withholding",
  SOCIAL_SECURITY: "Social Security",
  MEDICARE: "Medicare",
  STATE_TAX: "CT withholding",
  OTHER_STATE_TAX: "Other state withholding",
  LOCAL_TAX: "Local withholding",
  STATE_PAYROLL: "State payroll (PFML/SDI)",
  EMPLOYER_RETIREMENT: "Employer 401(k)",
  EMPLOYER_HSA: "Employer HSA",
  EMPLOYER_HEALTH: "Employer health",
  EMPLOYER_OTHER: "Employer-paid",
};

function W2Table({
  grossProof,
  gross,
  cell,
  showProjected,
}: {
  ytd: W2Boxes;
  projected: W2Boxes;
  gross: { ytd: number; projected: number };
  nonTaxable: { ytd: number; projected: number };
  pretax: { ytd: number; projected: number };
  showProjected: boolean;
  /** A box as its figure (lib/tax/incomeExtras). */
  cell: (row: W2Row, side: "ytd" | "projected") => ReactNode;
  /** The projected gross pay's proof (the year in progress: the stubs plus the forecast's paychecks and bonuses). */
  grossProof: ProofRef;
}) {
  // The projected gross pay is the forecast's own figure (planning › projected gross); every other box, the year's income cell.
  const rows: Row[] = W2_ROWS.map(([row, label]) => ({
    label: lawLabel(label),
    values: showProjected ? [cell(row, "ytd"), row === "gross" && !isUnswept(grossProof) ? <ProofValue key="p" proof={grossProof}>{usd(gross.projected)}</ProofValue> : cell(row, "projected")] : [cell(row, "ytd")],
    ...(row === "box5" || row === "box1" ? { strong: true } : {}),
    ...(row === "non-taxable" || row === "pretax" || row === "pretax-401k" ? { indent: true } : {}),
  }));
  return <NumberTable columns={showProjected ? ["Year to date", "Projected year end"] : ["Year total"]} rows={rows} />;
}

function Accounts({ p, cell }: { p: PersonReport; cell: Cell }) {
  const taxable = p.accounts.filter((a) => a.kind === "TAXABLE");
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {taxable.length > 0 && (
        <div>
          <h3 className="mb-1 text-sm font-semibold text-fg">Taxable investment income</h3>
          <NumberTable
            columns={[...taxable.flatMap((a) => [`${a.label} YTD`, "Projected"])]}
            rows={ACCOUNT_ROWS.map(([label, k]) => ({ label, values: taxable.flatMap((a) => [cell(accountRow(a, k), "ytd", a.ytd[k]), cell(accountRow(a, k), "projected", a.projected[k])]) }))}
          />
          <p className="mt-1 text-xs text-muted">
            {taxable
              .map(
                (a) =>
                  `${a.label}: through ${formatDate(a.latestStatement)}; ${
                    a.projection.method === "FINAL"
                      ? "full year"
                      : a.projection.method === "SEASONAL"
                        ? `rest of year follows last year's pattern (×${a.projection.factor.toFixed(2)})`
                        : `straight-line (×${a.projection.factor.toFixed(2)})`
                  }. Realized gains are as of the statement — future sales aren't projected.`,
              )
              .join(" ")}
          </p>
        </div>
      )}
      {showsIraMoves(p) && (
        <div>
          <h3 className="mb-1 text-sm font-semibold text-fg">IRA moves</h3>
          <NumberTable
            columns={[""]}
            rows={[
              { label: "Direct rollovers to an employer plan (not taxable)", values: [cell(`ira:${p.id}:rollovers`, "joint", p.retirement.rollovers)] },
              { label: "Roth conversions", values: [cell(`ira:${p.id}:conversions`, "joint", p.retirement.conversions)] },
              { label: "Non-deductible basis (contributions)", values: [cell(`ira:${p.id}:basis`, "joint", -p.retirement.basis)], indent: true },
              { label: "Other IRA withdrawals", values: [cell(`ira:${p.id}:other`, "joint", p.retirement.otherDistributions)] },
              { label: "Taxable", values: [cell(`ira:${p.id}:taxable`, "joint", p.retirement.taxable)], strong: true },
            ]}
          />
        </div>
      )}
      {showsChet(p) && (
        <p className="text-xs text-muted">
          CHET 529 contributions this year: {cell(`chet:${p.id}`, "joint", p.income.ctChetContributions)} (deductible on the CT
          return).
        </p>
      )}
    </div>
  );
}
