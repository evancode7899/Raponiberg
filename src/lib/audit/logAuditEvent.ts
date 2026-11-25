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
  | "insurance_notes_updated"
  | "app_password_changed"
  | "reimbursement_linked"
  | "reimbursement_unlinked"
  | "transfer_rejected"
  | "transactions_restored"
  | "bonus_warning_reviewed"
  | "bonus_review_reopened"
  | "integrity_exception_added"
  | "integrity_exception_retired"
  | "feed_item_dismissed"
  | "feed_item_reminded"
  | "feed_decision_undone"
  | "calendar_item_done"
  | "calendar_item_reopened"
  | "forecast_kept";

/** Routes authenticated with `x-api-secret` (when secret is set). */
export const AUDIT_ACTOR_API = "api";

/** Settings → database export / import / wipe (when `SETTINGS_DATABASE_SECRET` is set). */
export const AUDIT_ACTOR_SETTINGS = "settings";

/** The owner's own rulings on findings (exceptions, reviewed warnings). */
export const AUDIT_ACTOR_OWNER = "owner";

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
