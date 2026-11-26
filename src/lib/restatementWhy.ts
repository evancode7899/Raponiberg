import type { PrismaClient } from "@prisma/client";
import { splitLink } from "./audit/chain.ts";

/**
 * Why a figure may have moved since the month-end record (restatements.ts): what the audit log
 * says changed since then. Statement imports and deletions count only when they touch the
 * figure's own dates; other changes (a row filed again, a transfer paired, a setting saved)
 * are listed as they are, since any of them can move a figure.
 */
export type Why = { action: string; words: string; count: number };

const WORDS: Record<string, [one: string, many: string]> = {
  statement_imported: ["statement imported for these dates", "statements imported for these dates"],
  statement_deleted: ["statement deleted for these dates", "statements deleted for these dates"],
  statement_restored: ["statement put back", "statements put back"],
  statement_committed: ["statement committed from review", "statements committed from review"],
  transaction_classified: ["row filed again", "row changes filed again"],
  transactions_restored: ["filing undone", "filings undone"],
  ledger_reclassified: ["ledger re-filed by its rules", "ledger re-filings by its rules"],
  transfer_confirmed: ["transfer paired", "transfers paired"],
  transfer_unpaired: ["transfer unpaired", "transfers unpaired"],
  transfer_rejected: ["pairing rejected", "pairings rejected"],
  reimbursement_linked: ["reimbursement linked", "reimbursements linked"],
  reimbursement_unlinked: ["reimbursement unlinked", "reimbursements unlinked"],
  accounts_merged: ["accounts merged", "account merges"],
  account_updated: ["account changed", "account changes"],
  integrity_exception_added: ["exception accepted", "exceptions accepted"],
  integrity_exception_retired: ["exception retired", "exceptions retired"],
  household_settings_updated: ["household setting changed", "household setting changes"],
  import_database_sqlite: ["database restored from a file", "database restores"],
  wipe_database_sqlite: ["database emptied", "database wipes"],
};

/** Changes that can't move a figure: exports, backups, the drill, the password. */
const NEVER_MOVES = new Set(["export_transactions_csv", "export_audit_csv", "export_database_sqlite", "backup_created", "restore_drill_run", "app_password_changed", "hsa_expenses_exported", "statement_import_rejected"]);

const overlaps = (s: { periodStart?: string; periodEnd?: string }, period: { start: string; end: string }) => !!s.periodStart && !!s.periodEnd && s.periodStart <= period.end && s.periodEnd >= period.start;

export async function whySince(db: Pick<PrismaClient, "auditEvent">, takenAt: string, period?: { start: string; end: string } | null): Promise<Why[]> {
  const events = await db.auditEvent.findMany({ where: { occurredAt: { gt: new Date(takenAt) } }, select: { action: true, payloadJson: true } });
  const counts = new Map<string, number>();
  for (const e of events) {
    if (NEVER_MOVES.has(e.action)) continue;
    if (period && (e.action === "statement_imported" || e.action === "statement_deleted")) {
      const p = splitLink(e.payloadJson).payload as { sections?: { periodStart?: string; periodEnd?: string }[] } | null;
      // A deletion's payload names no dates: it counts wherever it happened.
      if (e.action === "statement_imported" && !(p?.sections ?? []).some((s) => overlaps(s, period))) continue;
    }
    counts.set(e.action, (counts.get(e.action) ?? 0) + 1);
  }
  return [...counts]
    .map(([action, count]) => {
      const w = WORDS[action];
      return { action, count, words: w ? w[count === 1 ? 0 : 1] : action.replace(/_/g, " ") };
    })
    .sort((a, b) => b.count - a.count);
}

/** The dates a figure's recipe names, when it names them. */
export function periodOf(descriptor: unknown): { start: string; end: string } | null {
  const d = descriptor as { start?: unknown; end?: unknown; asOf?: unknown; date?: unknown };
  const day = (x: unknown) => (typeof x === "string" && /^\d{4}-\d{2}-\d{2}/.test(x) ? x.slice(0, 10) : null);
  const start = day(d?.start);
  const end = day(d?.end) ?? day(d?.asOf) ?? day(d?.date);
  if (start && end) return { start, end };
  if (end) return { start: "0000-01-01", end };
  return null;
}
