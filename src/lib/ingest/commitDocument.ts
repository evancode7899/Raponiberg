import type { Prisma, PrismaClient, StatementType } from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { classificationData, ensureCategories, loadClassifyContext } from "../classifier/persist.ts";
import { classifyTransaction } from "../classifier/classify.ts";
import { dataDir } from "../dataDir.ts";
import { addDays } from "../dates/isoDate.ts";
import { refreshDerived, type MaintenanceReport } from "../ledger/maintenance.ts";
import { resolveAccount, type AccountResolution } from "../ledger/resolveAccount.ts";
import { hashFile } from "../statements/hashFile.ts";
import { parseIsoDate } from "../statements/parseIsoDate.ts";
import { loadTaxProfile } from "../tax/profile.ts";
import { BILL_CYCLE_DAYS, continueBill } from "./billContinuation.ts";
import { storeDocumentFacts } from "./documentFacts.ts";
import { contentFingerprint } from "./fingerprint.ts";
import type { ParsedAccountSection, ParsedDocument } from "./types.ts";
import { validateSection } from "./validate.ts";

export type CommitInput = {
  doc: ParsedDocument;
  fileBytes: Buffer;
  fileExtension: "pdf" | "json";
  originalFileName?: string;
  /** Extracted text, used to fingerprint supporting documents. */
  sourceText: string;
  /**
   * Commit sections that tie out to the cent immediately (default). Sections that don't
   * tie out are always held back as DISCREPANT for review.
   */
  autoCommit?: boolean;
  /** Skip the ledger-wide refresh (bulk imports run it once at the end). */
  skipRefresh?: boolean;
};

export type SectionOutcome = {
  accountNumber: string;
  periodStart: string;
  periodEnd: string;
  isSummary: boolean;
  outcome: "IMPORTED" | "DUPLICATE";
  accountId?: string;
  accountName?: string;
  resolution?: AccountResolution["how"];
  status?: "COMMITTED" | "PENDING_REVIEW" | "DISCREPANT";
  deltaCents: number;
  failedChecks: string[];
  transactionCount: number;
};

export type CommitResult =
  | {
      ok: true;
      documentId: string;
      kind: ParsedDocument["kind"];
      title: string;
      sections: SectionOutcome[];
      payStubs: { created: number; duplicate: number };
      warnings: string[];
      maintenance?: MaintenanceReport;
    }
  | {
      ok: false;
      reason: "DUPLICATE_FILE" | "DUPLICATE_CONTENT" | "OVERLAP";
      message: string;
      existingDocumentId?: string;
    };

class OverlapError extends Error {}

const STATEMENT_TYPE: Record<ParsedAccountSection["kind"], StatementType> = {
  CHECKING: "BANK",
  SAVINGS: "BANK",
  CREDIT_CARD: "CREDIT_CARD",
  INVESTMENT: "INVESTMENT",
  OTHER: "BANK",
};

/**
 * The single path from a parsed document into the ledger — used by the upload route,
 * the bulk importer, and hand-parsed JSON alike, so every statement gets the same
 * dedupe, overlap, reconciliation, account-resolution and classification rules.
 *
 * Duplicate protection, outermost first:
 *   1. same file bytes;
 *   2. same parsed content (a re-download with different bytes);
 *   3. per account: a section identical to an existing statement is skipped; one that
 *      overlaps an existing statement differently is refused (delete the old one first
 *      to replace it), so no account-day is ever covered twice;
 *   4. pay stubs dedupe on employer + pay date + net pay.
 */
