/**
 * Holds every figure every page shows to its proof, on the Book as it is now: the same
 * sweep Statements → Checks runs (lib/book/proof/sweep.ts). Prints each page's count and
 * every problem; exits 1 when there is any (each one is a bug in the app).
 *
 * Usage:
 *   node scripts/proof-sweep.ts [page-prefix]
 *
 *   page-prefix   only list problems on pages starting with it (e.g. "Taxes", "Cash flow")
 */
import { loadBook } from "../src/lib/book/load.ts";
import { sweepProofs } from "../src/lib/book/proof/sweep.ts";
import { prisma } from "../src/lib/db.ts";

const only = process.argv[2];
const book = await loadBook(prisma);
const r = await sweepProofs({ book, db: prisma });
console.log(`Swept ${r.figures} figures and ${r.links} links in ${r.ms}ms (Book as of ${r.today})\n`);
for (const p of r.pages) console.log(`${p.page.padEnd(40)} ${String(p.figures).padStart(6)} figures ${String(p.ms).padStart(7)}ms  ${p.problems ? `${p.problems} problem(s)` : "all tie"}`);
console.log(`${"Links".padEnd(40)} ${String(r.links).padStart(6)} proofs  ${String(r.linkMs).padStart(7)}ms`);
const shown = r.problems.filter((p) => !only || p.page.startsWith(only));
for (const p of shown) console.log(`\n[${p.kind}] ${p.page}\n   ${p.detail}${p.descriptor ? `\n   ${JSON.stringify(p.descriptor)}` : ""}`);
console.log(`\n${r.problems.length ? `${r.problems.length} problem(s).` : "Every figure ties to its proof."}`);
await prisma.$disconnect();
process.exit(r.problems.length ? 1 : 0);
