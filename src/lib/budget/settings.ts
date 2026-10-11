import type { Prisma, PrismaClient } from "@prisma/client";
import { CATEGORIES } from "../classifier/taxonomy.ts";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The owner's monthly spending targets, by category. A plan, not a figure: nothing here
 * changes what was spent, which comes only from the Book. Stored as one JSON AppSetting.
 */
export type BudgetSettings = {
  version: 1;
  /** Category name → monthly target in cents. A category without one has no target. */
  targets: Record<string, number>;
};

export const BUDGET_SETTINGS_KEY = "spendingBudget.v1";

const SPENDING = new Set(CATEGORIES.filter((c) => c.kind === "EXPENSE" && c.group !== "Money movement").map((c) => c.name));

export function normalizeBudget(raw: unknown): BudgetSettings {
  const targets: Record<string, number> = {};
  const t = (raw as Partial<BudgetSettings> | null)?.targets;
  if (t && typeof t === "object") {
    for (const [k, v] of Object.entries(t)) {
      if (SPENDING.has(k) && typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e11) targets[k] = Math.round(v);
    }
  }
  return { version: 1, targets };
}

export async function loadBudget(db: Db): Promise<BudgetSettings> {
  const row = await db.appSetting.findUnique({ where: { key: BUDGET_SETTINGS_KEY } });
  if (!row) return { version: 1, targets: {} };
  try {
    return normalizeBudget(JSON.parse(row.value));
  } catch {
    return { version: 1, targets: {} };
  }
}

export async function saveBudget(db: Db, raw: unknown): Promise<BudgetSettings> {
  const s = normalizeBudget(raw);
  const value = JSON.stringify(s);
  await db.appSetting.upsert({ where: { key: BUDGET_SETTINGS_KEY }, create: { key: BUDGET_SETTINGS_KEY, value }, update: { value } });
  return s;
}
