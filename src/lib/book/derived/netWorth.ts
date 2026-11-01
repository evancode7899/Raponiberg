import type { NetWorthReport } from "../reports/netWorth.ts";
import type { NetWorthChangesReport } from "../reports/netWorthChanges.ts";
import type { ProofValue } from "../proof/types.ts";
import { c, ln, r, t, tableFigures, type DerivedFigure, type TableCell } from "./types.ts";

/** Net worth › Investment returns (monthly periods): the portfolio's chained return since its latest unbroken proven stretch began, annualized, and how many accounts are measured. */
export function netWorthDerived(rep: Pick<NetWorthReport, "proven" | "periods" | "accounts">): DerivedFigure[] {
  const p = rep.proven.returns.portfolio;
  const run = p ? rep.periods.filter((x) => x.start >= p.from && x.household.portfolioReturn != null) : [];
  const parts = run.map((x) => ({ label: x.label, value: r(x.household.portfolioReturn!) }));
  const names = new Map(rep.accounts.map((a) => [a.id, a.name]));
  return [
    {
      figure: "return-total",
      describes: p ? `Portfolio return since ${p.from}, cumulative and time-weighted` : "Portfolio return",
      value: p ? r(p.total) : null,
      lines: p ? [ln(`Each period's return, chained from ${p.from}`, t(`${run.length} periods`)), ln("Cumulative", r(p.total), undefined, { note: "(1 + r₁) × (1 + r₂) × … − 1" })] : [],
      parts,
    },
    {
      figure: "return-annualized",
      describes: p ? `Portfolio return since ${p.from}, a year` : "Portfolio return, a year",
      value: p?.annualized == null ? null : r(p.annualized),
      lines: p ? [ln("Cumulative", r(p.total)), ln("Over its days, a year", p.annualized == null ? t("—") : r(p.annualized), undefined, { note: "Shown after a full year." })] : [],
    },
    {
      figure: "accounts-measured",
      describes: "Investment accounts with a measured return",
      value: t(String(rep.proven.returns.byAccount.length)),
      lines: [ln("Accounts with an unbroken proven stretch", t(String(rep.proven.returns.byAccount.length)))],
      parts: rep.proven.returns.byAccount.map((a) => ({ label: names.get(a.accountId) ?? a.accountId, value: r(a.total), sub: `since ${a.from}` })),
    },
  ];
}

/** A What-changed step's key: the granularity, the period's first day and the step. */
export const changeStepKey = (granularity: string, start: string, step: string) => `${granularity}|${start}|${step}`;

/**
 * Net worth › What changed: the steps of each period's change that have no proof of their
 * own (retirement from pay, other money, timing, in transit). Each is a line of the change's
 * chain; its proof shows the step and links the change it is part of.
 */
export function changeStepsDerived(rep: Pick<NetWorthChangesReport, "granularity" | "periods">): DerivedFigure[] {
  return rep.periods.flatMap((p) =>
    p.steps
      .filter((s) => !s.proof)
      .map((s) => ({
        figure: "change-step",
        key: changeStepKey(rep.granularity, p.start, s.key),
        describes: `${s.label}, ${p.label}`,
        value: c(s.cents),
        lines: [ln(s.label, c(s.cents), undefined, { note: s.note, link: { label: `The change in net worth, ${p.label}`, descriptor: p.proofs.change } })],
      })),
  );
}

/** How a period's roll-forward splits, as Net worth › How it was built draws it, column by column (keys: cellKey). */
export const BUILT_COLUMNS = ["income", "spending", "other", "retirement", "principal", "growth", "transit", "return"] as const;

/**
 * Net worth › How it was built, for one granularity: each period's roll-forward beyond its
 * opening and closing balances (proven as balances), each account's part of it, and the
 * running totals since the start of the proven stretch. The page draws every cell from this
 * list; the change proof re-adds opening + flows = closing for the same period.
 */
export function builtDerived(rep: Pick<NetWorthReport, "granularity" | "periods" | "proven">): DerivedFigure[] {
  const g = rep.granularity;
  const cells: TableCell[] = [];
  const run = rep.proven.from ? rep.periods.filter((p) => p.start >= rep.proven.from!) : [];
  for (const p of rep.periods) {
    if (p.blockers.length) continue;
    const h = p.household;
    const at = (col: (typeof BUILT_COLUMNS)[number], value: ProofValue | null, describes: string) => cells.push({ row: `${p.start}:${col}`, col: "household", describes: `${p.label}: ${describes}`, value });
    at("income", c(h.incomeCents), "income");
    at("spending", c(h.spendingCents), "spending");
    at("other", c(h.externalCents + h.newlyTrackedCents), "other money in and out (incl. balances first on file)");
    at("retirement", c(h.retirementEmployeeCents + h.retirementEmployerCents), "401(k) and HSA via payroll");
    at("principal", c(h.principalCents + h.newlyTrackedCents), "net principal");
    at("growth", c(h.growthNetOfFeesCents), "growth, net of fees");
    at("transit", c(h.transferResidualCents + h.unexplainedCents), "in transit");
    at("return", h.portfolioReturn == null ? null : r(h.portfolioReturn), "portfolio return");
    for (const a of p.byAccount) {
      const of = (col: string, value: ProofValue | null, describes: string) => cells.push({ row: `${p.start}:${col}`, col: a.accountId, describes: `${p.label}, one account: ${describes}`, value });
      if (a.newlyTrackedCents) of("first-on-file", c(a.newlyTrackedCents), "the balance already in it when its first statement on file begins");
      of("contributions", c(a.contributionsCents), "money in and out, transfers included");
      of("growth", c(a.growthNetOfFeesCents), "growth, net of fees");
      of("fees", c(a.feesCents), "fees");
      of("unexplained", c(a.unexplainedCents), "unexplained");
      of("return", a.returnRatio == null ? null : r(a.returnRatio), "return");
    }
  }
  // Since the start of the proven stretch: on hand then, saved since, grown since.
  if (run.length) {
    const principal = run.reduce((s, p) => s + p.household.principalCents + p.household.newlyTrackedCents + p.household.transferResidualCents + p.household.unexplainedCents, 0);
    const growth = run.reduce((s, p) => s + p.household.growthNetOfFeesCents, 0);
    cells.push(
      { row: "since:start", col: "household", describes: `On hand at the start of ${run[0]!.label}`, value: c(run[0]!.household.openingCents) },
      { row: "since:principal", col: "household", describes: `Saved since ${run[0]!.label}`, value: c(principal) },
      { row: "since:growth", col: "household", describes: `Growth since ${run[0]!.label}`, value: c(growth) },
    );
  }
  return tableFigures("built", g, cells);
}
