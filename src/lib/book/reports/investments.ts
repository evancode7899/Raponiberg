import { addDays, daysBetween } from "../../dates/isoDate.ts";
import type { Holding, HoldingKind } from "../../ingest/holdings/types.ts";
import { ASSET_CLASSES, describeSecurity, securityKey, type AssetClass, type SecurityInfo, type Weights } from "../../investments/securities.ts";
import type { InvestmentSettings } from "../../investments/settings.ts";
import type { AccountGroup } from "../../ledger/loadLedger.ts";
import { decompose, valueAt } from "../../ledger/timeline.ts";
import { netWorthAtBlockers } from "../blockers.ts";
import type { Book, BookHoldings } from "../load.ts";
import { refs, type BlockerRef } from "./blockerRef.ts";
import { buildNetWorth } from "./netWorth.ts";

/**
 * Holdings, allocation, fees, unrealized gains and money-in-versus-growth for every
 * investment account, from the Book. Each account is valued at its latest statement;
 * its positions come from the holdings that statement lists, used only when they add up
 * to the statement's balance to the cent. An account without such holdings is one
 * "whole account" line, so totals always equal the balances net worth uses.
 */

export type TaxTreatment = "Taxable" | "Tax-deferred" | "Roth" | "HSA" | "529" | "Bank cash";
export const TREATMENT_ORDER: TaxTreatment[] = ["Taxable", "Tax-deferred", "Roth", "HSA", "529", "Bank cash"];

export function treatmentFor(subtype: string | null, group: AccountGroup): TaxTreatment {
  if (group === "Cash") return "Bank cash";
  switch (subtype) {
    case "401K":
    case "TRADITIONAL_IRA":
    case "ROLLOVER_IRA":
      return "Tax-deferred";
    case "ROTH_IRA":
      return "Roth";
    case "HSA":
      return "HSA";
    case "529":
      return "529";
    default:
      return "Taxable";
  }
}

export type ClassId = AssetClass | "UNCLASSIFIED";

export type PositionRow = {
  accountId: string;
  account: string;
  treatment: TaxTreatment;
  key: string;
  symbol: string | null;
  name: string;
  kind: HoldingKind | "ACCOUNT";
  quantity: number | null;
  price: number | null;
  valueCents: number;
  costBasisCents: number | null;
  unrealizedCents: number | null;
  expenseRatio: number | null;
  /** valueCents × expense ratio, per year. */
  annualFeeCents: number | null;
  weights: Weights | null;
  source: SecurityInfo["source"];
  asOf: string;
};

export type HoldingsStatus =
  /** Positions on file add up to the statement balance. */
  | "TIES"
  /** The latest positions on file are older than the latest statement (the difference is shown as one line). */
  | "STALE"
  /** Positions on file don't add up to the statement balance: not used. */
  | "MISMATCH"
  /** No positions on file for this account. */
  | "NONE";

export type AccountHoldings = {
  accountId: string;
  name: string;
  institution: string | null;
  group: AccountGroup;
  treatment: TaxTreatment;
  /** Balance at the account's latest statement (what net worth uses). */
  valueCents: number;
  asOf: string;
  status: HoldingsStatus;
  holdingsAsOf: string | null;
  /** Snapshot total − balance on the snapshot's date, when they disagree. */
  differenceCents: number | null;
  /** Fees the statements deducted over the last 12 months (≤ 0), and the window. */
  feesLast12Cents: number;
  feesWindow: { from: string; to: string };
  blockers: BlockerRef[];
};

export type ClassAmount = { cls: ClassId; cents: number; share: number };

