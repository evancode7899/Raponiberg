import type { NetWorthChange } from "../book/reports/netWorthChanges.ts";
import type { ProofDescriptor } from "../book/proof/index.ts";
import type { Forecast } from "./forecast.ts";

/**
 * Forecast against actual: each saved forecast (snapshots.ts) held to the months that have
 * since been proven, line by line, and whether it runs high or low. The forecast side is the
 * snapshot as it was saved; the actual side is Net worth › What changed's months (income and
 * spending from Cash flow, saving and markets from net worth), each with its proof. Pure.
 */

export const VS_LINES = ["income", "spending", "saved", "markets", "change"] as const;
export type VsLine = (typeof VS_LINES)[number];

export const VS_LABEL: Record<VsLine, string> = {
  income: "Income",
  spending: "Spending",
  saved: "Saved",
  markets: "Markets",
  change: "Change in net worth",
};

/** How the forecast's month is read for each line. */
const FORECAST_WORDS: Record<VsLine, string> = {
  income: "take-home pay and bonuses kept",
  spending: "living cost, planned one-offs and the part of bonuses spent",
  saved: "everything the forecast adds: base savings and bonuses saved",
  markets: "growth at the forecast's return",
  change: "net worth at the month's end less the month before",
};

/** One projected month as kept: each line in cents. */
export type SnapshotMonth = { key: string } & Record<VsLine, number>;

export type ForecastSnapshot = {
  id: string;
  /** When it was kept (ISO time). */
  savedAt: string;
  /** Why: settings saved, or kept by hand. */
  reason: string;
  /** The month its starting balances are from (YYYY-MM): it projects the months after. */
  startKey: string;
  months: SnapshotMonth[];
};

/** How many months ahead a snapshot keeps. */
export const SNAPSHOT_MONTHS = 24;

export function snapshotOf(f: Pick<Forecast, "months" | "startKey">, savedAt: string, reason: string): ForecastSnapshot {
  let prev: number | null = null;
  const months = f.months.slice(0, SNAPSHOT_MONTHS + 1).flatMap((m, i): SnapshotMonth[] => {
    const before = i === 0 ? null : prev;
    prev = m.netWorth;
    // The first month's change needs the balance before it: kept from the month after on.
    if (i === 0 && m.key === f.startKey) return [];
    return [
      {
        key: m.key,
        income: Math.round(m.takeHome + m.bonusKept),
        spending: Math.round(m.livingCost + m.planned + (m.bonusKept - m.bonusSaved)),
        saved: Math.round(m.saved),
        markets: Math.round(m.growth),
        change: before == null ? Math.round(m.saved + m.growth) : Math.round(m.netWorth - before),
      },
    ];
  });
  return { id: savedAt, savedAt, reason, startKey: f.startKey, months: months.slice(0, SNAPSHOT_MONTHS) };
}

/** What one proven month actually was, by line, with each figure's proof. */
const ACTUAL: Record<VsLine, (c: NetWorthChange) => [number, ProofDescriptor]> = {
  income: (c) => [c.incomeCents, c.proofs.income],
  spending: (c) => [c.spendingCents, c.proofs.spending],
  saved: (c) => [c.savedCents, c.proofs.saved],
  markets: (c) => [c.marketsCents, c.proofs.markets],
  change: (c) => [c.changeCents, c.proofs.change],
};

export type VsRow = {
  line: VsLine;
  forecastCents: number;
  actualCents: number;
  /** Forecast less actual: above zero, the forecast ran high. */
  missCents: number;
  /** Months the forecast was above the actual, of `months`. */
  high: number;
  months: { key: string; forecast: number; actual: number; proof: ProofDescriptor }[];
};

export type VsSnapshot = { id: string; savedAt: string; reason: string; from: string; through: string; months: number; rows: VsRow[]; forecastWords: Record<VsLine, string> };

/**
 * Each snapshot against the proven months it projected: whole months only, from its first
 * projected month through the latest one proven. A snapshot no proven month has reached yet
 * is left out; one month is enough to compare.
 */
export function forecastVsActual(snapshots: readonly ForecastSnapshot[], changes: readonly NetWorthChange[]): VsSnapshot[] {
  const proven = new Map(changes.filter((c) => !c.through).map((c) => [c.start.slice(0, 7), c]));
  return snapshots.flatMap((s): VsSnapshot[] => {
    // The months must run unbroken from the snapshot's first: a gap stops the comparison there.
    const run: SnapshotMonth[] = [];
    for (const m of s.months) {
      if (!proven.has(m.key)) break;
      run.push(m);
    }
    if (!run.length) return [];
    const rows = VS_LINES.map((line): VsRow => {
      const months = run.map((m) => {
        const [actual, proof] = ACTUAL[line](proven.get(m.key)!);
        return { key: m.key, forecast: m[line], actual, proof };
      });
      const forecastCents = months.reduce((t, m) => t + m.forecast, 0);
      const actualCents = months.reduce((t, m) => t + m.actual, 0);
      return { line, forecastCents, actualCents, missCents: forecastCents - actualCents, high: months.filter((m) => m.forecast > m.actual).length, months };
    });
    return [{ id: s.id, savedAt: s.savedAt, reason: s.reason, from: run[0]!.key, through: run.at(-1)!.key, months: run.length, rows, forecastWords: FORECAST_WORDS }];
  });
}

/** Which way the forecast leans: overall (its miss), then how many months it was above what happened. */
export function leaning(r: Pick<VsRow, "high" | "months" | "missCents">): string {
  const overall = Math.abs(r.missCents) < 100 ? "on the mark overall" : r.missCents > 0 ? "high overall" : "low overall";
  return `${overall}; above in ${r.high} of ${r.months.length} month${r.months.length === 1 ? "" : "s"}`;
}

/** One line's calibration: every proven month, each held to the forecast as it stood going into it. */
export type CalRow = { line: VsLine; months: { key: string; snapshot: string; forecast: number; actual: number }[]; forecastCents: number; actualCents: number; missCents: number; /** The miss as a share of what actually happened (above zero: runs high); null when that's zero. */ share: number | null };

/**
 * How far to trust the forecast, line by line: each proven month any kept forecast projected,
 * against the newest forecast kept before that month began (the forecast as it stood going
 * in), so a month counts once however many forecasts projected it. Null with no such month.
 */
export function calibration(vs: readonly VsSnapshot[]): CalRow[] | null {
  const going = new Map<string, VsSnapshot>();
  for (const s of [...vs].sort((a, b) => a.savedAt.localeCompare(b.savedAt)))
    for (const m of s.rows[0]?.months ?? []) if (s.savedAt.slice(0, 7) < m.key) going.set(m.key, s);
  if (!going.size) return null;
  const keys = [...going.keys()].sort();
  return VS_LINES.map((line) => {
    const months = keys.map((key) => {
      const s = going.get(key)!;
      const m = s.rows.find((r) => r.line === line)!.months.find((x) => x.key === key)!;
      return { key, snapshot: s.id, forecast: m.forecast, actual: m.actual };
    });
    const forecastCents = months.reduce((t, m) => t + m.forecast, 0);
    const actualCents = months.reduce((t, m) => t + m.actual, 0);
    const missCents = forecastCents - actualCents;
    return { line, months, forecastCents, actualCents, missCents, share: actualCents ? missCents / Math.abs(actualCents) : null };
  });
}
