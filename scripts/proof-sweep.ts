/**
 * Holds every figure every page shows to its proof, and every statement, row and pay stub
 * to what it prints, on the Book as it is now: the same
 * sweep Statements → Checks runs (lib/book/proof/sweep.ts). Prints each page's count and
 * every problem; exits 1 when there is any (each one is a bug in the app), or when a figure
 * re-runs its page's own report with no second route and no reason why (F5, independence.ts).
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
  const i = r.independence;
  console.log(`
Independent proofs: ${i.rederived} re-derived by a second route, ${i.declared} that can't be (each says why), ${i.unchecked} on the page's own route only; ${i["own-route"]} re-derived from the Book by their proof kind.`);
  for (const p of r.pages.filter((p) => (p.independence.rederived || p.independence.declared || p.independence.unchecked) && (!only || p.page.startsWith(only))))
    console.log(`   ${p.page.padEnd(37)} ${String(p.independence.rederived).padStart(6)} re-derived ${String(p.independence.declared).padStart(6)} declared${p.independence.unchecked ? ` ${String(p.independence.unchecked).padStart(6)} on their own route only` : ""}`);
  console.log(`${"Links".padEnd(40)} ${String(r.links).padStart(6)} proofs  ${String(r.linkMs).padStart(7)}ms`);
  for (const p of r.skipped.filter((p) => !only || p.page.startsWith(only))) console.log(`\n[NOT SWEPT] ${p.page}\n   ${p.detail}`);
  const shown = r.listing.filter((p) => !only || p.page.startsWith(only));
  for (const p of shown) console.log(`\n[${p.kind}] ${p.page}\n   ${p.detail}${p.descriptor ? `\n   ${JSON.stringify(p.descriptor)}` : ""}`);
  if (r.problemCount > r.listing.length) console.log(`\n…and ${r.problemCount - r.listing.length} more not listed (each still withholds its figure).`);
  console.log(`\n${r.problemCount ? `${r.problemCount} problem(s).` : "Every figure ties to its proof."}${r.skipped.length ? ` ${r.skipped.length} part(s) not swept (listed above): their figures show nowhere.` : ""}`);
  // F5: every figure that re-runs its page's own report or model needs a second route, or a reason it has none.
  if (i.unchecked) console.log(`\n[UNCHECKED] ${i.unchecked} figure(s) re-run their page's own report or model and nothing else: give each a second route or declare why it has none (lib/book/rederive).`);
  await prisma.$disconnect();
  process.exit(r.problemCount || i.unchecked ? 1 : 0);
}
