import type { Prisma, PrismaClient } from "@prisma/client";
import { readAwards } from "../bonuses/awardStore.ts";
import { getBook } from "../book/cache.ts";
import type { Book } from "../book/load.ts";
import { buildBonuses } from "../book/reports/bonuses.ts";
import { buildAnnualProfile, type AnnualProfileReport } from "../profile/buildAnnualProfile.ts";
import { loadProfileSettings } from "../profile/settings.ts";
import { loadTaxProfile } from "../tax/profile.ts";
import { bonusFacts, type BonusFacts } from "./bonusSchedule.ts";
import { buildForecast, type Forecast, type ForecastInputs } from "./forecast.ts";

type Db = PrismaClient | Prisma.TransactionClient;

export type ForecastData = {
  /** The annual profile: proven history and the forecast's seeds (null with its blockers when the starting point isn't proven). */
  profile: AnnualProfileReport;
  bonusFacts: BonusFacts;
  /** Why the letters couldn't be read, if they couldn't (the forecast then has no letter payments or patterns). */
  lettersError: string | null;
};

/** Everything the forecast is built from, from the Book (the cached one unless given), the owner's settings and the bonus letters. */
export async function loadForecastData(db: Db, book?: Book): Promise<ForecastData> {
  const [b, settings, taxProfile] = await Promise.all([book ?? getBook(db), loadProfileSettings(db), loadTaxProfile(db)]);
  const profile = buildAnnualProfile(b, settings, taxProfile.dependents);
  let facts: BonusFacts = { scheduled: [], patterns: [] };
  let lettersError: string | null = null;
  try {
    const awards = readAwards();
    facts = bonusFacts(buildBonuses(b, awards, b.today), awards.letters);
  } catch (e) {
    lettersError = (e as Error).message;
  }
  return { profile, bonusFacts: facts, lettersError };
}

export const forecastInputs = (d: ForecastData): ForecastInputs | null => (d.profile.seeds ? { seeds: d.profile.seeds, bonusFacts: d.bonusFacts } : null);

/** The forecast on the saved assumptions, or null (with the profile's blockers) when its starting point isn't proven. */
export async function loadForecast(db: Db, book?: Book): Promise<{ forecast: Forecast | null; data: ForecastData }> {
  const data = await loadForecastData(db, book);
  const inputs = forecastInputs(data);
  return { forecast: inputs ? buildForecast(inputs, data.profile.settings.outlook) : null, data };
}
