import type { PrismaClient } from "@prisma/client";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import path from "node:path";
import { splitLink } from "../audit/chain.ts";
import { dataDir } from "../dataDir.ts";
import { importStatementFiles, type FileOutcome } from "./importFiles.ts";

/**
 * Deleting a document keeps its stored file (data/statements), and the audit log says which
 * file it was. So a document deleted by mistake can be put back long after the moment's Undo
 * has passed: the same file, read again by the same pipeline. Its rows come back as they were
 * read; decisions kept in the data folder (transfer pairings, merchant rules) apply again.
 */
export type DeletedDocument = { eventId: string; deletedAt: string; title: string; fileName: string | null };

const HOW_MANY = 20;

type Payload = { documentId?: string; title?: string; fileName?: string | null; filePath?: string };

/** The stored file a deletion names, if it is one inside the data folder that is still there. */
export function storedFileOf(filePath: unknown, root = dataDir(), cwd = process.cwd()): string | null {
  if (typeof filePath !== "string" || !filePath) return null;
  const abs = path.resolve(cwd, filePath);
  const rel = path.relative(path.resolve(root), abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return existsSync(abs) ? abs : null;
}

/** Whether a file starts as a PDF does: only those can be read again (the demo's made-up documents have no PDF behind them). */
export function isPdfFile(file: string): boolean {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(5);
    readSync(fd, head, 0, 5, 0);
    return head.toString("latin1") === "%PDF-";
  } finally {
    closeSync(fd);
  }
}

type Db = Pick<PrismaClient, "auditEvent" | "sourceDocument">;

/** The latest deletions that can still be put back: the file is there and isn't on file again. */
export async function deletedDocuments(db: Db): Promise<DeletedDocument[]> {
  const events = await db.auditEvent.findMany({ where: { action: "statement_deleted" }, orderBy: { occurredAt: "desc" }, take: HOW_MANY * 3, select: { id: true, occurredAt: true, payloadJson: true } });
  const restored = await db.auditEvent.findMany({ where: { action: "statement_restored" }, select: { payloadJson: true } });
  const done = new Set(restored.map((r) => (splitLink(r.payloadJson).payload as { eventId?: string } | null)?.eventId));
  const out: DeletedDocument[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    const p = (splitLink(e.payloadJson).payload ?? {}) as Payload;
    const file = storedFileOf(p.filePath);
    if (done.has(e.id) || !p.filePath || seen.has(p.filePath) || !file || !isPdfFile(file)) continue;
    seen.add(p.filePath);
    if (await db.sourceDocument.findFirst({ where: { filePath: p.filePath }, select: { id: true } })) continue;
    out.push({ eventId: e.id, deletedAt: e.occurredAt.toISOString(), title: p.title ?? p.fileName ?? "A document", fileName: p.fileName ?? null });
    if (out.length >= HOW_MANY) break;
  }
  return out;
}

/** Reads a deleted document's stored file again. */
export async function restoreDeletedDocument(db: PrismaClient, eventId: string): Promise<{ outcome: FileOutcome; payload: Payload }> {
  const e = await db.auditEvent.findUnique({ where: { id: eventId }, select: { action: true, payloadJson: true } });
  if (!e || e.action !== "statement_deleted") throw new Error("That isn't a deleted document.");
  const p = (splitLink(e.payloadJson).payload ?? {}) as Payload;
  const file = storedFileOf(p.filePath);
  if (!file) throw new Error("Its stored file isn't in the data folder any more: import it again from your statements.");
  const { outcomes } = await importStatementFiles(db, [{ fileName: p.fileName ?? path.basename(file), bytes: readFileSync(file) }]);
  return { outcome: outcomes[0]!, payload: p };
}
