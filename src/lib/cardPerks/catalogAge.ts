import { CATALOG_AS_OF } from "./catalog.ts";

/** How many whole months the card catalog's terms are older than `today`, and whether that's old enough to say so plainly (six months or more). */
export function catalogAge(today: string, asOf = CATALOG_AS_OF): { asOf: string; months: number; stale: boolean } {
  const months = (Number(today.slice(0, 4)) - Number(asOf.slice(0, 4))) * 12 + Number(today.slice(5, 7)) - Number(asOf.slice(5, 7));
  return { asOf, months: Math.max(0, months), stale: months >= 6 };
}
