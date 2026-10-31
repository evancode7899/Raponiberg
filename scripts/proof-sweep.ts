/**
 * Holds every figure every page shows to its proof, and every statement, row and pay stub
 * to what it prints, on the Book as it is now: the same
 * sweep Statements → Checks runs (lib/book/proof/sweep.ts). Prints each page's count and
 * every problem; exits 1 when there is any (each one is a bug in the app).
 *
 * Usage:
 *   node scripts/proof-sweep.ts [page-prefix]
 *
 *   page-prefix   only list problems on pages starting with it (e.g. "Taxes", "Cash flow")
 *
 * With --child it is the server's sweep (lib/book/proof/sweepProcess.ts): it runs at low
 * priority and sends the report, as JSON text, to the server that started it.
 */
import { constants, setPriority } from "node:os";
import { stampTag } from "../src/lib/book/cache.ts";
import { loadBook } from "../src/lib/book/load.ts";
import { sweepProofs } from "../src/lib/book/proof/sweep.ts";
import { prisma } from "../src/lib/db.ts";

if (process.argv.includes("--child")) {
  try {
    setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    /* not allowed here: it runs at normal priority */
  }
  // The stamp is taken before the Book is read: data that changes meanwhile reads as other data.
  const stamp = stampTag();
  const book = await loadBook(prisma);
  const r = await sweepProofs({ book, db: prisma }, { stamp });
  await prisma.$disconnect();
  process.send!(JSON.stringify(r), () => process.exit(0));
} else {
  const only = process.argv[2];
  const stamp = stampTag();
  const book = await loadBook(prisma);
  const r = await sweepProofs({ book, db: prisma }, { stamp });
  console.log(`Swept ${r.figures} figures and ${r.links} links in ${r.ms}ms (Book as of ${r.today}, data ${r.stamp}): ${Object.keys(r.cleared).length} cleared\n`);
  for (const p of r.pages) console.log(`${p.page.padEnd(40)} ${String(p.figures).padStart(6)} figures ${String(p.ms).padStart(7)}ms  ${p.problems ? `${p.problems} problem(s)` : "all tie"}`);
  console.log(`${"Links".padEnd(40)} ${String(r.links).padStart(6)} proofs  ${String(r.linkMs).padStart(7)}ms`);
  for (const p of r.skipped.filter((p) => !only || p.page.startsWith(only))) console.log(`\n[NOT SWEPT] ${p.page}\n   ${p.detail}`);
  const shown = r.listing.filter((p) => !only || p.page.startsWith(only));
  for (const p of shown) console.log(`\n[${p.kind}] ${p.page}\n   ${p.detail}${p.descriptor ? `\n   ${JSON.stringify(p.descriptor)}` : ""}`);
  if (r.problemCount > r.listing.length) console.log(`\n…and ${r.problemCount - r.listing.length} more not listed (each still withholds its figure).`);
  console.log(`\n${r.problemCount ? `${r.problemCount} problem(s).` : "Every figure ties to its proof."}${r.skipped.length ? ` ${r.skipped.length} part(s) not swept (listed above): their figures show nowhere.` : ""}`);
  await prisma.$disconnect();
  process.exit(r.problemCount ? 1 : 0);
}
