/**
 * Parses every PDF under a folder with the deterministic parsers and reports whether
 * each one ties out — without touching the database. Use it to check a batch of new
 * statements (or a parser change) before importing.
 *
 * Usage:
 *   node scripts/ingestDryRun.ts [folder] [--show <substring>] [--failures]
 *
 * Defaults to ../3. Statements next to the app folder.
 */
import { extractPdfText } from "../src/lib/statements/extractPdfText.ts";
import { householdPatterns } from "../src/lib/household/householdFile.ts";
import { parseStatementText } from "../src/lib/ingest/parsers/index.ts";
import { validateDocument } from "../src/lib/ingest/validate.ts";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const showIdx = args.indexOf("--show");
const show = showIdx >= 0 ? args[showIdx + 1] : undefined;
const failuresOnly = args.includes("--failures");
const folder =
  args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--show") ??
  path.resolve(process.cwd(), "..", "3. Statements");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.toLowerCase().endsWith(".pdf") ? [p] : [];
  });
}

const cents = (c: number) => (c / 100).toFixed(2);

const files = walk(folder).sort();
const tally = { ok: 0, failed: 0, unrecognized: 0, error: 0 };

for (const file of files) {
  const rel = path.relative(folder, file);
  const text = await extractPdfText(readFileSync(file));
  const outcome = parseStatementText(text, householdPatterns());
  if (!outcome.ok) {
    if (outcome.reason === "UNRECOGNIZED") tally.unrecognized++;
    else tally.error++;
    console.log(
      `${outcome.reason === "UNRECOGNIZED" ? "??  " : "ERR "} ${rel}${
        outcome.reason === "PARSE_ERROR" ? ` — ${outcome.parserId}: ${outcome.error}` : ""
      }`,
    );
    continue;
  }
  const { doc } = outcome;
  const v = validateDocument(doc);
  if (v.ok) tally.ok++;
  else tally.failed++;
  const detailWanted = show !== undefined && rel.includes(show);
  if (failuresOnly && v.ok && !detailWanted) continue;
  const summary = doc.sections
    .map((s, i) => {
      const sv = v.sections[i]!;
      return `${s.accountNumber} ${s.periodStart}..${s.periodEnd} ${s.transactions.length}tx${
        sv.ok ? "" : ` Δ${cents(sv.deltaCents)}${sv.failedChecks.map((c) => ` [${c.label}: ${cents(c.expectedCents)}≠${cents(c.actualCents)}]`).join("")}${sv.problems.map((p) => ` {${p}}`).join("")}`
      }`;
    })
    .join(" | ");
  console.log(`${v.ok ? "ok  " : "BAD "} ${rel} [${doc.kind}] ${summary}${v.problems.map((p) => ` {${p}}`).join("")}`);
  if (detailWanted) {
    for (const w of doc.warnings) console.log(`    warn: ${w}`);
    for (const s of doc.sections) {
      console.log(
        `    ${s.accountNumber} ${s.accountName} open ${cents(s.openingBalanceCents)} close ${cents(s.closingBalanceCents)} growth ${cents(s.growthCents)} fees ${cents(s.feesCents)}`,
      );
      for (const t of s.transactions) {
        console.log(`      ${t.date} ${t.datePrecision === "PERIOD" ? "~" : " "} ${cents(t.amountCents).padStart(12)}  [${t.section ?? ""}] ${t.description}`);
      }
    }
    for (const p of doc.payStubs ?? []) console.log(`    paystub ${JSON.stringify(p)}`);
  }
}

console.log(
  `\n${files.length} files: ${tally.ok} tie out, ${tally.failed} don't, ${tally.unrecognized} unrecognized, ${tally.error} parser errors`,
);
