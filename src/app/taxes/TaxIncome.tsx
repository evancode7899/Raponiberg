"use client";

import { Card } from "@/components/ledger/LedgerBits";
import type { ChildIncome, PersonReport } from "@/lib/tax/buildTaxReport";
import type { W2Boxes } from "@/lib/tax/facts/payroll";
import type { ProvenTaxResponse as TaxResponse } from "./TaxClient";
import type { EstimateKey } from "@/lib/tax/estimateLines";
import { EstimateValue, formatDate, NumberTable, pct, usd, type Row } from "./taxUi";

const FREQ: Record<string, string> = { WEEKLY: "weekly", BIWEEKLY: "every two weeks", SEMIMONTHLY: "twice a month", MONTHLY: "monthly" };

/** Per person: gross pay → W-2 boxes, investment accounts, IRA moves; then the joint AGI build-up. */
export function TaxIncome({ r }: { r: TaxResponse }) {
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
        <PersonIncome key={p.id} p={p} year={r.year} isCurrentYear={r.isCurrentYear} />
      ))}
      {r.children.map((c) => (
        <ChildIncomeCard key={c.name} c={c} showProjected={r.isCurrentYear} />
      ))}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Federal: income to taxable income (joint)">
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
              { label: "of which taxed at 0/15/20% (qualified dividends, LT gains)", values: [est("fed.preferentialIncome", f.preferentialIncome)], indent: true },
            ]}
          />
        </Card>
        <Card title="Connecticut: AGI to tax (joint)">
          <NumberTable
            columns={[""]}
            rows={[
              { label: "Federal AGI", values: [est("ct.federalAgi", ct.federalAgi)] },
              { label: "CHET 529 contributions", values: [est("ct.chet", ct.chetDeduction, true)], help: "Deductible up to $10,000 joint / $5,000 separate per year." },
              { label: "US-obligation interest/dividends", values: [est("ct.usObligationSubtraction", ct.usObligationSubtraction, true)] },
              { label: "Other modifications", values: [usd(ct.additions - (ct.subtractions - ct.chetDeduction - ct.usObligationSubtraction))] },
              { label: "Connecticut AGI", values: [est("ct.stateAgi", ct.ctAgi)], strong: true },
              { label: "Personal exemption", values: [est("ct.exemption", ct.exemption, true)] },
              { label: "Connecticut taxable income", values: [est("ct.taxableIncome", ct.taxableIncome)], strong: true },
              { label: "Tax from brackets (2%–6.99%)", values: [usd(ct.initialTax)] },
              { label: "2% rate phase-out add-back", values: [usd(ct.addBack)] },
              { label: "Benefit recapture", values: [usd(ct.recapture)] },
              { label: `Personal tax credit (${pct(ct.personalCreditRate, 0)})`, values: [usd(-ct.personalCredit)] },
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
function ChildIncomeCard({ c, showProjected }: { c: ChildIncome; showProjected: boolean }) {
  return (
    <Card title={`${c.name} (custodial accounts)`} subtitle={`${c.accounts.join(", ")} — the income is ${c.name}'s, so it's not on your return.`}>
      <NumberTable
        columns={showProjected ? ["Year to date", "Projected year end"] : ["Year total"]}
        rows={[{ label: "Unearned income (dividends, interest, gains)", values: showProjected ? [usd(c.ytd), usd(c.projected)] : [usd(c.projected)], strong: true }]}
      />
      <p className="mt-2 text-xs text-fg-2">
        {CHILD_RULE[c.rule](c)}
        {c.rule !== "UNDER_EXEMPT" && (c.parentElectionAllowed ? " You could report it on your return with Form 8814 instead; this estimate leaves it off." : " Form 8814 (reporting it on your return) isn't available.")}
      </p>
    </Card>
  );
}

function PersonIncome({ p, year, isCurrentYear }: { p: PersonReport; year: number; isCurrentYear: boolean }) {
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
                {e.extraBonus ? ` · plus ${usd(e.extraBonus)} expected bonus` : ""}
                {e.federalFilingStatus ? ` · W-4: ${e.federalFilingStatus}` : ""}
              </span>
            </div>
            <W2Table ytd={e.w2Ytd} projected={e.w2Projected} gross={{ ytd: e.ytd.gross, projected: e.projected.gross }} nonTaxable={{ ytd: e.ytd.nonTaxable, projected: e.projected.nonTaxable }} pretax={{ ytd: e.ytd.section125 + e.ytd.hsa + e.ytd.dependentCareFsa, projected: e.projected.section125 + e.projected.hsa + e.projected.dependentCareFsa }} showProjected={e.active && e.remainingPayDates.length > 0} />
            <details className="mt-2">
              <summary className="cursor-pointer text-xs font-medium text-fg-2">Pay stub lines and how each is treated</summary>
              <NumberTable
                columns={["Treatment", "Latest check", "Year to date"]}
                rows={e.lines.map((l) => ({ label: l.name, values: [KIND_LABEL[l.kind] ?? l.kind, usd(l.current ?? 0), usd(l.ytd ?? 0)] }))}
              />
            </details>
          </div>
        ))}
        {p.accounts.length > 0 && <Accounts p={p} />}
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
  ytd,
  projected,
  gross,
  nonTaxable,
  pretax,
  showProjected,
}: {
  ytd: W2Boxes;
  projected: W2Boxes;
  gross: { ytd: number; projected: number };
  nonTaxable: { ytd: number; projected: number };
  pretax: { ytd: number; projected: number };
  showProjected: boolean;
}) {
  const both = (a: number, b: number) => (showProjected ? [usd(a), usd(b)] : [usd(a)]);
  const rows: Row[] = [
    { label: "Gross pay (incl. imputed income)", values: both(gross.ytd, gross.projected) },
    { label: "Non-taxable reimbursements", values: both(-nonTaxable.ytd, -nonTaxable.projected), indent: true },
    { label: "Pre-tax health, HSA, FSA (§125)", values: both(-pretax.ytd, -pretax.projected), indent: true },
    { label: "Box 5 · Medicare wages", values: both(ytd.box5MedicareWages, projected.box5MedicareWages), strong: true },
    { label: "Pre-tax 401(k)", values: both(-ytd.box12.D, -projected.box12.D), indent: true },
    { label: "Box 1 · Wages (federal taxable)", values: both(ytd.box1Wages, projected.box1Wages), strong: true },
    { label: "Box 3 · Social Security wages (capped)", values: both(ytd.box3SsWages, projected.box3SsWages) },
    { label: "Box 16 · CT wages", values: both(ytd.box16StateWages, projected.box16StateWages) },
    { label: "Box 2 · Federal withheld", values: both(ytd.federalWithheld, projected.federalWithheld) },
    { label: "Box 4 · Social Security withheld", values: both(ytd.ssWithheld, projected.ssWithheld) },
    { label: "Box 6 · Medicare withheld", values: both(ytd.medicareWithheld, projected.medicareWithheld) },
    { label: "Box 17 · CT withheld", values: both(ytd.stateWithheld, projected.stateWithheld) },
    { label: "Box 12 D · 401(k) deferrals", values: both(ytd.box12.D, projected.box12.D) },
    { label: "Box 12 W · HSA (you + employer)", values: both(ytd.box12.W, projected.box12.W) },
    { label: "Box 12 C · Group-term life over $50k", values: both(ytd.box12.C, projected.box12.C) },
    { label: "Box 12 DD · Health coverage cost (info only)", values: both(ytd.box12.DD, projected.box12.DD) },
    { label: "Employer 401(k) contributions (not taxed)", values: both(ytd.employerRetirement, projected.employerRetirement) },
  ];
  return <NumberTable columns={showProjected ? ["Year to date", "Projected year end"] : ["Year total"]} rows={rows} />;
}

