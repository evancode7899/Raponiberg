import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

export type AuditAction =
  | "export_transactions_csv"
  | "export_audit_csv"
  | "export_database_sqlite"
  | "backup_created"
  | "import_database_sqlite"
  | "wipe_database_sqlite"
  | "statement_imported"
  | "statement_import_rejected"
  | "statement_committed"
  | "statement_deleted"
  | "account_created"
  | "account_updated"
  | "accounts_merged"
  | "transaction_classified"
  | "transfer_confirmed"
  | "transfer_unpaired"
  | "ledger_reclassified"
  | "household_settings_updated"
  | "tax_profile_updated"
  | "financial_profile_updated"
  | "spending_budget_updated"
  | "investment_settings_updated"
  | "goals_updated"
  | "retirement_accounts_updated"
  | "car_updated"
  | "card_perks_updated"
  | "hsa_expenses_updated"
  | "hsa_expenses_exported"
  | "insurance_notes_updated";

/** Routes authenticated with `x-api-secret` (when secret is set). */
export const AUDIT_ACTOR_API = "api";

/** Settings → database export / import / wipe (when `SETTINGS_DATABASE_SECRET` is set). */
export const AUDIT_ACTOR_SETTINGS = "settings";

/** In-app flows from the browser. */
export const AUDIT_ACTOR_APP = "app";

export async function logAuditEvent(input: {
  action: AuditAction;
  actor?: string;
  payload?: Prisma.InputJsonValue;
  correlationId?: string;
}): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      action: input.action,
      actor: input.actor ?? "system",
      payloadJson: input.payload ?? undefined,
      correlationId: input.correlationId,
    },
  });
}
