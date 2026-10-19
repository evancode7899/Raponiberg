import type { Prisma, PrismaClient } from "@prisma/client";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../dataDir.ts";
import { ensureCategories } from "../classifier/persist.ts";
import { normPayee, sameRow, type RowFingerprint } from "./rowFingerprint.ts";

export { normPayee, sameRow, type RowFingerprint };

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The owner's row-by-row review answers (category and/or lane for one specific
 * transaction, or just "looked at it, the classifier was right"). Like the merchant rules
 * and transfer decisions, they live in a file next to the database, not only in it:
 * re-importing a statement or rebuilding the database recreates rows with new ids, and an
 * answer tied to the old id (or a flag on the row) would silently vanish.
 *
 * Each row is recorded by what identifies it across imports: its account (institution and
 * every identifier the account goes by), date, amount and payee. Every ledger refresh
 * (a) saves any owner-corrected row missing from the file, and (b) re-applies the file to
 * whatever rows carry those facts today. A fingerprint that matches no row, or that was
 * recorded twice with different answers, is left alone until it is unambiguous.
 *
 * Private by design: gitignored, and every change is appended to a journal beside the file.
 */

export type RowDecision = {
  row: RowFingerprint;
  category: string | null;
  lane: string | null;
  /** True when the owner only confirmed the classifier's answer. */
  reviewedOnly: boolean;
  decidedAt: string;
};
export type RowDecisionsFile = { version: 1; decisions: RowDecision[] };

export function rowDecisionsFilePath(): string {
  return process.env.ROW_DECISIONS_FILE || path.join(dataDir(), "row-decisions.json");
}
const journalPath = (file: string) => file.replace(/\.json$/, "") + ".journal.jsonl";

/** Reads the decisions. A missing file is none; a damaged one is an error, never none. */
export function readRowDecisions(file = rowDecisionsFilePath()): RowDecisionsFile {
  if (!existsSync(file)) return { version: 1, decisions: [] };
  let parsed: Partial<RowDecisionsFile>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<RowDecisionsFile>;
  } catch {
    throw new Error(`The row decisions file ${file} is damaged (not valid JSON). Restore it from ${journalPath(file)} before continuing.`);
  }
  if (typeof parsed.version === "number" && parsed.version > 1) {
    throw new Error(`The row decisions file ${file} was written by a newer version of the app (format ${parsed.version}). Update the app before continuing.`);
  }
  if (!Array.isArray(parsed.decisions)) {
    throw new Error(`The row decisions file ${file} is damaged (missing its list). Restore it from ${journalPath(file)} before continuing.`);
  }
  return { version: 1, decisions: parsed.decisions };
}

function write(file: string, data: RowDecisionsFile, journal: Record<string, unknown>) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(journalPath(file), JSON.stringify({ at: new Date().toISOString(), ...journal }) + "\n");
  const tmp = `${file}.tmp`;
  const text = JSON.stringify(data, null, 2) + "\n";
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, file);
  } catch {
    // OneDrive can briefly lock the file mid-sync (EPERM on rename); write in place instead.
    writeFileSync(file, text);
    rmSync(tmp, { force: true });
  }
}

/**
 * Saves decisions, replacing any earlier answer for the same row. With `onlyNew`, a row
 * the file already knows is left as it is. Returns how many entries changed.
 */
export function recordRowDecisions(entries: Omit<RowDecision, "decidedAt">[], opts: { onlyNew?: boolean; file?: string } = {}): number {
  const file = opts.file ?? rowDecisionsFilePath();
  const data = readRowDecisions(file);
  const changed: RowDecision[] = [];
  for (const e of entries) {
    const i = data.decisions.findIndex((d) => sameRow(d.row, e.row));
    const prev = i >= 0 ? data.decisions[i] : null;
    if (prev && opts.onlyNew) continue;
    if (prev && prev.category === e.category && prev.lane === e.lane && prev.reviewedOnly === e.reviewedOnly) continue;
    const next = { ...e, decidedAt: new Date().toISOString() };
    if (i >= 0) data.decisions[i] = next;
    else data.decisions.push(next);
    changed.push(next);
  }
  if (changed.length) write(file, data, { action: "record", decisions: changed });
  return changed.length;
}

