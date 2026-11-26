/**
 * How long each report the server keeps warm takes to answer (src/lib/warmList.ts), on a
 * running server: node scripts/endpoint-timings.ts <base-url>. Each is asked twice: the first
 * answer waits for the Book and the report to be built (the server builds them as it starts),
 * the second comes from the report cache. Prints a table, slowest first, and writes it as JSON
 * to ENDPOINT_TIMINGS_OUT when set. ENDPOINT_BUDGET_MS fails the run when a cached answer is
 * slower than that (off by default: CI only reports, so a slow runner can't fail a build).
 *
 * scripts/demo.ts runs it with --timings, before the render audit, on the demo's own server.
 */
import { writeFileSync } from "node:fs";
import { WARM_LAST, WARM_REPORTS, WARM_UPKEEP_REPORTS } from "../src/lib/warmList.ts";

export type Timing = { path: string; status: number; firstMs: number; cachedMs: number; kb: number };

async function time(base: string, p: string): Promise<{ status: number; ms: number; bytes: number }> {
  const t0 = performance.now();
  const r = await fetch(base + p).catch(() => null);
  const body = r ? await r.arrayBuffer().catch(() => new ArrayBuffer(0)) : new ArrayBuffer(0);
  return { status: r?.status ?? 0, ms: performance.now() - t0, bytes: body.byteLength };
}

export async function endpointTimings(base: string, paths = [...WARM_REPORTS, ...WARM_UPKEEP_REPORTS, ...WARM_LAST]): Promise<Timing[]> {
  const out: Timing[] = [];
  for (const p of paths) {
    const first = await time(base, p);
    const again = await time(base, p);
    out.push({ path: p, status: again.status, firstMs: Math.round(first.ms), cachedMs: Math.round(again.ms), kb: Math.round(again.bytes / 102.4) / 10 });
  }
  return out.sort((a, b) => b.firstMs - a.firstMs);
}

export function timingTable(t: Timing[]): string {
  const rows = t.map((x) => `${x.path.padEnd(52)} ${String(x.status).padStart(3)}  first ${String(x.firstMs).padStart(6)} ms  cached ${String(x.cachedMs).padStart(5)} ms  ${String(x.kb).padStart(7)} KB`);
  return ["Endpoint timings (the warm list, src/lib/warmList.ts):", ...rows].join("\n");
}

if (process.argv[1]?.endsWith("endpoint-timings.ts")) {
  const base = process.argv[2];
  if (!base) {
    console.error("Usage: node scripts/endpoint-timings.ts <base-url>");
    process.exit(2);
  }
  const t = await endpointTimings(base);
  console.log(timingTable(t));
  if (process.env.ENDPOINT_TIMINGS_OUT) writeFileSync(process.env.ENDPOINT_TIMINGS_OUT, JSON.stringify(t, null, 2) + "\n");
  const budget = Number(process.env.ENDPOINT_BUDGET_MS ?? 0);
  const slow = budget ? t.filter((x) => x.cachedMs > budget || x.status >= 400) : t.filter((x) => x.status >= 400);
  if (slow.length) {
    console.error(`${slow.length} endpoint(s) failed${budget ? ` or answered from the cache slower than ${budget} ms` : ""}: ${slow.map((x) => x.path).join(", ")}`);
    process.exit(1);
  }
}