export async function commitDocument(db: PrismaClient, input: CommitInput): Promise<CommitResult> {
  const { doc } = input;
  const fileHash = hashFile(input.fileBytes);
  const fingerprint = contentFingerprint(doc, input.sourceText);

  const byFile = await db.sourceDocument.findUnique({ where: { fileHash } });
  if (byFile) {
    return { ok: false, reason: "DUPLICATE_FILE", message: `This exact file is already imported (${byFile.title}).`, existingDocumentId: byFile.id };
  }
  const byContent = await db.sourceDocument.findUnique({ where: { contentFingerprint: fingerprint } });
  if (byContent) {
    return {
      ok: false,
      reason: "DUPLICATE_CONTENT",
      message: `Same content as an already-imported file (${byContent.originalFileName ?? byContent.title}).`,
      existingDocumentId: byContent.id,
    };
  }

  const autoCommit = input.autoCommit ?? true;
  const [ctx, categoryIds, { persons }] = await Promise.all([loadClassifyContext(db), ensureCategories(db), loadTaxProfile(db)]);
  // Stored relative to the app folder (documentFacts re-reads it from there).
  const relPath = path.relative(process.cwd(), path.join(dataDir(), "statements", `${fileHash}.${input.fileExtension}`));
  const isSummaryDoc = doc.kind === "PERIOD_SUMMARY";
  // The stored file first: facts are re-read from it later, so the database must never
  // name a file that failed to save. It's named by its hash, so writing it again (or
  // leaving it behind when the import is refused) is harmless.
  const abs = path.join(process.cwd(), relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, input.fileBytes);

  let result: Extract<CommitResult, { ok: true }>;
  try {
    result = await db.$transaction(
      async (tx) => {
        const outcomes: SectionOutcome[] = [];
        const toWrite: { section: ParsedAccountSection; outcome: SectionOutcome }[] = [];

        for (const rawSection of doc.sections) {
          let section = rawSection;
          const isSummarySection = section.isSummary ?? isSummaryDoc;
          const resolution = await resolveAccount(tx, section, persons);
          if (rawSection.startsAfterPrior && !isSummarySection) {
            const inside = await tx.statementImport.findFirst({
              where: {
                accountId: resolution.accountId,
                isSummary: false,
                periodEnd: { gte: parseIsoDate(rawSection.periodStart), lt: parseIsoDate(rawSection.periodEnd) },
              },
              orderBy: { periodEnd: "desc" },
            });
            if (inside) {
              const priorEnd = inside.periodEnd.toISOString().slice(0, 10);
              const transactions = rawSection.transactions.filter((t) => t.date > priorEnd);
              const flows = transactions.reduce((a, t) => a + t.amountCents, 0);
              section = {
                ...rawSection,
                periodStart: addDays(priorEnd, 1),
                openingBalanceCents: inside.closingBalanceCents,
                transactions,
                growthCents: rawSection.closingBalanceCents - inside.closingBalanceCents - flows - rawSection.feesCents,
                growthFromBalances: true,
              };
            }
          }
          if (rawSection.paymentsFromPrior && !isSummarySection) {
            section = await afterPriorBill(tx, resolution.accountId, rawSection);
          }
          const start = parseIsoDate(section.periodStart);
          const end = parseIsoDate(section.periodEnd);
          let priorMissing = false;
          if (rawSection.openingFromPrior && !isSummarySection) {
            const prior = await tx.statementImport.findFirst({
              where: { accountId: resolution.accountId, isSummary: false, periodEnd: { lt: start } },
              orderBy: { periodEnd: "desc" },
            });
            if (prior && start.getTime() - prior.periodEnd.getTime() <= 5 * 86_400_000) {
              const flows = rawSection.transactions.reduce((a, t) => a + t.amountCents, 0);
              section = {
                ...rawSection,
                openingBalanceCents: prior.closingBalanceCents,
                growthCents: rawSection.closingBalanceCents - prior.closingBalanceCents - flows - rawSection.feesCents,
                growthFromBalances: true,
              };
            } else {
              priorMissing = true;
            }
          }
          const v = validateSection(section);
          const overlapping = await tx.statementImport.findMany({
            where: { accountId: resolution.accountId, isSummary: isSummarySection, periodStart: { lte: end }, periodEnd: { gte: start } },
          });
          const base: SectionOutcome = {
            accountNumber: section.accountNumber,
            periodStart: section.periodStart,
            periodEnd: section.periodEnd,
            isSummary: isSummarySection,
            outcome: "IMPORTED",
            accountId: resolution.accountId,
            accountName: resolution.accountName,
            resolution: resolution.how,
            deltaCents: v.deltaCents,
            failedChecks: [
              ...v.failedChecks.map((c) => c.label),
              ...v.problems,
              ...(priorMissing ? ["Previous statement not imported yet — import it first so the opening value can be taken from it"] : []),
            ],
            transactionCount: section.transactions.length,
          };
          const same = overlapping.find(
            (o) =>
              o.periodStart.getTime() === start.getTime() &&
              o.periodEnd.getTime() === end.getTime() &&
              o.openingBalanceCents === section.openingBalanceCents &&
              o.closingBalanceCents === section.closingBalanceCents,
          );
          if (same) {
            outcomes.push({ ...base, outcome: "DUPLICATE" });
            continue;
          }
          if (overlapping.length > 0 && !isSummarySection) {
            const o = overlapping[0]!;
            throw new OverlapError(
              `${resolution.accountName}: ${section.periodStart}–${section.periodEnd} overlaps the imported statement for ${o.periodStart.toISOString().slice(0, 10)}–${o.periodEnd.toISOString().slice(0, 10)} with different balances. Delete that statement first if this one replaces it.`,
            );
          }
          const status = v.ok && !priorMissing ? (autoCommit ? "COMMITTED" : "PENDING_REVIEW") : "DISCREPANT";
          const outcome = { ...base, status } as SectionOutcome;
          outcomes.push(outcome);
          toWrite.push({ section, outcome });
        }

        const document = await tx.sourceDocument.create({
          data: {
            fileHash,
            contentFingerprint: fingerprint,
            filePath: relPath,
            originalFileName: input.originalFileName ?? null,
            institution: doc.institution,
            kind: doc.kind,
            title: doc.title,
            parserId: doc.parserId,
            parserVersion: doc.parserVersion,
            periodStart: doc.periodStart ? parseIsoDate(doc.periodStart) : null,
            periodEnd: doc.periodEnd ? parseIsoDate(doc.periodEnd) : null,
            warningsJson: doc.warnings.length ? doc.warnings : undefined,
          },
        });

        for (const { section, outcome } of toWrite) {
          const v = validateSection(section);
          const isSummarySection = section.isSummary ?? isSummaryDoc;
          const imp = await tx.statementImport.create({
            data: {
              accountId: outcome.accountId!,
              documentId: document.id,
              statementType: STATEMENT_TYPE[section.kind],
              isSummary: isSummarySection,
              periodStart: parseIsoDate(section.periodStart),
              periodEnd: parseIsoDate(section.periodEnd),
              openingBalanceCents: section.openingBalanceCents,
              closingBalanceCents: section.closingBalanceCents,
              growthCents: section.growthCents,
              feesCents: section.feesCents,
              reconciliationDeltaCents: v.deltaCents,
              checksJson: [
                ...section.checks.map((c) => ({ ...c, passed: Math.abs(c.expectedCents - c.actualCents) <= (c.toleranceCents ?? 0) })),
                ...(section.growthFromBalances
                  ? [{ label: "Market change isn't printed: it's what the balances leave after the listed flows", expectedCents: section.growthCents, actualCents: section.growthCents, derived: true, passed: true }]
                  : []),
              ],
              status: outcome.status!,
            },
          });
          if (section.transactions.length === 0) continue;
          await tx.transaction.createMany({
            data: section.transactions.map((t) => {
              const base = {
                accountId: outcome.accountId!,
                statementImportId: imp.id,
                date: parseIsoDate(t.date),
                amountCents: t.amountCents,
                payee: t.description,
                section: t.section ?? null,
                detail: t.detail ?? null,
                cardMember: t.cardMember ?? null,
                datePrecision: t.datePrecision,
              };
              if (isSummarySection) {
                // Year totals only ever fill gaps (see timeline); never counted directly.
                // Payroll/employer retirement money keeps its lane, deposits/withdrawals
                // between accounts are transfers; other activity mirrors how the monthly
                // statements book it.
                const lane =
                  t.section === "Other Activity In" ? "INCOME"
                  : t.section === "Other Activity Out" ? "EXPENSE"
                  : t.section === "Employee contributions" ? "CONTRIBUTION_EMPLOYEE"
                  : t.section === "Employer contributions" ? "CONTRIBUTION_EMPLOYER"
                  : "TRANSFER";
                return { ...base, lane: lane as "TRANSFER", classifiedBy: "summary", confidence: "high" };
              }
              const c = classifyTransaction(
                {
                  institution: section.institution,
                  accountSubtype: section.subtype,
                  section: t.section,
                  description: t.description,
                  detail: t.detail,
                  amountCents: t.amountCents,
                  date: t.date,
                },
                ctx,
              );
              return { ...base, ...classificationData(c, categoryIds) };
            }),
          });
        }

        const stubs = await storeDocumentFacts(tx, document.id, doc);

        await tx.auditEvent.create({
          data: {
            action: "statement_imported",
            actor: "app",
            payloadJson: {
              documentId: document.id,
              institution: doc.institution,
              kind: doc.kind,
              parserId: doc.parserId,
              sections: outcomes.map((o) => ({
                accountId: o.accountId,
                periodStart: o.periodStart,
                periodEnd: o.periodEnd,
                outcome: o.outcome,
                status: o.status,
                deltaCents: o.deltaCents,
                transactionCount: o.transactionCount,
              })),
              payStubsCreated: stubs.created,
            },
          },
        });

        return {
          ok: true as const,
          documentId: document.id,
          kind: doc.kind,
          title: doc.title,
          sections: outcomes,
          payStubs: stubs,
          warnings: doc.warnings,
        };
      },
      { timeout: 120_000, maxWait: 30_000 },
    );
  } catch (e) {
    if (e instanceof OverlapError) return { ok: false, reason: "OVERLAP", message: e.message };
    throw e;
  }

  if (!input.skipRefresh) result.maintenance = await refreshDerived(db);
  return result;
}

