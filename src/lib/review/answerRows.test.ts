import { PrismaClient } from "@prisma/client";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureCategories } from "../classifier/persist";
import { readRules } from "../classifier/ruleStore";
import { AnswerError, answerRows, undoAnswer } from "./answerRows";
import { readRowDecisions } from "./rowDecisions";

// A real SQLite database (the app's own migrations) and real decision files, in a temp folder.
const dir = mkdtempSync(path.join(os.tmpdir(), "answer-rows-"));
let db: PrismaClient;
let categories: Map<string, string>;

beforeAll(async () => {
  process.env.ROW_DECISIONS_FILE = path.join(dir, "row-decisions.json");
  process.env.MERCHANT_RULES_FILE = path.join(dir, "merchant-rules.json");
  db = new PrismaClient({ datasources: { db: { url: `file:${path.join(dir, "test.db").replace(/\\/g, "/")}` } } });
  const migrations = path.resolve("prisma/migrations");
  for (const m of readdirSync(migrations, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const sql = readFileSync(path.join(migrations, m, "migration.sql"), "utf8").replace(/^--.*$/gm, "");
    for (const statement of sql.split(";").map((s) => s.trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
  }
  categories = await ensureCategories(db);
}, 60_000);

afterAll(async () => {
  await db.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.transaction.deleteMany();
  await db.statementImport.deleteMany();
  await db.sourceDocument.deleteMany();
  await db.account.deleteMany();
  await db.merchantCategoryRule.deleteMany();
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json") || n.endsWith(".jsonl"))) rmSync(path.join(dir, f));
  const account = await db.account.create({ data: { id: "acct", name: "Card", type: "CREDIT_CARD", institution: "Example Card Co", aliases: { create: { institution: "Example Card Co", identifier: "1234" } } } });
  const doc = await db.sourceDocument.create({ data: { fileHash: "h", contentFingerprint: "f", filePath: "x", institution: "Example Card Co", kind: "STATEMENT", title: "t", parserId: "manual", parserVersion: 1 } });
  const stmt = await db.statementImport.create({
    data: { accountId: account.id, documentId: doc.id, statementType: "CREDIT_CARD", periodStart: new Date("2026-01-01T12:00:00Z"), periodEnd: new Date("2026-01-31T12:00:00Z"), openingBalanceCents: 0, closingBalanceCents: 0, status: "COMMITTED" },
  });
  const row = (id: string, day: number, cents: number, payee: string, merchantKey: string | null) => ({
    id,
    date: new Date(`2026-01-${String(day).padStart(2, "0")}T12:00:00Z`),
    amountCents: cents,
    payee,
    merchantKey,
    accountId: account.id,
    statementImportId: stmt.id,
    lane: "EXPENSE" as const,
    categoryId: categories.get("Other") ?? null,
    classifiedBy: "fallback",
    confidence: "low",
    needsReview: true,
  });
  await db.transaction.createMany({
    data: [row("a", 3, -1_111, "SPRINGFIELD WIDGETS", "SPRINGFIELD WIDGETS"), row("b", 9, -2_222, "SPRINGFIELD WIDGETS", "SPRINGFIELD WIDGETS"), row("c", 12, -3_333, "CHECK 101", null), row("d", 14, -4_444, "CHECK 102", null)],
  });
});

const filed = async () => Object.fromEntries((await db.transaction.findMany({ include: { category: true } })).map((r) => [r.id, { category: r.category?.name ?? null, lane: r.lane, needsReview: r.needsReview, locked: r.userLocked, by: r.classifiedBy }]));

describe("answering several rows", () => {
  it("files every row together, records each decision, and says what it replaced", async () => {
    const r = await answerRows(db, { ids: ["c", "d"], category: "Dining" });
    const now = await filed();
    expect(now.c).toEqual({ category: "Dining", lane: "EXPENSE", needsReview: false, locked: true, by: "USER" });
    expect(now.d).toEqual(now.c);
    expect(now.a!.category).toBe("Other");
    expect(readRowDecisions().decisions).toHaveLength(2);
    expect(r.needsRefresh).toBe(false);
    expect(r.audit).toEqual(["c", "d"].map((id) => ({ id, before: { category: "Other", lane: "EXPENSE" }, after: { category: "Dining", lane: "EXPENSE" } })));
  });

  it("changes nothing when any row is unknown or the category doesn't exist", async () => {
    const before = await filed();
    await expect(answerRows(db, { ids: ["c", "nope"], category: "Dining" })).rejects.toThrow(AnswerError);
    await expect(answerRows(db, { ids: ["c"], category: "Not a category" })).rejects.toThrow(/Unknown category/);
    await expect(answerRows(db, { ids: ["c"] })).rejects.toThrow(/Nothing to change/);
    expect(await filed()).toEqual(before);
    expect(readRowDecisions().decisions).toEqual([]);
  });

  it("undoes exactly, in the database and the decisions file", async () => {
    const before = await filed();
    const r = await answerRows(db, { ids: ["c", "d"], category: "Dining" });
    expect((await undoAnswer(db, r.undoId)).sort()).toEqual(["c", "d"]);
    expect(await filed()).toEqual(before);
    expect(readRowDecisions().decisions).toEqual([]);
    await expect(undoAnswer(db, r.undoId)).rejects.toThrow(/can't be undone/);
  });

  it("undo brings back an earlier answer rather than none", async () => {
    await answerRows(db, { ids: ["c"], category: "Dining" });
    const second = await answerRows(db, { ids: ["c"], category: "Groceries" });
    await undoAnswer(db, second.undoId);
    expect((await filed()).c!.category).toBe("Dining");
    expect(readRowDecisions().decisions.map((d) => d.category)).toEqual(["Dining"]);
  });

  it("refuses to undo over a later change", async () => {
    const first = await answerRows(db, { ids: ["c"], category: "Dining" });
    await answerRows(db, { ids: ["c"], category: "Groceries" });
    await expect(undoAnswer(db, first.undoId)).rejects.toThrow(/changed again/);
    expect((await filed()).c!.category).toBe("Groceries");
  });

  it("keeps the classifier's answer when it looks right", async () => {
    const r = await answerRows(db, { ids: ["c", "d"], reviewed: true });
    const now = await filed();
    expect([now.c!.needsReview, now.d!.needsReview, now.c!.locked]).toEqual([false, false, false]);
    expect(readRowDecisions().decisions.every((d) => d.reviewedOnly)).toBe(true);
    await undoAnswer(db, r.undoId);
    expect((await filed()).c!.needsReview).toBe(true);
  });
});

describe("teaching a merchant", () => {
  it("files every row from it and forgets the rule on undo", async () => {
    const before = await filed();
    const r = await answerRows(db, { ids: ["a"], category: "Dining", applyToMerchant: true });
    expect(r.needsRefresh).toBe(true);
    const now = await filed();
    expect([now.a!.category, now.b!.category]).toEqual(["Dining", "Dining"]);
    expect(readRules().rules.map((x) => [x.merchantKey, x.category])).toEqual([["SPRINGFIELD WIDGETS", "Dining"]]);
    await undoAnswer(db, r.undoId);
    expect(await filed()).toEqual(before);
    expect(readRules().rules).toEqual([]);
    expect(await db.merchantCategoryRule.count()).toBe(0);
  });

  it("puts back the rule it replaced", async () => {
    await answerRows(db, { ids: ["a"], category: "Dining", applyToMerchant: true });
    const second = await answerRows(db, { ids: ["a"], category: "Groceries", applyToMerchant: true });
    await undoAnswer(db, second.undoId);
    expect(readRules().rules.map((x) => x.category)).toEqual(["Dining"]);
    expect((await filed()).b!.category).toBe("Dining");
  });

  it("won't teach a rule from rows that name no merchant", async () => {
    await expect(answerRows(db, { ids: ["c"], category: "Dining", applyToMerchant: true })).rejects.toThrow(/doesn't name a merchant/);
  });
});
