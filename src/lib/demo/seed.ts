import type { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { awardsFilePath } from "../bonuses/awardStore.ts";
import { saveBudget } from "../budget/settings.ts";
import { CAR_KEY, normalizeGarage } from "../car/settings.ts";
import { GOALS_KEY, normalizeGoals } from "../goals/settings.ts";
import { hsaFilePath } from "../hsa/store.ts";
import { commitDocument } from "../ingest/commitDocument.ts";
import { refreshDerived } from "../ledger/maintenance.ts";
import { saveJsonSetting } from "../settingsStore.ts";
import { saveTaxProfile } from "../tax/profile.ts";
import { generateDemoData, type DemoOptions } from "./generate.ts";

/**
 * Fills an empty database with the demo household (generate.ts) through the same path a
 * real import takes: every document is committed by commitDocument (dedupe, account
 * resolution, reconciliation, classification), then the ledger-wide refresh pairs the
 * transfers and links the pay stubs to their deposits. The bonus letters go where the
 * Bonuses page reads them (data/demo/bonus-awards.json for the demo), the HSA receipts log
 * where the HSA page does (data/demo/hsa-expenses.json).
 */
export async function seedDemo(db: PrismaClient, opts: DemoOptions = {}): Promise<{ documents: number; transactions: number }> {
  const data = generateDemoData(opts);
  await saveTaxProfile(db, data.taxProfile);
  await saveBudget(db, data.budget);
  await saveJsonSetting(db, GOALS_KEY, data.goals, normalizeGoals);
  await saveJsonSetting(db, CAR_KEY, data.car, normalizeGarage);
  mkdirSync(path.dirname(awardsFilePath()), { recursive: true });
  writeFileSync(awardsFilePath(), JSON.stringify(data.awards, null, 2) + "\n");
  writeFileSync(hsaFilePath(), JSON.stringify(data.hsa, null, 2) + "\n");
  for (const doc of data.documents) {
    const text = JSON.stringify(doc);
    const r = await commitDocument(db, {
      doc,
      fileBytes: Buffer.from(text),
      fileExtension: "json",
      originalFileName: `${doc.title}.json`,
      sourceText: text,
      skipRefresh: true,
    });
    if (!r.ok) throw new Error(`Demo document "${doc.title}" was refused: ${r.message}`);
    const held = r.sections.filter((s) => s.status && s.status !== "COMMITTED");
    if (held.length) throw new Error(`Demo document "${doc.title}" doesn't tie out (off by ${held[0]!.deltaCents} cents).`);
  }
  await refreshDerived(db);
  return { documents: data.documents.length, transactions: data.documents.reduce((t, d) => t + d.sections.reduce((n, x) => n + x.transactions.length, 0), 0) };
}
