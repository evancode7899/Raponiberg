import type { Prisma, PrismaClient } from "@prisma/client";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { importedHashes, statementsFolder } from "../ingest/importFiles.ts";
import { extractPdfText } from "../statements/extractPdfText.ts";
import { hashFile } from "../statements/hashFile.ts";
import { INSURANCE_READER_VERSION, insuranceKind, parseInsuranceDoc } from "./parse.ts";
import { readInsuranceDocs, writeInsuranceDocs } from "./store.ts";
import type { InsuranceDocsFile, InsuranceFileEntry } from "./types.ts";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Finds the life insurance documents in the statements folder (STATEMENTS_DIR) and reads
 * each one once into data/insurance-documents.json. A file unchanged since the last scan
 * (same modified time and size) isn't opened; a changed one is hashed, and only a PDF
 * that is neither an imported statement nor already read has its text read. So the first
 * scan reads the folder once and later ones only stat it.
 */

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.isFile() && /\.pdf$/i.test(e.name) ? [p] : [];
  });
}

async function scan(db: Db, folder: string): Promise<InsuranceDocsFile> {
  const previous = readInsuranceDocs();
  const prev = previous?.files ?? {};
  const bySha = new Map(Object.values(prev).map((e) => [e.sha, e]));
  const files: Record<string, InsuranceFileEntry> = {};
  const fresh: { rel: string; stamp: string; sha: string; bytes: Buffer }[] = [];
  let changed = false;

  for (const abs of walk(folder)) {
    const rel = path.relative(folder, abs).split(path.sep).join("/");
    const s = statSync(abs);
    const stamp = `${s.mtimeMs}:${s.size}`;
    const old = prev[rel];
    if (old && old.stamp === stamp && old.version === INSURANCE_READER_VERSION) {
      files[rel] = old;
      continue;
    }
    changed = true;
    const bytes = readFileSync(abs);
    const sha = hashFile(bytes);
    const same = bySha.get(sha);
    if (same && same.version === INSURANCE_READER_VERSION) files[rel] = { ...same, stamp };
    else fresh.push({ rel, stamp, sha, bytes });
  }
  if (Object.keys(prev).some((rel) => !(rel in files))) changed = true;

  // An imported statement is never insurance: only the rest are opened.
  const imported = await importedHashes(db, fresh.map((f) => f.sha));
  for (const f of fresh) {
    const entry: InsuranceFileEntry = { stamp: f.stamp, sha: f.sha, version: INSURANCE_READER_VERSION };
    if (!imported.has(f.sha)) {
      try {
        const text = await extractPdfText(f.bytes);
        if (insuranceKind(text)) {
          try {
            entry.doc = parseInsuranceDoc(text);
          } catch (e) {
            entry.error = e instanceof Error ? e.message : String(e);
          }
        }
      } catch {
        /* unreadable PDF: not something this page can use */
      }
    }
    files[f.rel] = entry;
  }

  const out: InsuranceDocsFile = { version: 1, scannedAt: new Date().toISOString(), files };
  if (changed || !previous) writeInsuranceDocs(out);
  return changed || !previous ? out : previous;
}

// Concurrent requests share one scan (on globalThis: each route is bundled separately).
const g = globalThis as unknown as { __pfInsuranceScan?: Promise<InsuranceDocsFile> | null };

/** The insurance documents in the statements folder as they are now; null when the folder doesn't exist. */
export async function refreshInsuranceDocs(db: Db, folder = statementsFolder()): Promise<InsuranceDocsFile | null> {
  try {
    if (!statSync(folder).isDirectory()) return null;
  } catch {
    return null;
  }
  g.__pfInsuranceScan ??= scan(db, folder).finally(() => {
    g.__pfInsuranceScan = null;
  });
  return g.__pfInsuranceScan;
}