function Accounts({ p }: { p: PersonReport }) {
  const taxable = p.accounts.filter((a) => a.kind === "TAXABLE");
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {taxable.length > 0 && (
        <div>
          <h3 className="mb-1 text-sm font-semibold text-fg">Taxable investment income</h3>
          <NumberTable
            columns={[...taxable.flatMap((a) => [`${a.label} YTD`, "Projected"])]}
            rows={(
              [
                ["Ordinary dividends", "ordinaryDividends"],
                ["of which qualified", "qualifiedDividends"],
                ["of which money market", "moneyMarketDividends"],
                ["Interest", "interest"],
                ["Capital gain distributions", "capGainDistLong"],
                ["Realized short-term gain/loss", "shortTermGain"],
                ["Realized long-term gain/loss", "longTermGain"],
                ["Foreign tax paid", "foreignTax"],
              ] as const
            ).map(([label, k]) => ({ label, values: taxable.flatMap((a) => [usd(a.ytd[k]), usd(a.projected[k])]) }))}
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
      {(p.retirement.conversions > 0 || p.retirement.rollovers > 0 || p.retirement.otherDistributions > 0) && (
        <div>
          <h3 className="mb-1 text-sm font-semibold text-fg">IRA moves</h3>
          <NumberTable
            columns={[""]}
            rows={[
              { label: "Direct rollovers to an employer plan (not taxable)", values: [usd(p.retirement.rollovers)] },
              { label: "Roth conversions", values: [usd(p.retirement.conversions)] },
              { label: "Non-deductible basis (contributions)", values: [usd(-p.retirement.basis)], indent: true },
              { label: "Other IRA withdrawals", values: [usd(p.retirement.otherDistributions)] },
              { label: "Taxable", values: [usd(p.retirement.taxable)], strong: true },
            ]}
          />
        </div>
      )}
      {p.accounts.some((a) => a.isChet) && (
        <p className="text-xs text-muted">
          CHET 529 contributions this year: {usd(p.income.ctChetContributions)} (deductible on the CT
          return).
        </p>
      )}
    </div>
  );
}
