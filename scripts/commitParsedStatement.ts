/**
 * Commits a statement that was parsed by hand (Claude reading the real PDF, for an
 * institution no deterministic parser covers yet) through exactly the same pipeline as
 * uploads: dedupe, overlap checks, reconciliation, account resolution, classification
 * and transfer matching.
 *
 * Usage: node scripts/commitParsedStatement.ts <extracted.json> [--review]
 *
 * JSON shape (a ParsedDocument from src/lib/ingest/types.ts, plus the source file):
 * {
 *   "sourceFilePath": "C:/.../statement.pdf",
 *   "institution": "Capital One",
 *   "kind": "STATEMENT",                       // or PERIOD_SUMMARY / PAYSTUB / SUPPORTING
 *   "title": "Capital One Quicksilver statement",
 *   "periodStart": "2026-07-01", "periodEnd": "2026-07-31",
 *   "sections": [{
 *     "institution": "Capital One",
 *     "accountNumber": "1234",                 // as printed; how the account is recognized
 *     "accountName": "Capital One Quicksilver",
 *     "kind": "CREDIT_CARD",                   // CHECKING | SAVINGS | CREDIT_CARD | INVESTMENT | OTHER
 *     "subtype": "CREDIT_CARD",                // see AccountSubtype
 *     "periodStart": "2026-07-01", "periodEnd": "2026-07-31",
 *     "openingBalanceCents": -12345,           // household sign: debts negative
 *     "closingBalanceCents": -23456,
 *     "growthCents": 0, "feesCents": 0,        // market change / fees for investment accounts
 *     "transactions": [
 *       { "date": "2026-07-03", "datePrecision": "EXACT", "description": "TRADER JOE S",
 *         "amountCents": -4567, "section": "Charges" }
 *     ],
 *     "checks": [{ "label": "New charges", "expectedCents": 11111, "actualCents": 11111 }]
 *   }],
 *   "payStubs": [],                            // for PAYSTUB documents
 *   "warnings": []
 * }
 *
 * Amount signs are the change to the household's balance: purchases/withdrawals
 * negative, deposits/payments-received positive. Card payment rows must use section
 * "Payments" and card fees "Fees" so the classifier treats them correctly.
 */
import { prisma } from "../src/lib/db.ts";
import { commitDocument } from "../src/lib/ingest/commitDocument.ts";
import type { ParsedDocument } from "../src/lib/ingest/types.ts";
import { validateDocument } from "../src/lib/ingest/validate.ts";
import { readFileSync } from "node:fs";
import path from "node:path";

const [jsonPath, ...flags] = process.argv.slice(2);
if (!jsonPath) {
  console.error("Usage: node scripts/commitParsedStatement.ts <extracted.json> [--review]");
  process.exit(1);
}

const input = JSON.parse(readFileSync(jsonPath, "utf8")) as ParsedDocument & { sourceFilePath: string };
const doc: ParsedDocument = {
  parserId: "manual",
  parserVersion: 1,
  institution: input.institution,
  kind: input.kind ?? "STATEMENT",
  title: input.title ?? `${input.institution} statement`,
  periodStart: input.periodStart ?? null,
  periodEnd: input.periodEnd ?? null,
  sections: (input.sections ?? []).map((s) => ({
    ...s,
    growthCents: s.growthCents ?? 0,
    feesCents: s.feesCents ?? 0,
    checks: s.checks ?? [],
    transactions: s.transactions.map((t) => ({ ...t, datePrecision: t.datePrecision ?? "EXACT" })),
  })),
  payStubs: input.payStubs,
  warnings: input.warnings ?? [],
};

const validation = validateDocument(doc);
for (const [i, s] of validation.sections.entries()) {
  if (!s.ok) {
    console.warn(
      `Section ${i} (${s.accountNumber}) doesn't tie out: off by ${s.deltaCents}¢ ${[...s.failedChecks.map((c) => c.label), ...s.problems].join("; ")}`,
    );
  }
}

const bytes = readFileSync(input.sourceFilePath);
const result = await commitDocument(prisma, {
  doc,
  fileBytes: bytes,
  fileExtension: input.sourceFilePath.toLowerCase().endsWith(".pdf") ? "pdf" : "json",
  originalFileName: path.basename(input.sourceFilePath),
  // Supporting docs fingerprint on text; the JSON stands in for it.
  sourceText: JSON.stringify(input.sections ?? input.payStubs ?? input.title),
  autoCommit: !flags.includes("--review"),
});
console.log(JSON.stringify(result, null, 2));
await prisma.$disconnect();
if (!result.ok) process.exit(1);
