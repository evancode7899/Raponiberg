import type { NetWorthReport } from "../reports/netWorth.ts";
import type { NetWorthChangesReport } from "../reports/netWorthChanges.ts";
import type { ProofValue } from "../proof/types.ts";
import type { RollforwardReport } from "../../profile/rollforwards.ts";
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
    // Each account's own, over its unbroken proven stretch.
    ...rep.proven.returns.byAccount.flatMap((a): DerivedFigure[] => [
      { figure: "account-return", key: a.accountId, describes: `${names.get(a.accountId) ?? "An account"}: return since ${a.from}, cumulative and time-weighted`, value: r(a.total), lines: [ln(`Each month's return, chained from ${a.from}`, r(a.total), undefined, { note: "(1 + r₁) × (1 + r₂) × … − 1" })] },
      ...(a.annualized == null ? [] : [{ figure: "account-return-annualized", key: a.accountId, describes: `${names.get(a.accountId) ?? "An account"}: return since ${a.from}, a year`, value: r(a.annualized), lines: [ln("Cumulative", r(a.total)), ln("Over its days, a year", r(a.annualized))] }]),
    ]),
  ];
}

/**
 * Net worth › Account roll-forwards: each account's return since its first statement on
 * file, its years' Modified Dietz returns chained (a year, once they span one; else
 * cumulative). Key: the account id. Only where no year of it is blocked.
 */
export function rollforwardsDerived(rep: Pick<RollforwardReport, "accounts">): DerivedFigure[] {
  return rep.accounts
    .filter((a) => a.cumulative != null)
    .map((a) => {
      const measured = a.years.filter((x) => x.returnRatio != null);
      const chain = ln(`Each year's return, chained from ${measured[0]?.year ?? a.firstDay.slice(0, 4)}`, r(a.cumulative!), undefined, { note: "(1 + r₁) × (1 + r₂) × … − 1; a year with under $1,000 invested is left out" });
      return {
        figure: "rollforward-since",
        key: a.id,
        describes: `${a.name}: return since first on file (${a.firstDay}), ${a.annualized != null ? "a year" : "cumulative"}`,
        value: r(a.annualized ?? a.cumulative!),
        lines: a.annualized != null ? [chain, ln("Over its days, a year", r(a.annualized), undefined, { note: "(1 + cumulative) ^ (365 ÷ days) − 1" })] : [chain],
        parts: measured.map((x) => ({ label: String(x.year), value: r(x.returnRatio!), link: { label: `${a.name}, ${x.year} return`, descriptor: { report: "annual", figure: "rollforward", year: x.year, accountId: a.id, line: "return" } } })),
      };
    });
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

/** An average's key (derived/netWorth.ts changeTypicalDerived): the granularity, the period's first day, and what (a total, step:<key>, or spending:/income:<category>). */
export const typicalKey = (granularity: string, start: string, what: string) => `${granularity}|${start}|${what}`;

/**
 * Net worth › What changed: each period's averages over the whole proven periods before it
 * (the report's typical), for the totals, each step, and each category that moved most.
 * Keys: typicalKey (granularity|start|what).
 */
export function changeTypicalDerived(rep: Pick<NetWorthChangesReport, "granularity" | "periods">): DerivedFigure[] {
  const g = rep.granularity;
  return rep.periods.flatMap((p) => {
    const t = p.typical;
    const ret: DerivedFigure[] =
      p.portfolioReturn == null
        ? []
        : [{ figure: "change-return", key: typicalKey(g, p.start, "return"), describes: `The portfolio's return, ${p.label}: its months' returns chained`, value: r(p.portfolioReturn), lines: [ln("Each month's time-weighted return, chained: (1 + r₁) × (1 + r₂) × … − 1", r(p.portfolioReturn), undefined, { note: "As Investment returns chains them; net of fees." })] }];
    if (!t) return ret;
    const over = `the average over ${t.of.join(", ")}`;
    const fig = (what: string, label: string, cents: number): DerivedFigure => ({
      figure: "change-typical",
      key: typicalKey(g, p.start, what),
      describes: `${label}, ${over} (beside ${p.label})`,
      value: c(cents),
      lines: [ln(`${label}: each of the ${t.periods} periods before, added up ÷ ${t.periods}`, c(cents), undefined, { note: t.of.join(" · ") })],
    });
    return [
      fig("change", "Change in net worth", t.changeCents),
      fig("saved", "From saving", t.savedCents),
      fig("markets", "From markets", t.marketsCents),
      fig("income", "Income", t.incomeCents),
      fig("spending", "Spending", t.spendingCents),
      ...p.steps.filter((s) => s.typicalCents != null && s.key !== "spending").map((s) => fig(`step:${s.key}`, s.label, s.typicalCents!)),
      ...p.spendingMovers.map((m) => fig(`spending:${m.category}`, `${m.category} spending`, m.typicalCents)),
      ...p.incomeMovers.map((m) => fig(`income:${m.category}`, `${m.category} income`, m.typicalCents)),
      ...ret,
    ];
  });
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
