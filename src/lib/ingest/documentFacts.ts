import type { Prisma, PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { extractPdfText } from "../statements/extractPdfText.ts";
import { parseIsoDate } from "../statements/parseIsoDate.ts";
import { FACT_PARSERS, FACTS_VERSION } from "./factsVersion.ts";
import { householdPatterns } from "../household/householdFile.ts";
import { parseStatementText } from "./parsers/index.ts";
import { sumPositions } from "./holdings/types.ts";
import { employerKey } from "./payroll/types.ts";
import type { ParsedDocument } from "./types.ts";

export { FACTS_VERSION } from "./factsVersion.ts";

type Tx = Prisma.TransactionClient;

/**
 * Stores a parsed document's pay stubs (with every line item), brokerage tax figures and
 * holdings, replacing whatever the document had. A stub already on file from another
 * document (payroll PDFs repeat stubs) is counted as a duplicate, not stored twice.
 */
export async function storeDocumentFacts(tx: Tx, documentId: string, doc: ParsedDocument): Promise<{ created: number; duplicate: number }> {
  await tx.payStub.deleteMany({ where: { documentId } });
  await tx.brokerageTaxFacts.deleteMany({ where: { documentId } });
  await tx.holdingSnapshot.deleteMany({ where: { documentId } });
  for (const h of doc.holdings ?? []) {
    await tx.holdingSnapshot.create({
      data: {
        documentId,
        accountNumber: h.accountNumber,
        asOf: parseIsoDate(h.asOf),
        positionsJson: h.positions,
        totalCents: sumPositions(h.positions),
        printedTotalCents: h.printedTotalCents,
      },
    });
  }
  let created = 0;
  let duplicate = 0;
  for (const s of doc.payStubs ?? []) {
    const key = employerKey(s.employer, s.payrollCode);
    const exists = await tx.payStub.findUnique({
      where: { employerKey_payDate_netPayCents: { employerKey: key, payDate: parseIsoDate(s.payDate), netPayCents: s.printed.netCurrent } },
    });
    if (exists) {
      duplicate++;
      continue;
    }
    await tx.payStub.create({
      data: {
        documentId,
        source: s.source,
        employee: s.employee,
        employer: s.employer,
        employerKey: key,
        payDate: parseIsoDate(s.payDate),
        periodStart: s.periodStart ? parseIsoDate(s.periodStart) : null,
        periodEnd: s.periodEnd ? parseIsoDate(s.periodEnd) : null,
        federalFilingStatus: s.federalFilingStatus,
        grossCurrentCents: s.printed.grossCurrent,
        grossYtdCents: s.printed.grossYtd,
        withheldCurrentCents: s.printed.withheldCurrent,
        withheldYtdCents: s.printed.withheldYtd,
        netPayCents: s.printed.netCurrent,
        netYtdCents: s.printed.netYtd,
        depositsJson: s.deposits,
        warningsJson: s.warnings.length ? s.warnings : undefined,
        lines: {
          create: s.lines.map((l, position) => ({ position, name: l.name, kind: l.kind, currentCents: l.current, ytdCents: l.ytd })),
        },
      },
    });
    created++;
  }
  for (const b of doc.brokerageFacts ?? []) {
    await tx.brokerageTaxFacts.create({
      data: {
        documentId,
        accountNumber: b.accountNumber,
        periodStart: parseIsoDate(b.periodStart),
        periodEnd: parseIsoDate(b.periodEnd),
        isYearEnd: b.isYearEnd,
        kind: b.kind,
        ownerLine: b.ownerLine,
        isChet: b.isChet,
        endingValueCents: b.endingValue,
        contributionsYtdCents: b.contributionsYtd,
        incomeJson: b.income ?? undefined,
        realizedJson: b.realized ?? undefined,
        incomeRowsJson: b.incomeRows,
        distributionsJson: b.distributions,
      },
    });
  }
  await tx.sourceDocument.update({ where: { id: documentId }, data: { factsVersion: FACTS_VERSION } });
  return { created, duplicate };
}

/**
 * Re-extracts facts for documents stored under an older FACTS_VERSION, reading each
 * document's stored file with the parser that imported it. Statements and their rows
 * are left alone; only pay stubs and brokerage tax figures are rewritten.
 *
 * Every file is read first, then all their facts are stored in one transaction: each
 * write changes the data the pages are built from (book/cache.ts), so storing them one
 * document at a time rebuilt everything once per document, for minutes, after a
 * FACTS_VERSION bump.
 */
export async function refreshOutdatedFacts(db: PrismaClient): Promise<{ refreshed: number; failed: { title: string; error: string }[] }> {
  const docs = await db.sourceDocument.findMany({
    where: { factsVersion: { lt: FACTS_VERSION }, parserId: { in: FACT_PARSERS } },
    orderBy: { periodStart: "asc" },
    select: { id: true, title: true, filePath: true, parserId: true, originalFileName: true },
  });
  const read: { id: string; label: string; doc: ParsedDocument }[] = [];
  const failed: { title: string; error: string }[] = [];
  for (const d of docs) {
    const label = d.originalFileName ?? d.title;
    try {
      const text = await extractPdfText(readFileSync(path.resolve(process.cwd(), d.filePath)));
      const parsed = parseStatementText(text, householdPatterns());
      if (!parsed.ok) throw new Error(parsed.reason === "PARSE_ERROR" ? parsed.error : "no parser recognizes the stored file");
      if (parsed.parserId !== d.parserId) throw new Error(`the stored file now reads as ${parsed.parserId}, not ${d.parserId}`);
      read.push({ id: d.id, label, doc: parsed.doc });
    } catch (e) {
      failed.push({ title: label, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (!read.length) return { refreshed: 0, failed };
  try {
    await db.$transaction(
      async (tx) => {
        for (const r of read) await storeDocumentFacts(tx, r.id, r.doc);
      },
      { timeout: 300_000, maxWait: 60_000 },
    );
  } catch (e) {
    // Nothing was stored: every document stays outdated and is tried again.
    const error = e instanceof Error ? e.message : String(e);
    return { refreshed: 0, failed: [...failed, ...read.map((r) => ({ title: r.label, error }))] };
  }
  return { refreshed: read.length, failed };
}
