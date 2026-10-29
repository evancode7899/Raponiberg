import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../dataDir.ts";
import { extractPdfText } from "../statements/extractPdfText.ts";
import { readRewards, REWARDS_READER_VERSION, type RewardsSnapshot } from "./rewardsText.ts";

/**
 * data/card-rewards.json: the rewards summary each imported credit card statement prints
 * (rewardsText.ts), read once per stored statement file and kept by document. A document
 * whose file hash and reader version are unchanged isn't opened again, so after the first
 * read only new statements are. Gitignored and backed up with the rest of data/. The page
 * joins it to the cached Book per request, so it isn't part of the Book's data stamp
 * (book/cache.ts). Which files to read comes from the Book (its documents carry their
 * stored file), so this never queries the ledger itself.
 */

export type CardRewardsEntry = { sha: string; version: number; rewards: RewardsSnapshot | null; error?: string };
export type CardRewardsFile = { version: 1; docs: Record<string, CardRewardsEntry> };
export type CardRewardsState = { file: CardRewardsFile; pending: number };

export function cardRewardsFile(): string {
  return process.env.CARD_REWARDS_FILE || path.join(dataDir(), "card-rewards.json");
}

export function readCardRewards(file = cardRewardsFile()): CardRewardsFile {
  if (!existsSync(file)) return { version: 1, docs: {} };
  try {
    const f = JSON.parse(readFileSync(file, "utf8")) as CardRewardsFile;
    return f && typeof f.docs === "object" && f.docs ? f : { version: 1, docs: {} };
  } catch {
    return { version: 1, docs: {} };
  }
}

function write(f: CardRewardsFile, file = cardRewardsFile()) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(f, null, 1));
  renameSync(tmp, file);
}

/** A stored statement file: relative to the app folder, or to the data folder's parent. */
function locate(filePath: string): string | null {
  for (const p of [path.resolve(process.cwd(), filePath), path.resolve(dataDir(), "..", filePath)]) if (existsSync(p)) return p;
  return null;
}

/** A card statement document as the Book lists it. */
export type CardDoc = { id: string; fileHash: string; filePath: string };
type Doc = CardDoc;

const stale = (f: CardRewardsFile, d: Doc) => {
  const e = f.docs[d.id];
  return !e || e.sha !== d.fileHash || e.version !== REWARDS_READER_VERSION;
};

async function readAll(docs: Doc[]): Promise<void> {
  const f = readCardRewards();
  let n = 0;
  for (const d of docs) {
    if (!stale(f, d)) continue;
    const abs = locate(d.filePath);
    let entry: CardRewardsEntry = { sha: d.fileHash, version: REWARDS_READER_VERSION, rewards: null };
    if (abs && /\.pdf$/i.test(abs)) {
      try {
        entry = { ...entry, rewards: readRewards(await extractPdfText(readFileSync(abs))) };
      } catch (e) {
        entry.error = e instanceof Error ? e.message : String(e);
      }
    }
    f.docs[d.id] = entry;
    // Saved as it goes, so a page polling meanwhile sees the balances fill in.
    if (++n % 10 === 0) write(f);
  }
  const ids = new Set(docs.map((d) => d.id));
  for (const id of Object.keys(f.docs)) if (!ids.has(id)) delete f.docs[id];
  write(f);
}

// One read at a time, shared by every request (on globalThis: each route is bundled separately).
const g = globalThis as unknown as { __pfCardRewards?: Promise<void> | null };

/**
 * The rewards read so far, and how many card statements still wait to be read. Starts
 * reading them in the background when any do; the page asks again until none are left.
 */
export function cardRewards(docs: CardDoc[]): CardRewardsState {
  const file = readCardRewards();
  const pending = docs.filter((d) => stale(file, d)).length;
  if (pending && !g.__pfCardRewards) {
    g.__pfCardRewards = readAll(docs)
      .catch(() => undefined)
      .finally(() => {
        g.__pfCardRewards = null;
      });
  }
  return { file, pending };
}
