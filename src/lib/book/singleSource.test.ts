import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Book is the only source of figures. Reading ledger tables directly is allowed only
 * where rows are written or edited (import, classification, transfer matching, the row
 * editors), where the Book itself loads them, and for row viewers that report counts of
 * what they list — never to compute a figure another page also shows. A new module that
 * needs figures takes a Book (src/lib/book/load.ts) instead of querying.
 */
const ALLOWED: Record<string, string> = {
  "src/lib/book/load.ts": "the Book's loader",
  "src/lib/ledger/loadLedger.ts": "statement timelines (loaded by the Book)",
  "src/lib/ingest/commitDocument.ts": "writes imported statements",
  "src/lib/ingest/documentFacts.ts": "writes pay stub and brokerage facts",
  "src/lib/ledger/maintenance.ts": "links pay stubs to deposits",
  "src/lib/classifier/persist.ts": "writes classifications",
  "src/lib/transfers/runMatching.ts": "writes transfer pairings",
  "src/lib/transfers/applyDecisions.ts": "re-applies the owner's saved transfer pairings",
  "src/lib/review/rowDecisions.ts": "re-applies the owner's saved row-by-row review answers",
  "src/app/api/transactions/route.ts": "row viewer: lists rows and totals what it lists",
  "src/app/api/transactions/[id]/route.ts": "row editor",
  "src/app/api/transfers/route.ts": "transfer review queue",
  "src/app/api/transfers/[id]/route.ts": "transfer editor",
  "src/app/api/ledger/review/route.ts": "classification review queue",
  "src/app/api/ledger/attention/route.ts": "count of rows awaiting classification",
  "src/app/api/dashboard/home-summary/route.ts": "count of rows awaiting classification",
  "src/app/api/statements/[id]/route.ts": "document editor",
  "src/app/api/statements/[id]/commit/route.ts": "commits a held statement",
  "src/app/api/documents/[id]/route.ts": "document viewer",
  "src/app/api/export/transactions/route.ts": "raw row export",
  "src/app/api/health/db/route.ts": "database health check",
};

const READ = /\.(transaction|payStub|payStubLine|statementImport|brokerageTaxFacts|holdingSnapshot|transferMatch|transferLeg)\.(findMany|findFirst|findUnique|aggregate|groupBy|count)\b/;
const ROOT = path.resolve(__dirname, "../../..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) && !/\.test\.ts$/.test(f) ? [p] : [];
  });
}

describe("single source of truth", () => {
  it("only the Book and the row writers/editors read ledger tables", () => {
    const offenders = files(path.join(ROOT, "src"))
      .map((p) => path.relative(ROOT, p).split(path.sep).join("/"))
      .filter((rel) => READ.test(readFileSync(path.join(ROOT, rel), "utf8")) && !(rel in ALLOWED));
    expect(offenders, "Compute figures from a Book (src/lib/book) instead of querying ledger tables").toEqual([]);
  });

  it("reports and modules that show figures never import the database", () => {
    const figureModules = ["src/lib/book/reports", "src/lib/profile", "src/lib/tax", "src/lib/book/checks"];
    const offenders = figureModules
      .flatMap((d) => files(path.join(ROOT, d)))
      .map((p) => path.relative(ROOT, p).split(path.sep).join("/"))
      .filter((rel) => /from "(\.\.\/)+db(\.ts)?"|from "@\/lib\/db"|@prisma\/client/.test(readFileSync(path.join(ROOT, rel), "utf8")))
      // Settings stores (AppSetting) are inputs, not ledger figures.
      .filter((rel) => !/profile\/settings\.ts$|tax\/profile\.ts$/.test(rel));
    expect(offenders).toEqual([]);
  });
});
