/**
 * Runs once when the server starts: builds the Book in the background, and again shortly
 * after each change to the data, along with the main pages' reports, so pages find them
 * ready (see lib/book/cache.ts). Also starts the OneDrive backups (lib/backup).
 *
 * The Node-only work lives behind `process.env.NEXT_RUNTIME === "nodejs"` written inline:
 * webpack also compiles this file for the edge runtime, and only that exact condition
 * lets it drop the import of node:fs-using modules from the edge bundle.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.NEXT_PHASE === "phase-production-build") return;
    const [{ prisma }, { keepBookWarm }, { startAutoBackup }] = await Promise.all([import("@/lib/db"), import("@/lib/book/cache"), import("@/lib/backup/auto")]);
    // The desktop app (next start) backs up to OneDrive; dev servers only when asked; the demo never.
    const backs = process.env.NODE_ENV === "production" || process.env.BACKUP_AUTO === "1";
    if (process.env.BACKUP_AUTO !== "0" && process.env.APP_PROFILE !== "demo" && backs) startAutoBackup(prisma);
    // Statements an updated parser reads differently are read again, then facts stored by
    // an older extractor (FACTS_VERSION) are re-extracted, so either change reaches the
    // figures on the next launch (the Book rebuilds once they're in). The facts step runs
    // even if the re-read failed; a re-read that imported anything has already done it.
    void import("@/lib/ingest/importFiles")
      .then(({ rereadOutdatedStatements }) => rereadOutdatedStatements(prisma))
      .then((n) => n > 0 && console.log(`Re-read ${n} statement(s) with updated parsers`))
      .catch((e) => console.error("Re-reading outdated statements failed:", e instanceof Error ? e.message : e))
      .then(() => import("@/lib/ledger/maintenance"))
      .then(({ refreshOutdatedFactsOnLaunch }) => refreshOutdatedFactsOnLaunch(prisma))
      .then((r) => {
        if (!r) return;
        console.log(`Re-extracted facts for ${r.factsRefreshed} document(s) with updated extractors`);
        for (const f of r.factsFailed) console.error(`Re-extracting facts failed for ${f.title}: ${f.error}`);
      })
      .catch((e) => console.error("Re-extracting outdated facts failed:", e instanceof Error ? e.message : e));
    keepBookWarm(prisma, {
      reports: [
        "/api/ledger/attention",
        "/api/dashboard/home-summary",
        "/api/dashboard/net-worth?granularity=month",
        "/api/dashboard/cash-flow",
        "/api/integrity",
        "/api/profile",
        "/api/forecast",
        "/api/tax",
        "/api/investments",
        "/api/tax-accounts",
        "/api/goals",
        "/api/car",
        "/api/bonuses",
        "/api/home-budget/funds",
        "/api/dashboard/net-worth/accounts",
        // Last: it opens every figure's proof, so the reports above are cached by then.
        "/api/proof/sweep",
      ],
    });
  }
}