const rowSelect = {
  id: true,
  date: true,
  amountCents: true,
  payee: true,
  lane: true,
  userLocked: true,
  needsReview: true,
  classifiedBy: true,
  category: { select: { name: true } },
  account: { select: { institution: true, aliases: { select: { identifier: true } } } },
} as const;

type Row = Prisma.TransactionGetPayload<{ select: typeof rowSelect }>;

const fingerprint = (r: Row): RowFingerprint => ({
  institution: r.account.institution ?? "",
  identifiers: r.account.aliases.map((a) => a.identifier),
  date: r.date.toISOString().slice(0, 10),
  amountCents: r.amountCents,
  payee: normPayee(r.payee),
});

/** Saves the answer the owner just gave for these rows (ids as of now). */
export async function recordRowDecisionsFor(db: Db, ids: string[], answer: { category: string | null; lane: string | null; reviewedOnly: boolean }) {
  const rows = await db.transaction.findMany({ where: { id: { in: ids } }, select: rowSelect });
  return recordRowDecisions(rows.map((r) => ({ row: fingerprint(r), ...answer })));
}

/**
 * Runs inside every ledger refresh, before the classifier re-runs over unlocked rows.
 * Saves owner corrections found only in the database, then restores saved answers onto
 * rows that lost them. Returns counts for the maintenance report.
 */
export async function syncRowDecisions(db: Db): Promise<{ saved: number; restored: number; waiting: number }> {
  // Database -> file: rows the owner corrected that the file doesn't know yet.
  const corrected = await db.transaction.findMany({
    where: { userLocked: true, classifiedBy: "USER", transferLeg: null, statementImport: { isSummary: false } },
    select: rowSelect,
  });
  const saved = recordRowDecisions(
    corrected.map((r) => ({ row: fingerprint(r), category: r.category?.name ?? null, lane: r.lane, reviewedOnly: false })),
    { onlyNew: true },
  );

  // File -> database.
  const { decisions } = readRowDecisions();
  if (decisions.length === 0) return { saved, restored: 0, waiting: 0 };
  const categoryIds = await ensureCategories(db);
  const amounts = [...new Set(decisions.map((d) => d.row.amountCents))];
  const rows = await db.transaction.findMany({ where: { amountCents: { in: amounts }, statementImport: { isSummary: false } }, select: rowSelect });
  const prints = rows.map((r) => ({ r, fp: fingerprint(r) }));

  let restored = 0;
  let waiting = 0;
  for (const d of decisions) {
    const matches = prints.filter((p) => sameRow(d.row, p.fp)).map((p) => p.r);
    // No row today, or the file holds two answers for look-alike rows: leave them be.
    if (matches.length === 0 || decisions.filter((o) => sameRow(o.row, d.row)).length > 1) {
      waiting++;
      continue;
    }
    for (const r of matches) {
      if (d.reviewedOnly) {
        if (r.needsReview) {
          await db.transaction.update({ where: { id: r.id }, data: { needsReview: false } });
          restored++;
        }
        continue;
      }
      const categoryId = d.category ? categoryIds.get(d.category) : undefined;
      const alreadyApplied = r.userLocked && r.classifiedBy === "USER" && (!d.category || r.category?.name === d.category) && (!d.lane || r.lane === d.lane);
      if (alreadyApplied) continue;
      await db.transaction.update({
        where: { id: r.id },
        data: {
          ...(categoryId ? { categoryId } : {}),
          ...(d.lane ? { lane: d.lane as never } : {}),
          classifiedBy: "USER",
          confidence: "high",
          needsReview: false,
          userLocked: true,
          memo: null,
        },
      });
      restored++;
    }
  }
  return { saved, restored, waiting };
}
