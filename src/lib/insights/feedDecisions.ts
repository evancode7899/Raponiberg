import path from "node:path";
import { dataDir } from "../dataDir.ts";
import { addMark, readMarks, removeMark, type Mark } from "../markStore.ts";

/**
 * The owner's decisions on the Dashboard's feed: an item dismissed, or put off until a day
 * ("remind me"). Kept in data/feed-decisions.json (lib/markStore.ts), so they survive a
 * rebuilt database and come back with a backup; the demo keeps its own in data/demo.
 * A dismissed item returns only once what it says changes (FeedItem.says).
 */

export const FEED_DECISIONS_FILE_NAME = "feed-decisions.json";

export function feedDecisionsFile(): string {
  return process.env.FEED_DECISIONS_FILE || path.join(dataDir(), FEED_DECISIONS_FILE_NAME);
}

export const readFeedDecisions = (file = feedDecisionsFile()): Mark[] => readMarks(file);
export const decideFeedItem = (m: { id: string; says: string; until?: string | null }, file = feedDecisionsFile()) => addMark(file, m);
export const undoFeedDecision = (id: string, file = feedDecisionsFile()) => removeMark(file, id);
