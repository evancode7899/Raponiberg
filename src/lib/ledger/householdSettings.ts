import type { Prisma, PrismaClient } from "@prisma/client";
import { isIsoDate } from "../dates/isoDate.ts";
import { householdPatterns } from "../household/householdFile.ts";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * When the household merged finances. Money from the partner's own accounts before this
 * date is a partner contribution into the (then first member's + joint) books; after it,
 * the partner's accounts are household money that simply isn't tracked yet. Charts mark
 * this date. Settings saves it; until then the household file's mergeDate, else none
 * (the partner's money counts as the household's from the start).
 */
export const MERGE_DATE_KEY = "householdMergeDate";
export const DEFAULT_MERGE_DATE = "1900-01-01";

export async function getMergeDate(db: Db): Promise<string> {
  const row = await db.appSetting.findUnique({ where: { key: MERGE_DATE_KEY } });
  return row && isIsoDate(row.value) ? row.value : (householdPatterns().mergeDate ?? DEFAULT_MERGE_DATE);
}

export async function setMergeDate(db: Db, iso: string): Promise<void> {
  if (!isIsoDate(iso)) throw new Error(`Expected YYYY-MM-DD, got ${iso}`);
  await db.appSetting.upsert({
    where: { key: MERGE_DATE_KEY },
    create: { key: MERGE_DATE_KEY, value: iso },
    update: { value: iso },
  });
}

/**
 * How the figures count a partner's money before the merge (book/householdView.ts):
 * STRICT, the household from the merge date; PRO_FORMA, as if merged all along.
 */
export type HouseholdViewMode = "STRICT" | "PRO_FORMA";
export const HOUSEHOLD_VIEW_KEY = "householdView";
export const HOUSEHOLD_VIEW_MODES: readonly HouseholdViewMode[] = ["STRICT", "PRO_FORMA"];

export async function getHouseholdView(db: Db): Promise<HouseholdViewMode> {
  const row = await db.appSetting.findUnique({ where: { key: HOUSEHOLD_VIEW_KEY } });
  return row?.value === "PRO_FORMA" ? "PRO_FORMA" : "STRICT";
}

export async function setHouseholdView(db: Db, mode: HouseholdViewMode): Promise<void> {
  if (!HOUSEHOLD_VIEW_MODES.includes(mode)) throw new Error(`Expected STRICT or PRO_FORMA, got ${mode}`);
  await db.appSetting.upsert({ where: { key: HOUSEHOLD_VIEW_KEY }, create: { key: HOUSEHOLD_VIEW_KEY, value: mode }, update: { value: mode } });
}
