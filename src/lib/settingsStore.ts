import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * One JSON AppSetting per module (investment classifications, goals, retirement-account
 * inputs). `normalize` coerces whatever is stored or posted into a well-formed value, so
 * a missing or damaged setting reads as the defaults instead of failing a page.
 */
export async function loadJsonSetting<T>(db: Db, key: string, normalize: (raw: unknown) => T): Promise<T> {
  const row = await db.appSetting.findUnique({ where: { key } });
  if (!row) return normalize(null);
  try {
    return normalize(JSON.parse(row.value));
  } catch {
    return normalize(null);
  }
}

export async function saveJsonSetting<T>(db: Db, key: string, raw: unknown, normalize: (raw: unknown) => T): Promise<T> {
  const value = normalize(raw);
  const json = JSON.stringify(value);
  await db.appSetting.upsert({ where: { key }, create: { key, value: json }, update: { value: json } });
  return value;
}

export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const asString = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
