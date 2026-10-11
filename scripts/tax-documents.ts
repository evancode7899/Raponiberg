/**
 * Reads the tax documents folder (filed returns, W-2s, 1099s, K-1s) into
 * data/tax-documents.json, then prints each year's check of the app against the filed
 * return: the lines that don't match, the forms that disagree with the ledger, and the
 * inputs that would close the gaps. Same check as the Taxes page's "Filed return" tab.
 *
 * Usage:
 *   node scripts/tax-documents.ts [folder] [year…]
 *
 *   folder   the tax documents folder (default: TAX_DOCS_DIR)
 *   year     only check these years (default: every year with a filed return and tax tables)
 */
import { loadBook } from "../src/lib/book/load.ts";
import { prisma } from "../src/lib/db.ts";
import { buildTaxReport } from "../src/lib/tax/buildTaxReport.ts";
import { TAX_YEARS } from "../src/lib/tax/params.ts";
import { scanTaxDocs } from "../src/lib/taxdocs/scan.ts";
import { taxDocsDir, writeTaxDocs } from "../src/lib/taxdocs/store.ts";

const args = process.argv.slice(2);
const folder = args.find((a) => !/^\d{4}$/.test(a)) ?? taxDocsDir();
const only = args.filter((a) => /^\d{4}$/.test(a)).map(Number);
if (!folder) {
  console.error("No folder: pass one, or set TAX_DOCS_DIR in .env.");
  process.exit(1);
}

const started = Date.now();
const file = await scanTaxDocs(folder);
writeTaxDocs(file);
console.log(`Read ${file.docs.length} documents from ${folder} in ${Date.now() - started}ms.`);
for (const e of file.errors) console.log(`  could not read ${e.file}: ${e.error}`);
for (const d of file.docs.filter((x) => !x.superseded && x.warnings.length)) console.log(`  ${d.file}: ${d.warnings.join(" ")}`);

const usd = (c: number | null) => (c == null ? "—" : `$${Math.round(c / 100).toLocaleString("en-US")}`);
const book = await loadBook(prisma);
const years = [...new Set(file.docs.filter((d) => d.kind.startsWith("RETURN_") && !d.superseded && d.year && TAX_YEARS[d.year]).map((d) => d.year!))]
  .filter((y) => !only.length || only.includes(y))
  .sort();
for (const year of years) {
  const r = buildTaxReport(book, year);
  if (r.blocked || !r.documents?.check) {
    console.log(`\n${year}: no check (${r.blocked ? "blocked" : "no filed federal or CT return"}).`);
    continue;
  }
  const c = r.documents.check;
  const lines = [...c.federal, ...c.ct];
  console.log(`\n${year}: federal ${c.summary.federal ?? "—"}, Connecticut ${c.summary.ct ?? "—"} · ${lines.filter((l) => l.status === "MATCH").length} of ${lines.length} lines match to the dollar`);
  for (const l of lines.filter((x) => x.status !== "MATCH")) {
    const v = (n: number | null) => (l.percent ? (n == null ? "—" : `${(n / 100).toFixed(2)}%`) : usd(n));
    console.log(`  ${l.status.padEnd(10)} ${l.where.padEnd(24)} ${l.label.padEnd(42)} filed ${v(l.filed).padStart(10)}  app ${v(l.model).padStart(10)}${l.note ? `\n             ${l.note}` : ""}`);
  }
  for (const s of c.sources.filter((x) => x.status === "DIFFERENT")) console.log(`  FORM≠LEDGER ${s.label}: form ${usd(s.documentValue)}, ledger ${usd(s.ledgerValue)}${s.note ? ` — ${s.note}` : ""}`);
  for (const s of c.suggestions) console.log(`  SUGGESTED  ${s.text}`);
  if (c.amendment) console.log(`  AMENDMENT  ${c.amendment.reason} Federal ${usd(c.amendment.federal)}, CT ${usd(c.amendment.ct)}.`);
}
await prisma.$disconnect();
