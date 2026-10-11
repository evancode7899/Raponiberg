/**
 * Prints the Book's integrity report: every check's tally, then the open findings (what
 * blocks which figures and what to fetch or fix). Same report as the Integrity page.
 *
 * Usage:
 *   node scripts/integrity.ts [check-prefix]
 *
 *   check-prefix   only list findings whose check starts with it (e.g. "pay", "statement.gap")
 */
import { loadBook } from "../src/lib/book/load.ts";
import { prisma } from "../src/lib/db.ts";

const only = process.argv[2];
const started = Date.now();
const book = await loadBook(prisma);
console.log(`Book loaded in ${Date.now() - started}ms · ${book.rows.length} rows · ${book.stubs.length} pay stubs`);
console.log(`Proven through: net worth ${book.horizon.netWorth} (the data edge) · cash flow ${book.horizon.cashFlow}\n`);
for (const c of book.integrity.checks) {
  const n = (v: number) => String(v).padStart(4);
  console.log(`${c.id.padEnd(28)} pass ${n(c.passed)}  fail ${n(c.failed)}  missing ${n(c.missing)}  inferred ${n(c.inferred)}  accepted ${n(c.accepted)}`);
}
const findings = book.integrity.findings.filter((f) => !only || f.check.startsWith(only));
for (const f of findings) console.log(`\n[${f.status}${f.atEdge ? " · past the data edge" : ""}] ${f.title}\n   ${f.detail}\n   → ${f.fix}`);
if (only) for (const i of book.integrity.inferences.filter((x) => x.check.startsWith(only))) console.log(`\n[INFERRED] ${i.title}\n   ${i.detail}`);
for (const a of book.integrity.accepted.filter((x) => !only || x.check.startsWith(only))) console.log(`\n[ACCEPTED] ${a.title}\n   Note: ${a.note}`);
for (const s of book.integrity.stale.filter((x) => !only || x.check.startsWith(only))) console.log(`\n[TO REVIEW] ${s.finding.title}\n   Note: ${s.note}\n   ${s.evidence.join("\n   ")}`);
await prisma.$disconnect();
