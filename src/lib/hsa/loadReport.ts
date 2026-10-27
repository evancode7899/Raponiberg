import type { Prisma, PrismaClient } from "@prisma/client";
import { cachedReport } from "../book/cache.ts";
import { taxLink } from "../forecast/forecast.ts";
import { loadForecast } from "../forecast/load.ts";
import { loadJsonSetting } from "../settingsStore.ts";
import { normalizeRetirementSettings, RETIREMENT_SETTINGS_KEY } from "../taxAccounts/settings.ts";
import { hsaLedger, hsaLinkedRates, hsaTaxMarginal, type HsaLedger } from "./load.ts";
import { scanHsaReceipts } from "./receiptScan.ts";
import { buildHsaReport, type HsaReport, type TaxMarginalIn } from "./report.ts";
import { readHsaFile } from "./store.ts";

/**
 * The HSA page's report, as GET /api/hsa serves it: the receipts log and the receipts
 * folder (read fresh, neither is in the Book) joined to the cached Book-derived ledger. The proof drawer reads the same
 * thing, so what it proves is exactly what the page shows.
 */
export async function loadHsaReport(db: PrismaClient | Prisma.TransactionClient): Promise<HsaReport> {
  const file = readHsaFile();
  const [ledger, retirement, receipts] = await Promise.all([
    cachedReport(db, "hsa-ledger", async (book) => {
      // The Taxes page's marginal rates, on the same forecast it uses (birth years are the Book's).
      const { forecast, data } = await loadForecast(db, book);
      return { ...hsaLedger(book), today: book.today, linked: hsaLinkedRates(book, forecast, data.profile.seeds), taxMarginal: hsaTaxMarginal(book, Number(book.today.slice(0, 4)), forecast ? taxLink(forecast) : null) };
    }).then((t) => JSON.parse(t) as HsaLedger & { today: string; linked: ReturnType<typeof hsaLinkedRates>; taxMarginal: TaxMarginalIn | null }),
    loadJsonSetting(db, RETIREMENT_SETTINGS_KEY, normalizeRetirementSettings),
    scanHsaReceipts(),
  ]);
  return buildHsaReport({ file, ...ledger, marginalRate: retirement.marginalRate, receipts });
}
