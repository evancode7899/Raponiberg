/**
 * The render audit's plan (scripts/render-audit.ts): which units a run draws and on which
 * shard, how a slow tab is split into parts, how the parts are put back together, and where a
 * fresh drawing first differs from a kept one. Pure, so it's tested (src/lib/renderAuditPlan.test.ts).
 */
import { tabKey, unitKey, unitName, type RawView, type Unit, type UnitRun } from "./render-audit-drive.ts";

/** A tab (or part of one) and what it took last time. */
export type Cost = Unit & { ms: number };

export const byCost = (a: Cost, b: Cost) => b.ms - a.ms || unitKey(a).localeCompare(unitKey(b));

/**
 * Splits each tab that costs more than its share of the run (the work spread over every
 * worker of every shard, twice over) into parts, each a unit of its own. `forced` names a
 * tab's part count outright (a kept tab drawn again to check it, as it was kept).
 */
export function withParts(tabs: readonly Cost[], o: { workers: number; shards: number; split: boolean; minPartMs: number; maxParts: number }, forced: ReadonlyMap<string, number> = new Map()): Cost[] {
  const total = tabs.reduce((n, u) => n + u.ms, 0);
  const target = Math.max(o.minPartMs, total / (o.workers * o.shards * 2));
  return tabs
    .flatMap((u): Cost[] => {
      const n = forced.get(tabKey(u)) ?? (o.split ? Math.min(o.maxParts, Math.max(1, Math.ceil(u.ms / target))) : 1);
      return n === 1 ? [{ ...u, part: null }] : Array.from({ length: n }, (_, i) => ({ ...u, part: { i, n }, ms: u.ms / n }));
    })
    .sort(byCost);
}

/** Deals the planned units to n shards, busiest first, each to the least loaded so far (a tie to the first): the same deal on every shard. */
export function deal(units: readonly Cost[], n: number): Cost[][] {
  const shards = Array.from({ length: n }, () => ({ ms: 0, units: [] as Cost[] }));
  for (const u of units) {
    const s = shards.reduce((a, b) => (b.ms < a.ms ? b : a));
    s.units.push(u);
    s.ms += u.ms;
  }
  return shards.map((s) => s.units);
}

const viewSig = (v: RawView) => JSON.stringify([v.figures, v.strays, v.whatIf ?? []]);

/**
 * One run per tab from its parts (a tab not split is its own): views in part order, a view
 * two parts both drew kept once (with the drawers each opened from it), the tab list part 0
 * read. A tab missing a part comes back with an error saying so.
 */
export function mergeParts(runs: readonly UnitRun[]): UnitRun[] {
  const byTab = new Map<string, UnitRun[]>();
  for (const r of runs) byTab.set(tabKey(r), [...(byTab.get(tabKey(r)) ?? []), r]);
  return [...byTab.values()].map((parts) => {
    if (parts.length === 1 && !parts[0]!.part) return parts[0]!;
    parts.sort((a, b) => (a.part?.i ?? 0) - (b.part?.i ?? 0));
    const n = parts[0]!.part?.n ?? 1;
    const views: RawView[] = [];
    const at = new Map<string, RawView>();
    for (const p of parts)
      for (const v of p.views) {
        const sig = viewSig(v);
        const kept = at.get(sig);
        if (kept && !v.errors.length) {
          if (v.rawDrawers?.length) kept.rawDrawers = [...(kept.rawDrawers ?? []), ...v.rawDrawers.filter((d) => !kept.rawDrawers?.some((k) => k.key === d.key))];
          continue;
        }
        const copy = { ...v };
        if (!v.errors.length) at.set(sig, copy);
        views.push(copy);
      }
    const have = new Set(parts.map((p) => p.part?.i ?? 0));
    const missing = Array.from({ length: n }, (_, i) => i).filter((i) => !have.has(i));
    const first = parts[0]!;
    if (missing.length) views.push({ view: unitName({ ...first, part: null }), figures: [], strays: [], errors: [`Part(s) ${missing.map((i) => `${i + 1}/${n}`).join(", ")} of this tab weren't audited.`] });
    return {
      route: first.route,
      tab: first.tab,
      part: { i: 0, n },
      views,
      ms: parts.reduce((s, p) => s + p.ms, 0),
      ...(first.skipped ? { skipped: first.skipped } : {}),
      ...(parts.find((p) => p.tabs) ? { tabs: parts.find((p) => p.tabs)!.tabs } : {}),
      draws: parts.reduce((s, p) => s + p.draws, 0),
      repeats: parts.reduce((s, p) => s + p.repeats, 0),
      drawers: parts.reduce((s, p) => s + p.drawers, 0),
      asked: [...new Map(parts.flatMap((p) => p.asked ?? []).map((a) => [JSON.stringify(a), a])).values()],
    };
  });
}

/**
 * A tab's recording as a whole, for comparing a kept one with a fresh drawing: everything drawn,
 * the drawers' tokens and proofs, the tabs listed, each part as a list of its own (the data
 * stamp each proof carries read past: it moves on every launch).
 */
const runParts = (r: UnitRun, stamp: string) => [
  ["tabs", JSON.stringify([r.skipped ?? null, r.tabs ?? null])],
  ...r.views.map((v) => [v.view, JSON.stringify([v.figures, v.strays, v.chart ?? [], v.whatIf ?? [], v.rawDrawers ?? []]).split(stamp).join("~stamp~")]),
];
/** Where a fresh drawing first differs from the kept one: which view, and which of its parts (no drawn value, so it can be said on real data too). */
export function firstDiff(fresh: UnitRun, freshStamp: string, kept: UnitRun, keptStamp: string): string | null {
  const a = runParts(fresh, freshStamp);
  const b = runParts(kept, keptStamp);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const [x, y] = [a[i], b[i]];
    if (!x || !y) return `${x ? "a view more" : "a view fewer"} than kept: ${(x ?? y)![0]}`;
    if (x[0] !== y[0]) return `view ${i} is "${x[0]}" now, "${y[0]}" kept`;
    if (x[1] !== y[1]) {
      const fields = ["figures", "strays", "chart", "what-if", "drawers"];
      const [p, q] = [JSON.parse(x[1]!) as unknown[], JSON.parse(y[1]!) as unknown[]];
      let which = x[0] === "tabs" ? "the tab list" : fields.filter((_, k) => JSON.stringify(p[k]) !== JSON.stringify(q[k])).join(", ");
      if (which === "drawers") {
        // Which drawer, and what of it: the figures opened, what one drew, or the proof it was answered.
        const [dp, dq] = [p[4] as Record<string, unknown>[], q[4] as Record<string, unknown>[]];
        const keys = (d: Record<string, unknown>[]) => JSON.stringify(d.map((z) => z.key));
        if (keys(dp) !== keys(dq)) which = `drawers (${dp.length} opened now, ${dq.length} kept; other figures)`;
        else {
          const k = dp.findIndex((z, j) => JSON.stringify(z) !== JSON.stringify(dq[j]));
          const part = ["tokens", "proof", "perMonths", "none"].filter((f) => JSON.stringify(dp[k]![f]) !== JSON.stringify(dq[k]![f]));
          which = `drawer ${k + 1} of ${dp.length} (its ${part.join(", ")}${part.includes("tokens") ? `: ${(dp[k]!.tokens as unknown[] | undefined)?.length ?? 0} drawn now, ${(dq[k]!.tokens as unknown[] | undefined)?.length ?? 0} kept` : ""})`;
        }
      }
      return `"${x[0]}" differs in ${which}`;
    }
  }
  return null;
}
export const clean = (r: UnitRun) => !r.views.some((v) => v.errors.length);
