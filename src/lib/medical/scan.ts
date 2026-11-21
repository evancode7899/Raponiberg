import type { Prisma, PrismaClient } from "@prisma/client";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { importedHashes, statementsFolder } from "../ingest/importFiles.ts";
import { extractPdfText, positionedItems } from "../statements/extractPdfText.ts";
import { hashFile } from "../statements/hashFile.ts";
import { eobCoverage, MEDICAL_READER_VERSION, parseEob, pendingEob, planDocument, readableEob } from "./parse.ts";
import { isMetLifeDentalEob, parseMetLifeDentalEob } from "./readers/metlifeDental.ts";
import { isVspEob, parseVspEob } from "./readers/vsp.ts";
import { readMedicalDocs, writeMedicalDocs } from "./store.ts";
import type { MedicalDocsFile, MedicalFileEntry } from "./types.ts";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Finds the health coverage statements (EOBs) in the statements folder (STATEMENTS_DIR)
 * and reads each one once into data/medical-documents.json. A file unchanged since the
 * last scan (same modified time and size) isn't opened; a changed one is hashed, and only
 * a PDF that is neither an imported statement nor already read has its text read.
 *
 * Readers: Aetna's lettered claims table (lib/medical/parse.ts), MetLife dental and VSP
 * vision (lib/medical/readers). An EOB none of them can follow (another insurer's layout)
 * is kept as PENDING, so the page can say it's waiting; once a reader
 * for it lands, MEDICAL_READER_VERSION goes up and the file is read again.
 */

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.isFile() && /\.pdf$/i.test(e.name) ? [p] : [];
  });
}

/** Reads one PDF: an EOB, an EOB waiting for its reader, or nothing this page uses. */
export async function readMedicalPdf(bytes: Buffer): Promise<Pick<MedicalFileEntry, "doc" | "error">> {
  let text: string;
  try {
    text = await extractPdfText(bytes);
  } catch {
    return {}; // unreadable PDF: not something this page can use
  }
  const coverage = eobCoverage(text);
  if (!coverage) {
    const plan = planDocument(text);
    return plan ? { doc: plan } : {};
  }
  try {
    // Each insurer's layout has its reader; an EOB none of them knows waits as PENDING.
    if (isMetLifeDentalEob(text)) return { doc: parseMetLifeDentalEob(text) };
    if (isVspEob(text)) return { doc: parseVspEob(text) };
    if (!readableEob(text)) return { doc: pendingEob(text, coverage) };
    return { doc: parseEob(text, await positionedItems(bytes)) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function scan(db: Db, folder: string): Promise<MedicalDocsFile> {
  const previous = readMedicalDocs();
  const prev = previous?.files ?? {};
  const bySha = new Map(Object.values(prev).map((e) => [e.sha, e]));
  const files: Record<string, MedicalFileEntry> = {};
  const fresh: { rel: string; stamp: string; sha: string; bytes: Buffer }[] = [];
  let changed = false;

  for (const abs of walk(folder)) {
    const rel = path.relative(folder, abs).split(path.sep).join("/");
    const s = statSync(abs);
    const stamp = `${s.mtimeMs}:${s.size}`;
    const old = prev[rel];
    if (old && old.stamp === stamp && old.version === MEDICAL_READER_VERSION) {
      files[rel] = old;
      continue;
    }
    changed = true;
    const bytes = readFileSync(abs);
    const sha = hashFile(bytes);
    const same = bySha.get(sha);
    if (same && same.version === MEDICAL_READER_VERSION) files[rel] = { ...same, stamp };
    else fresh.push({ rel, stamp, sha, bytes });
  }
  if (Object.keys(prev).some((rel) => !(rel in files))) changed = true;

  // An imported statement is never an EOB: only the rest are opened.
  const imported = await importedHashes(db, fresh.map((f) => f.sha));
  for (const f of fresh) {
    const entry: MedicalFileEntry = { stamp: f.stamp, sha: f.sha, version: MEDICAL_READER_VERSION };
    if (!imported.has(f.sha)) Object.assign(entry, await readMedicalPdf(f.bytes));
    files[f.rel] = entry;
  }

  const out: MedicalDocsFile = { version: 1, scannedAt: new Date().toISOString(), files };
  if (changed || !previous) writeMedicalDocs(out);
  return changed || !previous ? out : previous;
}

// Concurrent requests share one scan (on globalThis: each route is bundled separately).
const g = globalThis as unknown as { __pfMedicalScan?: Promise<MedicalDocsFile> | null };

/** The health coverage statements in the statements folder as they are now; null when the folder doesn't exist. */
export async function refreshMedicalDocs(db: Db, folder = statementsFolder()): Promise<MedicalDocsFile | null> {
  try {
    if (!statSync(folder).isDirectory()) return null;
  } catch {
    return null;
  }
  g.__pfMedicalScan ??= scan(db, folder).finally(() => {
    g.__pfMedicalScan = null;
  });
  return g.__pfMedicalScan;
}
