import { asObject, asString, isNum } from "../settingsStore.ts";
import { PROGRAMS, productById, type ProgramId } from "./catalog.ts";

/**
 * The owner's card perks choices, stored as one AppSetting (in the database and its
 * backups, never in the code): which catalog product a card is when its name doesn't say,
 * what a point is worth in each rewards program, and cards left off the page. Nothing
 * here records whether a perk was used or how many points posted: the statements say.
 */

export type CardChoice = {
  /** Catalog product; null goes by the account name (guessProduct), "none" for a card with no catalog entry. */
  productId: string | null;
  hidden: boolean;
};

export type CardPerksSettings = {
  version: 2;
  cards: Record<string, CardChoice>;
  /** Cents a point is worth, by program; a program not listed uses its default. */
  pointValues: Partial<Record<ProgramId, number>>;
};

export const CARD_PERKS_KEY = "card-perks.v1";

export function defaultCardPerks(): CardPerksSettings {
  return { version: 2, cards: {}, pointValues: {} };
}

export const centsPerPoint = (s: CardPerksSettings, program: ProgramId): number => s.pointValues[program] ?? PROGRAMS[program].defaultCentsPerPoint;

/** From whatever is stored or posted. Reads the first version too (its product choices and hidden cards carry over). */
export function normalizeCardPerks(raw: unknown): CardPerksSettings {
  const r = asObject(raw);
  const cards: Record<string, CardChoice> = {};
  for (const [id, c] of Object.entries(asObject(r.cards)).slice(0, 60)) {
    const o = asObject(c);
    const pid = asString(o.productId, 60);
    const productId = pid === "none" || productById(pid) ? pid : null;
    const hidden = o.hidden === true;
    if (productId || hidden) cards[id.slice(0, 60)] = { productId, hidden };
  }
  const pointValues: CardPerksSettings["pointValues"] = {};
  for (const [k, v] of Object.entries(asObject(r.pointValues))) {
    if (k in PROGRAMS && PROGRAMS[k as ProgramId].kind === "POINTS" && isNum(v) && v >= 0 && v <= 10) pointValues[k as ProgramId] = Math.round(v * 1000) / 1000;
  }
  return { version: 2, cards, pointValues };
}
