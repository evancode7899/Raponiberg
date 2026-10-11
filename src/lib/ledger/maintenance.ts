import type { Prisma, PrismaClient } from "@prisma/client";
import { applyRecurringChecks, reclassifyRows, syncMerchantRules } from "../classifier/persist.ts";
import { CLASSIFIER_HOUSEHOLD_SETTING, CLASSIFIER_VERSION, CLASSIFIER_VERSION_SETTING } from "../classifier/version.ts";
import { householdPatterns } from "../household/householdFile.ts";
import { refreshOutdatedFacts } from "../ingest/documentFacts.ts";
import { syncRowDecisions } from "../review/rowDecisions.ts";
import { runTransferMatching } from "../transfers/runMatching.ts";

type Db = PrismaClient | Prisma.TransactionClient;

const DAY = 86_400_000;

/**
 * Links each pay stub to the bank deposit it explains: same net amount, deposit account
 * ending matches the stub, within a few days of the pay date, and unambiguous. A
 * paycheck split across accounts has no single deposit and stays unlinked (the
 * integrity checks report it).
 */
export async function linkPayStubs(db: Db): Promise<number> {
  const stubs = await db.payStub.findMany({ where: { depositTransactionId: null } });
  let linked = 0;
  for (const s of stubs) {
    const deposits = (s.depositsJson ?? []) as { last4: string | null; amount: number }[];
    if (deposits.length > 1) continue;
    const last4 = deposits[0]?.last4 ?? null;
    const candidates = await db.transaction.findMany({
      where: {
        amountCents: s.netPayCents,
        date: { gte: new Date(s.payDate.getTime() - 5 * DAY), lte: new Date(s.payDate.getTime() + 5 * DAY) },
        payStub: null,
        statementImport: { isSummary: false },
        ...(last4 ? { account: { aliases: { some: { identifier: { endsWith: last4 } } } } } : {}),
      },
      select: { id: true },
    });
    if (candidates.length !== 1) continue;
    await db.payStub.update({ where: { id: s.id }, data: { depositTransactionId: candidates[0]!.id } });
    linked++;
  }
  return linked;
}

export type MaintenanceReport = {
  /** Merchant rules saved to / restored from the rules file. */
  merchantRules: { saved: number; restored: number };
  rowDecisions: { saved: number; restored: number; waiting: number };
  /** Rows the current classification rules filed differently. */
  reclassified: number;
  recurringChecks: number;
  transfers: Awaited<ReturnType<typeof runTransferMatching>>;
  payStubsLinked: number;
  factsRefreshed: number;
  factsFailed: { title: string; error: string }[];
};

// One refresh at a time per process (kept on globalThis so a dev-server reload shares it):
// two at once — an import finishing while an edit refreshes — would interleave their
// re-matching of every transfer.
const g = globalThis as unknown as { __ledgerRefresh?: Promise<unknown> };

function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const next = (g.__ledgerRefresh ?? Promise.resolve()).then(fn, fn);
  g.__ledgerRefresh = next.catch(() => undefined);
  return next;
}

/**
 * Everything derived from the full ledger rather than a single statement. Run after any
 * import, deletion, reclassification or owner edit:
 *  - outside a transaction, re-extracts facts for documents stored by an older extractor;
 *  - syncs the merchant rules with their file (restoring any a rebuild lost);
 *  - re-runs the current classification rules over rows the owner hasn't corrected, so a
 *    rule change never leaves stale lanes behind (and records the rules' version);
 *  - re-pairs transfers and re-links pay stubs to deposits.
 * The ledger steps commit together or not at all: a crash or a damaged decisions file
 * part-way through would otherwise leave every automatic pairing undone.
 */
export async function refreshDerived(db: Db): Promise<MaintenanceReport> {
  return oneAtATime(async () => {
    const facts = "$transaction" in db ? await refreshOutdatedFacts(db as PrismaClient) : { refreshed: 0, failed: [] };
    const run = async (tx: Db) => {
      const merchantRules = await syncMerchantRules(tx);
      const rowDecisions = await syncRowDecisions(tx);
      const reclassified = await reclassifyRows(tx);
      const recurringChecks = await applyRecurringChecks(tx);
      const transfers = await runTransferMatching(tx);
      const payStubsLinked = await linkPayStubs(tx);
      const version = String(CLASSIFIER_VERSION);
      await tx.appSetting.upsert({ where: { key: CLASSIFIER_VERSION_SETTING }, create: { key: CLASSIFIER_VERSION_SETTING, value: version }, update: { value: version } });
      const household = householdPatterns().fingerprint;
      await tx.appSetting.upsert({ where: { key: CLASSIFIER_HOUSEHOLD_SETTING }, create: { key: CLASSIFIER_HOUSEHOLD_SETTING, value: household }, update: { value: household } });
      return { merchantRules, rowDecisions, reclassified, recurringChecks, transfers, payStubsLinked };
    };
    const derived = "$transaction" in db ? await (db as PrismaClient).$transaction(run, { timeout: 300_000, maxWait: 60_000 }) : await run(db);
    return { ...derived, factsRefreshed: facts.refreshed, factsFailed: facts.failed };
  });
}
