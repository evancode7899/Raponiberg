import type { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { awardsFilePath } from "../bonuses/awardStore.ts";
import { saveBudget } from "../budget/settings.ts";
import { CAR_KEY, normalizeGarage } from "../car/settings.ts";
import { GOALS_KEY, normalizeGoals } from "../goals/settings.ts";
import { hsaFilePath } from "../hsa/store.ts";
import { healthPlansFile } from "../medical/plans.ts";
import { forecastSnapshotsFile } from "../forecast/snapshots.ts";
import { priceIndexFile } from "../priceIndex.ts";
import type { PriceIndexFile } from "../priceIndexMath.ts";
import { medicalDocsFile } from "../medical/store.ts";
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
 * where the HSA page does (data/demo/hsa-expenses.json), the health plan and EOBs where
 * the Book reads them (data/demo/medical-plans.json, medical-documents.json).
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
  writeFileSync(medicalDocsFile(), JSON.stringify(data.medical.docs, null, 1) + "\n");
  writeFileSync(healthPlansFile(), JSON.stringify(data.medical.plans, null, 2) + "\n");
  writeFileSync(forecastSnapshotsFile(), JSON.stringify({ version: 1, snapshots: data.forecastSnapshots }, null, 2) + "\n");
  writeFileSync(priceIndexFile(), JSON.stringify(demoPriceIndex(), null, 1) + "\n");
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

/** The demo's price series: invented levels (prices up a steady 0.25% a month; the market up 0.8% a month, with a three-month fall in 2025), through the month before DEMO_TODAY. */
function demoPriceIndex(): PriceIndexFile {
  const months = (start: number, step: (k: string) => number) => {
    const out: Record<string, number> = {};
    let level = start;
    for (let y = 2021; y <= 2026; y++)
      for (let m = 1; m <= 12; m++) {
        const k = `${y}-${String(m).padStart(2, "0")}`;
        if (k > "2026-06") return out;
        if (k > "2021-01") level *= 1 + step(k);
        out[k] = Math.round(level * 1000) / 1000;
      }
    return out;
  };
  return {
    version: 1,
    series: {
      "cpi-u": { name: "Demo consumer prices (invented)", source: "Invented for the demo", url: "", fetchedOn: "2026-07-01", kind: "price", months: months(260, () => 0.0025) },
      benchmark: { name: "Demo market index (invented)", source: "Invented for the demo", url: "", fetchedOn: "2026-07-01", kind: "total-return", months: months(1000, (k) => (k >= "2025-03" && k <= "2025-05" ? -0.04 : 0.008)) },
    },
  };
}
