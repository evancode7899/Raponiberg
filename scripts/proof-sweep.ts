/**
 * Builds the proof of every committed statement, every ledger row and every pay stub,
 * and reports how many fail to build, don't re-add, or differ from what pages show
 * (a statement's printed closing, a row's printed amount, a stub's printed net). Prints
 * counts and database ids only, never names or amounts, so its output is safe to share.
 *
 * Usage:
 *   node scripts/proof-sweep.ts
 */
import { loadBook } from "../src/lib/book/load.ts";
import { buildProof, type ProofDescriptor } from "../src/lib/book/proof/index.ts";
import { prisma } from "../src/lib/db.ts";

const book = await loadBook(prisma);
const ctx = { book, db: prisma };
type Tally = { built: number; errors: string[]; notTie: string[]; mismatch: string[] };
const tally = (): Tally => ({ built: 0, errors: [], notTie: [], mismatch: [] });

async function sweep(t: Tally, id: string, d: ProofDescriptor, shown: number) {
  try {
    const p = await buildProof(ctx, d);
    t.built++;
    if (p.selfCheck && !p.selfCheck.ok) t.notTie.push(id);
    if (!("cents" in p.figure) || p.figure.cents !== shown) t.mismatch.push(id);
  } catch (e) {
    t.errors.push(`${id}: ${e instanceof Error ? e.message.slice(0, 60) : "?"}`);
  }
}

const statements = tally();
for (const s of book.statements.filter((x) => x.status === "COMMITTED")) await sweep(statements, s.id, { report: "statement", statementId: s.id }, s.printed?.closingCents ?? NaN);
// A row's printed amount: a bill payment booked in pieces is its pieces added back.
const printed = new Map(book.rows.map((r) => [r.id, r.amountCents]));
for (const r of book.rows) if (r.partOf) printed.set(r.partOf, (printed.get(r.partOf) ?? 0) + r.amountCents);
const rows = tally();
for (const r of book.rows) await sweep(rows, r.id, { report: "row", rowId: r.id }, printed.get(r.id)!);
const stubs = tally();
for (const s of book.stubs) await sweep(stubs, s.id, { report: "stub", stubId: s.id }, s.printed.netCurrent);

for (const [name, t] of Object.entries({ statements, rows, stubs }))
  console.log(`${name.padEnd(10)} built ${String(t.built).padStart(5)} · errors ${t.errors.length} · don't re-add ${t.notTie.length} · differ from page ${t.mismatch.length}${[...t.errors, ...t.notTie, ...t.mismatch].length ? `\n   ${[...t.errors, ...t.notTie.map((x) => `re-add ${x}`), ...t.mismatch.map((x) => `differs ${x}`)].slice(0, 12).join("\n   ")}` : ""}`);
await prisma.$disconnect();