export type InvestmentsReport = {
  asOf: string;
  accounts: AccountHoldings[];
  positions: PositionRow[];
  totalCents: number;
  allocation: ClassAmount[];
  byTreatment: { treatment: TaxTreatment; cents: number; allocation: ClassAmount[] }[];
  drift: { cls: AssetClass; currentShare: number; targetShare: number; deltaCents: number }[] | null;
  fees: {
    /** Value-weighted expense ratio over positions whose ratio is known. */
    weightedRatio: number | null;
    annualCents: number;
    knownCents: number;
    unknownCents: number;
    /** Fees taken out by the accounts themselves (advisory, plan admin) over 12 months. */
    accountFeesLast12Cents: number;
  };
  gains: {
    taxable: { unrealizedCents: number; gainCents: number; lossCents: number; costKnownCents: number; costUnknownCents: number };
    all: { unrealizedCents: number; costKnownCents: number };
    /** Taxable positions below cost, worst first. */
    harvest: PositionRow[];
  };
  /** Securities across accounts, largest first (cash and whole-account lines excluded). */
  concentration: { key: string; symbol: string | null; name: string; cents: number; share: number; accounts: string[] }[];
  growth: GrowthSeries[];
  /** Securities without a classification, for the owner to classify. */
  unclassified: { key: string; name: string; symbol: string | null; cents: number }[];
  blockers: BlockerRef[];
};

export type GrowthPoint = { label: string; end: string; investedCents: number; valueCents: number; blocked: boolean };
export type GrowthSeries = { accountId: string | null; name: string; points: GrowthPoint[] };

const share = (c: number, total: number) => (total ? c / total : 0);

function allocate(rows: PositionRow[]): ClassAmount[] {
  const by = new Map<ClassId, number>();
  for (const r of rows) {
    if (!r.weights) by.set("UNCLASSIFIED", (by.get("UNCLASSIFIED") ?? 0) + r.valueCents);
    else for (const [c, w] of Object.entries(r.weights) as [AssetClass, number][]) by.set(c, (by.get(c) ?? 0) + Math.round(r.valueCents * w));
  }
  const total = [...by.values()].reduce((s, v) => s + v, 0);
  const order: ClassId[] = [...ASSET_CLASSES.map((c) => c.id), "UNCLASSIFIED"];
  return order.filter((c) => by.get(c)).map((cls) => ({ cls, cents: by.get(cls)!, share: share(by.get(cls)!, total) }));
}

