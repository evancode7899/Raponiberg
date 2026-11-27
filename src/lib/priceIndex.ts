import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "./dataDir.ts";
import { indexChange, type IndexSeries, type PriceIndexFile } from "./priceIndexMath.ts";

export { indexChange };
export type { IndexSeries, PriceIndexFile };

/**
 * Published price series the app reads but never fetches (data/price-index.json): the
 * consumer price index for Cash flow (personal inflation beside CPI, spending in today's
 * dollars). Investment returns' benchmark is a fund the household holds, from its own statements
 * (book/reports/fundBenchmark.ts), never this file. Claude refreshes the file in
 * chat from the publisher's own download, each series saying where it came from and when.
 * In the Book's stamp (a figure reads it), so a refresh rebuilds what uses it.
 */
export const priceIndexFile = () => process.env.PRICE_INDEX_FILE || path.join(dataDir(), "price-index.json");

/** The file, or no series when there's none. A damaged file is an error, never read as empty. */
export function readPriceIndex(file = priceIndexFile()): PriceIndexFile {
  if (!existsSync(file)) return { version: 1, series: {} };
  let f: Partial<PriceIndexFile>;
  try {
    f = JSON.parse(readFileSync(file, "utf8")) as Partial<PriceIndexFile>;
  } catch {
    throw new Error(`${path.basename(file)} is damaged (not valid JSON). Restore it from a backup, or ask Claude to fetch the series again.`);
  }
  if (typeof f.version === "number" && f.version > 1) throw new Error(`${path.basename(file)} was written by a newer version of the app.`);
  const series: Record<string, IndexSeries> = {};
  for (const [id, s] of Object.entries(f.series ?? {})) {
    if (!s || typeof s !== "object" || typeof s.months !== "object") continue;
    const months = Object.fromEntries(Object.entries(s.months).filter(([k, v]) => /^\d{4}-\d{2}$/.test(k) && typeof v === "number" && v > 0));
    series[id] = { name: String(s.name ?? id), source: String(s.source ?? ""), url: String(s.url ?? ""), fetchedOn: String(s.fetchedOn ?? ""), kind: s.kind === "total-return" ? "total-return" : "price", months };
  }
  return { version: 1, series };
}
