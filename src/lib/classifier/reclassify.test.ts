import type { PrismaClient } from "@prisma/client";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTransferMatching } from "../transfers/runMatching";
import { classificationData, classifyRow, ensureCategories, loadClassifyContext, reclassifyRows } from "./persist";
import { CATEGORIES } from "./taxonomy";

// An in-memory stand-in for the few tables the classifier reads and writes (invented rows).

type Stored = Record<string, unknown> & { id: string };

function fakeDb(rows: Stored[]) {
  const updates: { id: string; data: Record<string, unknown> }[] = [];
  const db = {
    category: { findMany: async () => CATEGORIES.map((c) => ({ id: `cat:${c.name}`, name: c.name })) },
    merchantCategoryRule: { findMany: async () => [] },
    appSetting: { findUnique: async () => null },
    transaction: {
      findMany: async () => rows,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push({ id: where.id, data });
        return {};
      },
    },
  };
  return { db: db as unknown as PrismaClient, updates };
}

const account = { institution: "Card Co", subtype: "CREDIT_CARD", type: "CREDIT_CARD" };
const base = { date: new Date("2025-03-04T00:00:00Z"), amountCents: -4_210, payee: "ZQXW QQQ", section: null, detail: null, account, memo: null };

/** The row as the current rules would store it. */
async function filedNow(id: string, overrides: Record<string, unknown> = {}): Promise<Stored> {
  const { db } = fakeDb([]);
  const fresh = classificationData(classifyRow({ id, ...base }, await loadClassifyContext(db)), await ensureCategories(db));
  return { id, ...base, ...fresh, ...overrides };
}

describe("re-running the classification rules", () => {
  it("leaves a row the owner marked reviewed alone when the rules file it the same way", async () => {
    const row = await filedNow("r1");
    expect(row.needsReview).toBe(true);
    const { db, updates } = fakeDb([{ ...row, needsReview: false }]);
    expect(await reclassifyRows(db)).toBe(0);
    expect(updates).toEqual([]);
  });

  it("re-files a row whose lane or category changed, asking for review again", async () => {
    const row = await filedNow("r2");
    const { db, updates } = fakeDb([{ ...row, categoryId: "cat:Groceries", needsReview: false }]);
    expect(await reclassifyRows(db)).toBe(1);
    expect(updates[0]!.data).toMatchObject({ categoryId: row.categoryId, needsReview: true, memo: null });
  });

  it("writes a change to the counterparty alone (transfer matching keys on it)", async () => {
    const row = await filedNow("r3");
    const { db, updates } = fakeDb([{ ...row, counterpartyInstitution: "Somewhere Else" }]);
    expect(await reclassifyRows(db)).toBe(1);
    expect(updates[0]!.data.counterpartyInstitution).toBe(row.counterpartyInstitution);
  });

  it("compares a row the transfer matcher relabelled by what it was before the relabel", async () => {
    const row = await filedNow("r4");
    const stash = { lane: row.lane, categoryId: row.categoryId, classifiedBy: row.classifiedBy, needsReview: row.needsReview, counterpartyKind: row.counterpartyKind };
    const relabelled = { ...row, lane: "EXPENSE", categoryId: "cat:Untracked card payments", classifiedBy: `untracked-card:${row.classifiedBy}`, counterpartyKind: "UNTRACKED_CARD", needsReview: false, memo: JSON.stringify(stash) };
    const { db, updates } = fakeDb([relabelled]);
    expect(await reclassifyRows(db)).toBe(0);
    expect(updates).toEqual([]);

    // A stash written before counterparties were kept is re-filed once; the matcher relabels it again.
    const old: Partial<typeof stash> = { ...stash };
    delete old.counterpartyKind;
    const legacy = fakeDb([{ ...relabelled, memo: JSON.stringify(old) }]);
    expect(await reclassifyRows(legacy.db)).toBe(1);
    expect(legacy.updates[0]!.data).toMatchObject({ classifiedBy: row.classifiedBy, memo: null });
  });
});

describe("transfer matching", () => {
  const saved = process.env.TRANSFER_DECISIONS_FILE;
  afterEach(() => {
    if (saved === undefined) delete process.env.TRANSFER_DECISIONS_FILE;
    else process.env.TRANSFER_DECISIONS_FILE = saved;
  });

  it("stops before changing anything when the decisions file is damaged", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "decisions-")), "transfer-decisions.json");
    writeFileSync(file, "{ not json");
    process.env.TRANSFER_DECISIONS_FILE = file;
    let touched = false;
    const db = new Proxy({}, { get: () => new Proxy({}, { get: () => () => ((touched = true), Promise.resolve([])) }) }) as unknown as PrismaClient;
    await expect(runTransferMatching(db)).rejects.toThrow(/damaged/);
    expect(touched).toBe(false);
  });
});