export function buildInvestments(book: Book, settings: InvestmentSettings): InvestmentsReport {
  const asOf = book.horizon.netWorth;
  const accounts: AccountHoldings[] = [];
  const positions: PositionRow[] = [];
  const byAccount = new Map<string, BookHoldings[]>();
  for (const h of book.holdings) if (h.accountId) byAccount.set(h.accountId, [...(byAccount.get(h.accountId) ?? []), h]);

  const included = book.ledger.accounts.filter((a) => !a.closed && (a.isInvestment || (settings.includeBankCash && a.group === "Cash")));
  for (const a of included) {
    const lastDay = a.timeline.lastDay!;
    const value = valueAt(a.timeline, lastDay).cents;
    if (value === 0) continue;
    const treatment = treatmentFor(a.subtype, a.group);
    const feesFrom = [addDays(lastDay, -364), a.timeline.firstDay!].sort().at(-1)!;
    const fees = a.isInvestment ? decompose(a.timeline, feesFrom, lastDay).feesCents : 0;

    // The latest snapshot that ties to the balance on its own date.
    const snaps = (byAccount.get(a.id) ?? []).filter((s) => s.asOf <= lastDay).sort((x, y) => x.asOf.localeCompare(y.asOf));
    const latest = snaps.at(-1) ?? null;
    const ties = (s: BookHoldings) => s.totalCents === valueAt(a.timeline, s.asOf).cents;
    const usable = [...snaps].reverse().find(ties) ?? null;
    let status: HoldingsStatus = "NONE";
    if (usable) status = usable.asOf === lastDay ? "TIES" : "STALE";
    else if (latest) status = "MISMATCH";

    const row = (h: Holding, info: SecurityInfo, at: string): PositionRow => ({
      accountId: a.id,
      account: a.name,
      treatment,
      key: securityKey(h),
      symbol: h.symbol,
      name: h.name,
      kind: h.kind,
      quantity: h.quantity,
      price: h.price,
      valueCents: h.valueCents,
      costBasisCents: h.costBasisCents,
      unrealizedCents: h.costBasisCents == null ? null : h.valueCents - h.costBasisCents,
      expenseRatio: info.expenseRatio,
      annualFeeCents: info.expenseRatio == null ? null : Math.round(h.valueCents * info.expenseRatio),
      weights: info.weights,
      source: info.source,
      asOf: at,
    });
    const year = Number(lastDay.slice(0, 4));
    let covered = 0;
    if (usable) {
      for (const h of usable.positions) {
        positions.push(row(h, describeSecurity(h, year, settings.securities), usable.asOf));
        covered += h.valueCents;
      }
    }
    if (covered !== value) {
      // The balance the positions don't explain: the whole account, or what changed since.
      const label = usable ? `Change since holdings of ${usable.asOf}` : "Whole account (no holdings on file)";
      // Classified per account ("ACCOUNT:<name>"), e.g. a private fund with no holdings list.
      const whole: Holding = { symbol: null, name: `ACCOUNT:${a.name}`, kind: a.group === "Cash" ? "CASH" : "OTHER", quantity: null, price: null, valueCents: value - covered, costBasisCents: null, expenseRatio: null };
      const info = describeSecurity(whole, year, settings.securities);
      positions.push({ ...row(whole, info, lastDay), kind: "ACCOUNT", name: label });
    }
    accounts.push({
      accountId: a.id,
      name: a.name,
      institution: a.institution,
      group: a.group,
      treatment,
      valueCents: value,
      asOf: lastDay,
      status,
      holdingsAsOf: usable?.asOf ?? latest?.asOf ?? null,
      differenceCents: !usable && latest ? latest.totalCents - valueAt(a.timeline, latest.asOf).cents : null,
      feesLast12Cents: fees,
      feesWindow: { from: feesFrom, to: lastDay },
      blockers: refs(netWorthAtBlockers(book, lastDay, [a.id])),
    });
  }

  const totalCents = positions.reduce((s, p) => s + p.valueCents, 0);
  const allocation = allocate(positions);
  const byTreatment = TREATMENT_ORDER.map((treatment) => {
    const rows = positions.filter((p) => p.treatment === treatment);
    return { treatment, cents: rows.reduce((s, p) => s + p.valueCents, 0), allocation: allocate(rows) };
  }).filter((t) => t.cents !== 0);

  const classified = allocation.filter((c) => c.cls !== "UNCLASSIFIED");
  const classifiedTotal = classified.reduce((s, c) => s + c.cents, 0);
  const drift = settings.target
    ? ASSET_CLASSES.filter((c) => settings.target![c.id] || classified.some((x) => x.cls === c.id)).map(({ id }) => {
        const cents = classified.find((x) => x.cls === id)?.cents ?? 0;
        const targetShare = settings.target![id] ?? 0;
        return { cls: id, currentShare: share(cents, classifiedTotal), targetShare, deltaCents: Math.round(targetShare * classifiedTotal - cents) };
      })
    : null;

  const withRatio = positions.filter((p) => p.expenseRatio != null);
  const knownCents = withRatio.reduce((s, p) => s + Math.max(0, p.valueCents), 0);
  const annualCents = withRatio.reduce((s, p) => s + Math.max(0, p.annualFeeCents ?? 0), 0);

  const taxable = positions.filter((p) => p.treatment === "Taxable" && p.kind !== "CASH" && p.kind !== "ACCOUNT");
  const known = taxable.filter((p) => p.unrealizedCents != null);
  const sum = (xs: PositionRow[], f: (p: PositionRow) => number) => xs.reduce((s, p) => s + f(p), 0);

  const bySecurity = new Map<string, { key: string; symbol: string | null; name: string; cents: number; accounts: Set<string> }>();
  for (const p of positions) {
    if (p.kind === "CASH" || p.kind === "ACCOUNT" || p.weights?.CASH === 1) continue;
    const cur = bySecurity.get(p.key) ?? { key: p.key, symbol: p.symbol, name: p.name, cents: 0, accounts: new Set<string>() };
    cur.cents += p.valueCents;
    cur.accounts.add(p.account);
    bySecurity.set(p.key, cur);
  }
  const unclassified = new Map<string, { key: string; name: string; symbol: string | null; cents: number }>();
  for (const p of positions.filter((x) => !x.weights)) {
    const cur = unclassified.get(p.key) ?? { key: p.key, name: p.kind === "ACCOUNT" ? p.account : p.name, symbol: p.symbol, cents: 0 };
    cur.cents += p.valueCents;
    unclassified.set(p.key, cur);
  }

  return {
    asOf,
    accounts,
    positions,
    totalCents,
    allocation,
    byTreatment,
    drift,
    fees: {
      weightedRatio: knownCents ? annualCents / knownCents : null,
      annualCents,
      knownCents,
      unknownCents: Math.max(0, totalCents - knownCents),
      accountFeesLast12Cents: accounts.reduce((s, a) => s + a.feesLast12Cents, 0),
    },
    gains: {
      taxable: {
        unrealizedCents: sum(known, (p) => p.unrealizedCents!),
        gainCents: sum(known, (p) => Math.max(0, p.unrealizedCents!)),
        lossCents: sum(known, (p) => Math.min(0, p.unrealizedCents!)),
        costKnownCents: sum(known, (p) => p.valueCents),
        costUnknownCents: sum(taxable, (p) => (p.unrealizedCents == null ? p.valueCents : 0)),
      },
      all: {
        unrealizedCents: sum(positions.filter((p) => p.unrealizedCents != null), (p) => p.unrealizedCents!),
        costKnownCents: sum(positions.filter((p) => p.unrealizedCents != null), (p) => p.valueCents),
      },
      harvest: known.filter((p) => p.unrealizedCents! < 0).sort((x, y) => x.unrealizedCents! - y.unrealizedCents!),
    },
    concentration: [...bySecurity.values()]
      .sort((x, y) => y.cents - x.cents)
      .slice(0, 12)
      .map((s) => ({ key: s.key, symbol: s.symbol, name: s.name, cents: s.cents, share: share(s.cents, totalCents), accounts: [...s.accounts] })),
    growth: buildGrowth(book, included.filter((a) => a.isInvestment).map((a) => a.id)),
    unclassified: [...unclassified.values()].sort((x, y) => y.cents - x.cents),
    blockers: [...new Map(accounts.flatMap((a) => a.blockers).map((b) => [b.id, b])).values()],
  };
}

