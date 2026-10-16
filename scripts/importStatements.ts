/**
 * Imports every statement PDF under a folder into the ledger (idempotent: already
 * imported files and re-downloads are skipped). Parses everything first, then commits
 * in chronological order so reissued cards chain onto their earlier account.
 *
 * Usage:
 *   node scripts/importStatements.ts [folder] [--review] [--reparse-outdated]
 *
 *   folder              defaults to the folder the app scans (STATEMENTS_DIR in .env,
 *                       else ../Statements next to the app folder)
 *   --review            hold even reconciled statements for manual commit (default:
 *                       statements that tie out to the cent are committed; anything
 *                       else waits for review)
 *   --reparse-outdated  no longer needed (accepted for old instructions): files whose
 *                       stored document came from an older version of the same parser
 *                       are always read again, as the app does on its folder scan and
 *                       at startup (importFiles.ts dropOutdatedReading).
 */
import { prisma } from "../src/lib/db.ts";
import { commitDocument } from "../src/lib/ingest/commitDocument.ts";
import { commitOrder, dropOutdatedReading, statementsFolder } from "../src/lib/ingest/importFiles.ts";
import { householdPatterns } from "../src/lib/household/householdFile.ts";
import { parseStatementText } from "../src/lib/ingest/parsers/index.ts";
import type { ParsedDocument } from "../src/lib/ingest/types.ts";
import { refreshDerived } from "../src/lib/ledger/maintenance.ts";
import { extractPdfText } from "../src/lib/statements/extractPdfText.ts";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const review = args.includes("--review");
// The same folder the app scans: STATEMENTS_DIR from .env, else "Statements" beside the app.
if (existsSync(".env")) process.loadEnvFile(".env");
const folder = args.find((a) => !a.startsWith("--")) ?? statementsFolder();

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.toLowerCase().endsWith(".pdf") ? [p] : [];
  });
}

type Parsed = { file: string; bytes: Buffer; text: string; doc: ParsedDocument };
const parsed: Parsed[] = [];
const unrecognized: string[] = [];
for (const file of walk(folder)) {
  const bytes = readFileSync(file);
  const text = await extractPdfText(bytes);
  const outcome = parseStatementText(text, householdPatterns());
  if (!outcome.ok) {
    unrecognized.push(`${path.relative(folder, file)} (${outcome.reason === "PARSE_ERROR" ? outcome.error : "no parser recognizes it"})`);
    continue;
  }
  parsed.push({ file, bytes, text, doc: outcome.doc });
}
parsed.sort((a, b) => commitOrder(a.doc, b.doc));

const tally = { imported: 0, duplicate: 0, refused: 0, discrepant: 0, accountsCreated: 0, continuations: 0, reparsed: 0 };
for (const p of parsed) {
  const rel = path.relative(folder, p.file);
  if (await dropOutdatedReading(prisma, p.bytes, p.doc)) {
    tally.reparsed++;
    console.log(`REPARSE  ${rel} (parser v${p.doc.parserVersion})`);
  }
  const r = await commitDocument(prisma, {
    doc: p.doc,
    fileBytes: p.bytes,
    fileExtension: "pdf",
    originalFileName: path.basename(p.file),
    sourceText: p.text,
    autoCommit: !review,
    skipRefresh: true,
  });
  if (!r.ok) {
    if (r.reason === "OVERLAP") {
      tally.refused++;
      console.log(`REFUSED  ${rel}: ${r.message}`);
    } else {
      tally.duplicate++;
    }
    continue;
  }
  tally.imported++;
  for (const s of r.sections) {
    if (s.status === "DISCREPANT") {
      tally.discrepant++;
      console.log(`CHECK    ${rel}: ${s.accountName} ${s.periodStart}..${s.periodEnd} off by ${s.deltaCents}¢ ${s.failedChecks.join("; ")}`);
    }
    if (s.resolution === "CREATED") {
      tally.accountsCreated++;
      console.log(`ACCOUNT  new: ${s.accountName}`);
    }
    if (s.resolution === "CONTINUATION") {
      tally.continuations++;
      console.log(`ACCOUNT  ${s.accountNumber} continues ${s.accountName} (reissued/renumbered)`);
    }
  }
}

const m = await refreshDerived(prisma);
console.log(
  `\nImported ${tally.imported} documents (${tally.reparsed} re-parsed, ${tally.duplicate} already imported, ${tally.refused} refused, ${tally.discrepant} sections need review).`,
);
console.log(`Accounts: ${tally.accountsCreated} created, ${tally.continuations} reissues linked.`);
console.log(
  `Transfers: ${m.transfers.matched} matched, ${m.transfers.ambiguous} ambiguous groups, ${m.transfers.promoted} deposits recognized as transfers, ${m.transfers.untrackedCardPayments} payments to untracked cards. Rent checks: ${m.recurringChecks}. Pay stubs linked: ${m.payStubsLinked}.`,
);
if (unrecognized.length) console.log(`\nNot imported (no parser):\n  ${unrecognized.join("\n  ")}`);
await prisma.$disconnect();
