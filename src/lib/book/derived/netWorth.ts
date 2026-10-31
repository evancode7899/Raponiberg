import type { NetWorthReport } from "../reports/netWorth.ts";
import type { NetWorthChangesReport } from "../reports/netWorthChanges.ts";
import { c, ln, r, t, type DerivedFigure } from "./types.ts";

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