/**
 * Money put in versus what it's worth, quarter by quarter: "invested" is every dollar
 * that entered the account (including the balance its first statement opened with), net
 * of withdrawals; the gap to value is market growth net of fees. A quarter whose figures
 * depend on a missing or failing fact is flagged (`blocked`), not hidden.
 */
function buildGrowth(book: Book, accountIds: string[]): GrowthSeries[] {
  const nw = buildNetWorth(book, { granularity: "quarter" });
  const ids = new Set(accountIds);
  const names = new Map(nw.accounts.map((a) => [a.id, a.name]));
  const series = new Map<string, GrowthSeries>();
  const household: GrowthSeries = { accountId: null, name: "All investment accounts", points: [] };
  const invested = new Map<string, number>();
  for (const p of nw.periods) {
    let hInvested = 0;
    let hValue = 0;
    let any = false;
    for (const a of p.byAccount) {
      if (!ids.has(a.accountId)) continue;
      const inv = (invested.get(a.accountId) ?? 0) + a.newlyTrackedCents + a.contributionsCents;
      invested.set(a.accountId, inv);
      const s = series.get(a.accountId) ?? { accountId: a.accountId, name: names.get(a.accountId) ?? a.accountId, points: [] };
      const blocked = p.blockers.some((b) => !b.accountId || b.accountId === a.accountId);
      if (inv !== 0 || a.closingCents !== 0) s.points.push({ label: p.label, end: p.end, investedCents: inv, valueCents: a.closingCents, blocked });
      series.set(a.accountId, s);
      hInvested += inv;
      hValue += a.closingCents;
      any = true;
    }
    if (any) household.points.push({ label: p.label, end: p.end, investedCents: hInvested, valueCents: hValue, blocked: p.blockers.length > 0 });
  }
  return [household, ...[...series.values()].filter((s) => s.points.length)];
}

/** Days between the oldest and newest account valuations in the report (accounts close on different days). */
export const valuationSpread = (r: InvestmentsReport) =>
  r.accounts.length ? daysBetween(r.accounts.map((a) => a.asOf).sort()[0]!, r.accounts.map((a) => a.asOf).sort().at(-1)!) : 0;