/**
 * A bill that prints only what's still owed, carried on from the account's previous bill
 * (billContinuation.ts). Without a previous bill within a cycle it stands alone as parsed:
 * the account's first bill, or the first after a gap (which shows as missing statements).
 */
async function afterPriorBill(tx: Prisma.TransactionClient, accountId: string, s: ParsedAccountSection): Promise<ParsedAccountSection> {
  const prior = await tx.statementImport.findFirst({
    where: { accountId, isSummary: false, periodEnd: { lt: parseIsoDate(s.periodEnd), gte: parseIsoDate(addDays(s.periodEnd, -BILL_CYCLE_DAYS)) } },
    orderBy: { periodEnd: "desc" },
  });
  if (!prior) return s;
  const earlier = await tx.transaction.findMany({
    where: { accountId, datePrecision: "EXACT", statementImport: { isSummary: false, periodEnd: { lte: prior.periodEnd } } },
    select: { date: true, amountCents: true, payee: true },
  });
  return continueBill(
    s,
    { periodEnd: prior.periodEnd.toISOString().slice(0, 10), closingBalanceCents: prior.closingBalanceCents },
    earlier.map((r) => ({ date: r.date.toISOString().slice(0, 10), amountCents: r.amountCents, description: r.payee ?? "" })),
  );
}
