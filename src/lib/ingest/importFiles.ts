import type { PrismaClient } from "@prisma/client";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { dataDir, isDemo } from "../dataDir.ts";
import { refreshDerived, type MaintenanceReport } from "../ledger/maintenance.ts";
import { extractPdfText } from "../statements/extractPdfText.ts";
import { hashFile } from "../statements/hashFile.ts";
import { commitDocument, type CommitResult } from "./commitDocument.ts";
import { householdPatterns } from "../household/householdFile.ts";
import { PARSER_VERSIONS, parseStatementText } from "./parsers/index.ts";
import type { ParsedDocument } from "./types.ts";

export type FileOutcome =
  | { fileName: string; ok: true; result: Extract<CommitResult, { ok: true }> }
  | { fileName: string; ok: false; reason: string; message: string };

export type ImportFile = { fileName: string; bytes: Buffer };

/**
 * Commit order: statements before summaries, then by period end (start breaks ties), so a
 * quarter-end statement lands after the monthly statements inside its quarter.
 */
export function commitOrder(a: ParsedDocument, b: ParsedDocument): number {
  const rank = (d: ParsedDocument) => (d.kind === "PERIOD_SUMMARY" ? 1 : 0);
  return (
    rank(a) - rank(b) ||
    (a.periodEnd ?? "").localeCompare(b.periodEnd ?? "") ||
    (a.periodStart ?? "").localeCompare(b.periodStart ?? "")
  );
}

/**
 * Parses every file first, then commits statements before summaries, oldest first, so
 * reissued cards chain onto their earlier account no matter what order files arrive in.
 * Runs the ledger-wide refresh once at the end if anything was imported.
 */
export async function importStatementFiles(
  db: PrismaClient,
  files: ImportFile[],
  opts: { review?: boolean } = {},
): Promise<{ outcomes: FileOutcome[]; maintenance: MaintenanceReport | null }> {
  const outcomes: FileOutcome[] = [];
  const parsed: { file: ImportFile; text: string; doc: ParsedDocument }[] = [];

  for (const file of files) {
    if (file.bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
      outcomes.push({ fileName: file.fileName, ok: false, reason: "NOT_PDF", message: "Not a PDF file." });
      continue;
    }
    let text: string;
    try {
      text = await extractPdfText(file.bytes);
    } catch (e) {
      outcomes.push({
        fileName: file.fileName,
        ok: false,
        reason: "UNREADABLE",
        message: `Could not read PDF text: ${e instanceof Error ? e.message : "unknown error"}`,
      });
      continue;
    }
    const result = parseStatementText(text, householdPatterns());
    if (!result.ok) {
      outcomes.push({
        fileName: file.fileName,
        ok: false,
        reason: result.reason,
        message:
          result.reason === "UNRECOGNIZED"
            ? "No parser recognizes this document yet. Ask Claude to hand-parse it (scripts/commitParsedStatement.ts), or add a parser for this institution."
            : `Parser ${result.parserId} failed: ${result.error}`,
      });
      continue;
    }
    parsed.push({ file, text, doc: result.doc });
  }

  parsed.sort((a, b) => commitOrder(a.doc, b.doc));

  for (const { file, text, doc } of parsed) {
    await dropOutdatedReading(db, file.bytes, doc);
    const result = await commitDocument(db, {
      doc,
      fileBytes: file.bytes,
      fileExtension: "pdf",
      originalFileName: path.basename(file.fileName),
      sourceText: text,
      autoCommit: !opts.review,
      skipRefresh: true,
    });
    outcomes.push(
      result.ok
        ? { fileName: file.fileName, ok: true, result }
        : { fileName: file.fileName, ok: false, reason: result.reason, message: result.message },
    );
  }

  const maintenance = outcomes.some((o) => o.ok) ? await refreshDerived(db) : null;
  return { outcomes, maintenance };
}

/**
 * The statements folder: STATEMENTS_DIR, or "3. Statements" next to the app folder. The
 * demo instance only ever looks in its own data folder's inbox, never the real statements.
 */
export function statementsFolder(): string {
  if (isDemo()) return path.join(dataDir(), "inbox");
  return process.env.STATEMENTS_DIR?.trim() || path.resolve(process.cwd(), "..", "3. Statements");
}

async function walkPdfs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return walkPdfs(p);
      return Promise.resolve(e.isFile() && e.name.toLowerCase().endsWith(".pdf") ? [p] : []);
    }),
  );
  return nested.flat();
}

/**
 * A file imported before its parser learned to read it differently (its version was
 * bumped) is read again rather than skipped as a duplicate: the stored document and its
 * rows go, with the transfer pairings that touch them, and the file is committed afresh.
 * The owner's decisions live in data/*.json and are applied again on the refresh.
 * Returns whether an older reading was dropped.
 */
export async function dropOutdatedReading(db: PrismaClient, bytes: Buffer, doc: ParsedDocument): Promise<boolean> {
  const stored = await db.sourceDocument.findUnique({ where: { fileHash: hashFile(bytes) } });
  if (!stored || stored.parserId !== doc.parserId || stored.parserVersion >= doc.parserVersion) return false;
  const legs = await db.transferLeg.findMany({
    where: { transaction: { statementImport: { documentId: stored.id } } },
    select: { matchId: true },
  });
  await db.transferMatch.deleteMany({ where: { id: { in: legs.map((l) => l.matchId) } } });
  await db.sourceDocument.delete({ where: { id: stored.id } });
  return true;
}

/**
 * PDFs in the statements folder (recursively) to import: those whose exact bytes aren't
 * imported yet, and those imported by an older version of their parser (read again, see
 * dropOutdatedReading). Files are named by their path relative to the folder, e.g.
 * "1. Chase/2026-08.pdf".
 */
export async function findNewFolderFiles(
  db: PrismaClient,
  folder = statementsFolder(),
  opts: { outdatedOnly?: boolean } = {},
): Promise<{ folder: string; total: number; files: ImportFile[]; outdated: number }> {
  const paths = await walkPdfs(folder);
  const all = await Promise.all(
    paths.map(async (p) => {
      const bytes = await readFile(p);
      return { fileName: path.relative(folder, p).split(path.sep).join("/"), bytes, hash: hashFile(bytes) };
    }),
  );
  const known = await db.sourceDocument.findMany({
    where: { fileHash: { in: all.map((f) => f.hash) } },
    select: { fileHash: true, parserId: true, parserVersion: true },
  });
  const stored = new Map(known.map((k) => [k.fileHash, k]));
  const isOutdated = (hash: string) => {
    const k = stored.get(hash);
    return !!k && k.parserVersion < (PARSER_VERSIONS[k.parserId] ?? k.parserVersion);
  };
  const files = all
    .filter((f) => (opts.outdatedOnly ? false : !stored.has(f.hash)) || isOutdated(f.hash))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
  return {
    folder,
    total: all.length,
    files: files.map(({ fileName, bytes }) => ({ fileName, bytes })),
    outdated: files.filter((f) => isOutdated(f.hash)).length,
  };
}

/**
 * Re-reads the statements whose parser has changed since they were imported, from the
 * statements folder, so a parser update reaches the ledger without anyone running a
 * command. Run when the server starts; the folder scan does the same on every click.
 */
export async function rereadOutdatedStatements(db: PrismaClient): Promise<number> {
  const scan = await findNewFolderFiles(db, statementsFolder(), { outdatedOnly: true });
  if (scan.files.length === 0) return 0;
  const { outcomes } = await importStatementFiles(db, scan.files);
  return outcomes.filter((o) => o.ok).length;
}
