import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The loader is stubbed: these tests are about when the Book is (re)built, not what's in it.
const loadBook = vi.fn();
vi.mock("./load.ts", () => ({ loadBook: (...a: unknown[]) => loadBook(...a) }));
const { cachedReport, dataStamp, deepFreeze, getBook, keepBookWarm } = await import("./cache.ts");

const db = {} as Parameters<typeof getBook>[0];
let dir: string;
let n = 0;

beforeEach(() => {
  // A fresh cache per test (it lives on globalThis so route bundles share it).
  delete (globalThis as { __pfBookCache?: unknown }).__pfBookCache;
  dir = mkdtempSync(path.join(tmpdir(), "pf-cache-"));
  writeFileSync(path.join(dir, "finance.db"), "db");
  writeFileSync(path.join(dir, "exceptions.json"), "{}");
  vi.stubEnv("DATABASE_URL", `file:${path.join(dir, "finance.db")}`);
  vi.stubEnv("INTEGRITY_EXCEPTIONS_FILE", path.join(dir, "exceptions.json"));
  loadBook.mockReset();
  loadBook.mockImplementation(async () => ({ id: ++n, rows: [{ amountCents: 1 }] }));
});
afterEach(() => vi.unstubAllEnvs());

// mtime resolution can be coarse; writing different content also changes the size.
const touch = (file: string, text: string) => writeFileSync(path.join(dir, file), text);

describe("Book cache", () => {
  it("builds once while nothing changes, and concurrent callers share the build", async () => {
    const [a, b] = await Promise.all([getBook(db), getBook(db)]);
    const c = await getBook(db);
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(loadBook).toHaveBeenCalledTimes(1);
  });

  it("rebuilds after the database or a watched JSON file changes", async () => {
    const first = await getBook(db);
    touch("finance.db", "db plus a write");
    const second = await getBook(db);
    expect(second).not.toBe(first);
    touch("exceptions.json", '{"exceptions":[]}');
    const third = await getBook(db);
    expect(third).not.toBe(second);
    touch("finance.db-wal", "wal");
    expect(await getBook(db)).not.toBe(third);
    expect(loadBook).toHaveBeenCalledTimes(4);
  });

  it("doesn't keep a failed build", async () => {
    loadBook.mockRejectedValueOnce(new Error("locked"));
    await expect(getBook(db)).rejects.toThrow("locked");
    await expect(getBook(db)).resolves.toBeTruthy();
    expect(loadBook).toHaveBeenCalledTimes(2);
  });

  it("hands out a frozen Book", async () => {
    const book = (await getBook(db)) as unknown as { rows: { amountCents: number }[] };
    expect(() => book.rows.push({ amountCents: 2 })).toThrow();
    expect(() => {
      book.rows[0]!.amountCents = 5;
    }).toThrow();
  });

  it("keeps reports until the data changes", async () => {
    const build = vi.fn((b: unknown) => ({ id: (b as { id: number }).id }));
    const one = await cachedReport(db, "r", build);
    expect(await cachedReport(db, "r", build)).toBe(one);
    expect(build).toHaveBeenCalledTimes(1);
    await cachedReport(db, "other", build);
    expect(build).toHaveBeenCalledTimes(2);
    touch("finance.db", "changed");
    expect(await cachedReport(db, "r", build)).not.toBe(one);
    expect(build).toHaveBeenCalledTimes(3);
  });

  it("rebuilds in the background once the data holds still, including after it changes back", async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const stop = keepBookWarm(db, { everyMs: 20 });
    await wait(60);
    expect(loadBook).toHaveBeenCalledTimes(1);
    touch("exceptions.json", '{"changed":true}');
    await wait(150);
    expect(loadBook).toHaveBeenCalledTimes(2);
    // A request builds for a passing state; the data then returns to the warmed one.
    touch("exceptions.json", '{"briefly":1}');
    await getBook(db);
    touch("exceptions.json", '{"changed":true}');
    await wait(150);
    expect(loadBook).toHaveBeenCalledTimes(4);
    expect(await getBook(db)).toBeTruthy();
    expect(loadBook).toHaveBeenCalledTimes(4);
    stop();
  });

  it("stamps the date, so a new day builds a new Book", () => {
    expect(dataStamp().startsWith(new Date().toLocaleDateString("en-CA"))).toBe(true);
  });

  it("deepFreeze reaches into Maps", () => {
    const m = deepFreeze(new Map([["a", { x: 1 }]]));
    expect(Object.isFrozen(m.get("a"))).toBe(true);
  });
});
