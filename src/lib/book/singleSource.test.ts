import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Book is the only source of figures. Reading ledger tables directly is allowed only
 * where rows are written or edited (import, classification, transfer matching, the row
 * editors), where the Book itself loads them, and for row and document viewers that show
 * rows or statements as printed (their totals come from the Book: book/rowTotals.ts) —
 * never to compute a figure another page also shows. A new module that needs figures
 * takes a Book (src/lib/book/load.ts) instead of querying.
 */
const ALLOWED: Record<string, string> = {
  "src/lib/book/load.ts": "the Book's loader",
  "src/lib/ledger/loadLedger.ts": "statement timelines (loaded by the Book)",
  "src/lib/ingest/commitDocument.ts": "writes imported statements",
  "src/lib/ingest/importFiles.ts": "replaces a statement read by an older parser",
  "src/lib/ingest/documentFacts.ts": "writes pay stub and brokerage facts",
  "src/lib/ledger/maintenance.ts": "links pay stubs to deposits",
  "src/lib/ledger/resolveAccount.ts": "finds the account a statement being imported belongs to",
  "src/lib/classifier/persist.ts": "writes classifications",
  "src/lib/transfers/runMatching.ts": "writes transfer pairings",
  "src/lib/transfers/applyDecisions.ts": "re-applies the owner's saved transfer pairings",
  "src/lib/transfers/billPayments.ts": "finds the rent payments that pay a landlord's bill (for runMatching)",
  "src/lib/review/rowDecisions.ts": "re-applies the owner's saved row-by-row review answers",
  "src/lib/backup/backup.ts": "copies the database file (no figures)",
  "src/lib/db.ts": "the database connection (sets SQLite PRAGMAs)",
  "src/app/api/transactions/route.ts": "row viewer: lists rows; totals come from the Book",
  "src/app/api/transactions/[id]/route.ts": "row editor",
  "src/app/api/transfers/route.ts": "transfer review queue",
  "src/app/api/transfers/[id]/route.ts": "transfer editor",
  "src/app/api/ledger/review/route.ts": "classification review queue",
  "src/app/api/ledger/attention/route.ts": "count of rows in the review queue (a work count, not a figure)",
  "src/app/api/dashboard/home-summary/route.ts": "count of rows in the review queue (a work count, not a figure)",
  "src/app/api/accounts/route.ts": "account list with how many statements and rows each has (counts, no money)",
  "src/app/api/accounts/[id]/route.ts": "account editor (rename, archive, merge)",
  "src/app/api/statements/route.ts": "document viewer: each statement's balances as printed",
  "src/app/api/statements/[id]/route.ts": "document editor",
  "src/app/api/statements/[id]/commit/route.ts": "commits a held statement",
  "src/app/api/documents/[id]/route.ts": "deletes a document and what it contributed",
  "src/app/api/export/transactions/route.ts": "raw row export (with whether the Book counts each row)",
  "src/app/api/health/db/route.ts": "database health check (counts, applied migrations)",
  "src/app/api/settings/database/browse/route.ts": "raw table browser (Settings → Database)",
  "src/app/api/settings/database/export/route.ts": "copies the database file",
  "src/app/api/settings/database/import/route.ts": "validates and replaces the database file",
  "src/app/api/settings/database/wipe/route.ts": "empties the database",
};

/** Every table that holds statements, rows, stubs or what's derived from them. */
const LEDGER_TABLES = [
  "account",
  "accountAlias",
  "sourceDocument",
  "statementImport",
  "transaction",
  "payStub",
  "payStubLine",
  "brokerageTaxFacts",
  "holdingSnapshot",
  "transferMatch",
  "transferLeg",
  "transferRejection",
];
const READ = new RegExp(`\\.(${LEDGER_TABLES.join("|")})\\.(findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|aggregate|groupBy|count)\\b`);
/** Raw SQL, or table access by a computed name (the guard can't see which table). */
const RAW = /\$queryRaw|\$queryRawUnsafe|\$executeRaw|as unknown as Record<string, \w+>\)\[/;
/** A nested select of a ledger relation from some other table (sourceDocument → statementImports…). */
const NESTED = /\b(statementImports|transactions|payStubs|lines|legs|transferLeg|holdingSnapshots)\s*:\s*\{\s*(select|where|include|orderBy)\b/;
const ROOT = path.resolve(__dirname, "../../..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");
const src = (r: string) => readFileSync(path.join(ROOT, r), "utf8");

/** Modules that compute or show figures: they take a Book, never the database. */
const FIGURE_MODULES = [
  "src/lib/book/reports",
  "src/lib/book/checks",
  "src/lib/book/proof",
  "src/lib/profile",
  "src/lib/tax",
  "src/lib/fire",
  "src/lib/forecast",
  "src/lib/dashboard",
  "src/lib/hsa",
  "src/lib/car",
  "src/lib/home-budget",
  "src/lib/mortgage",
  "src/lib/goals",
  "src/lib/investments",
];
/** Settings stores (AppSetting) are inputs, not ledger figures; loaders join the cached Book to them. */
const SETTINGS_STORES = /(profile\/settings|tax\/profile|forecast\/load|hsa\/loadReport|book\/proof\/types)\.ts$/;

describe("single source of truth", () => {
  it("only the Book and the row writers/editors/viewers read ledger tables", () => {
    const offenders = files(path.join(ROOT, "src"))
      .map(rel)
      .filter((r) => !(r in ALLOWED))
      .filter((r) => {
        const s = src(r);
        return READ.test(s) || RAW.test(s) || (/prisma|\bdb\b|\btx\b/.test(s) && NESTED.test(s) && /\.(findMany|findFirst|findUnique)\(/.test(s));
      });
    expect(offenders, "Compute figures from a Book (src/lib/book) instead of querying ledger tables").toEqual([]);
  });

  it("every allowed reader still exists and still needs the exception", () => {
    const stale = Object.keys(ALLOWED).filter((r) => {
      try {
        const s = src(r);
        return !(READ.test(s) || RAW.test(s) || /prisma\.|db\.|tx\./.test(s));
      } catch {
        return true;
      }
    });
    expect(stale, "Remove ALLOWED entries that no longer read the database").toEqual([]);
  });

  it("reports and modules that show figures never import the database", () => {
    const offenders = FIGURE_MODULES.flatMap((d) => files(path.join(ROOT, d)))
      .map(rel)
      .filter((r) => /from "(\.\.\/)+db(\.ts)?"|from "@\/lib\/db"/.test(src(r)) || (/@prisma\/client/.test(src(r)) && !/import type/.test(src(r).match(/.*@prisma\/client.*/)?.[0] ?? "")))
      .filter((r) => !SETTINGS_STORES.test(r));
    expect(offenders).toEqual([]);
  });

  it("figure modules take the date from the Book, not the clock", () => {
    // book.today is the one "today": a figure built from the clock can disagree with the
    // Book it's built from (a request that crosses midnight, a test with a fixed date).
    const offenders = FIGURE_MODULES.flatMap((d) => files(path.join(ROOT, d)))
      .map(rel)
      // Settings and receipt stores stamp when something was saved; that's not a figure's date.
      .filter((r) => !/settings\.ts$|tax\/profile\.ts$|hsa\/store\.ts$/.test(r))
      .filter((r) => /new Date\(\)|Date\.now\(\)|localToday\(\)/.test(src(r)));
    expect(offenders, "Use book.today (or a date passed in) instead of the clock").toEqual([]);
  });
});
