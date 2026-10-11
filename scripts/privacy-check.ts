/**
 * Fails when anything personal shows up in the files a public copy of this repo would
 * contain (tracked files plus untracked ones git doesn't ignore). What counts as personal
 * comes from this machine's own data, never from the code:
 *   - data/household.json: its privacyTerms, local merchants, fund names, the names in
 *     cardholderNames, and the account endings in its patterns;
 *   - the database: household members' and dependents' names (tax profile), employers
 *     and employees on pay stubs, account numbers (and their last four digits where
 *     printed masked: XXXX1234, ••1234, "ending in 1234"), pay-stub deposit accounts, and
 *     exact amounts with cents from pay stubs, statement closing balances and transactions
 *     of $1,000 or more, smaller charges written next to their own date, and the saved
 *     settings (car costs, make and model; the tax profile's typed-in figures). A database
 *     that exists but can't be read fails the check;
 *   - data/bonus-awards.json: employers, and every salary, bonus and comp figure;
 *   - data/page-inputs.json: the dollar figures typed into the calculators ($10,000 and up,
 *     except round multiples of $50,000, which examples use, and the calculators' defaults);
 *   - data/tax-documents.json (the tax documents folder as read): employers, partnerships,
 *     the names on the forms, EINs, and each W-2's wages and each filed return's AGI and
 *     total tax;
 *   - data/hsa-expenses.json: the patients and providers in the HSA receipts log (providers
 *     of two words or more, so a one-word note like "Dental" doesn't flag the code).
 *
 * Usage: npm run privacy:check [-- --dir <exported copy>]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { householdFilePath, readHouseholdFile } from "../src/lib/household/householdFile.ts";
import { awardsFilePath, readAwards } from "../src/lib/bonuses/awardStore.ts";
import { defaultHomeBudgetInputs } from "../src/lib/home-budget/homeBudgetModel.ts";
import { hsaFilePath } from "../src/lib/hsa/store.ts";
import { defaultInputs as defaultMortgageInputs } from "../src/lib/mortgage/inputs.ts";
import { pageInputsFilePath } from "../src/lib/pageInputs.ts";
import { normalizeProfile, TAX_PROFILE_KEY } from "../src/lib/tax/profile.ts";
import { readTaxDocs } from "../src/lib/taxdocs/store.ts";
import { resolveDbFilePath } from "./databasePath.mjs";

// node:sqlite (Node 22.13+) is loaded untyped: this project's @types/node predates it.
type SqliteDb = { prepare(sql: string): { all(): unknown[] }; close(): void };
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (file: string, options: { readOnly: boolean }) => SqliteDb };

type Term = { label: string; re: RegExp };
const terms = new Map<string, Term>();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A word or phrase, whole-word and case-insensitive; spaces match any run of spaces. */
function word(raw: string) {
  const s = raw.trim();
  if (s.length < 3 || !/[A-Za-z0-9]/.test(s)) return;
  const k = `w:${s.toUpperCase()}`;
  if (!terms.has(k)) terms.set(k, { label: s, re: new RegExp(`(?<![A-Za-z0-9])${esc(s).replace(/\s+/g, "\\s+")}(?![A-Za-z0-9])`, "i") });
}
/** An account's last four digits, as statements print them masked. */
function ending(d: string) {
  const k = `e:${d}`;
  if (!terms.has(k)) terms.set(k, { label: `••${d}`, re: new RegExp(`(?:X{2,}|\\*{2,}|•+|ending(?: in)?\\s*|#)\\s*${d}(?!\\d)`, "i") });
}
/** A dollar figure, written with or without thousands separators ("123,456", "123_456", "123456"). */
function figure(n: number) {
  const groups = Math.round(n).toLocaleString("en-US").split(",");
  const k = `f:${n}`;
  if (!terms.has(k)) terms.set(k, { label: `$${Math.round(n).toLocaleString("en-US")}`, re: new RegExp(`(?<![\\d.,_])${groups.join("[,_]?")}(?![\\d])`) });
}
/**
 * An exact amount with cents, as statements print it ("4,321.09", "4321.09", "432109" in
 * cents). Round dollars are skipped: they show up in code and examples by chance.
 */
function exact(c: number | null) {
  if (c == null || Math.abs(c) < 25_000 || c % 100 === 0) return;
  const [whole, frac] = (Math.abs(c) / 100).toFixed(2).split(".");
  const grouped = Number(whole).toLocaleString("en-US");
  const k = `c:${Math.abs(c)}`;
  if (!terms.has(k)) terms.set(k, { label: `$${grouped}.${frac}`, re: new RegExp(`(?<![\\d.,_])(?:${grouped.split(",").join("[,_]?")}\\.${frac}|${whole}_?${frac})(?!\\d)`) });
}
/** A typed-in dollar figure (salary, bonus, deduction): $10,000 and up, except multiples of $2,500, which round defaults and tax tables use. */
function dollars(n: unknown) {
  if (typeof n === "number" && Number.isFinite(n) && Math.abs(n) >= 10_000 && Math.abs(n) % 2_500 !== 0) figure(Math.abs(n));
}
/** Every leaf of a parsed JSON value, with the key it sits under. */
function walk(v: unknown, visit: (key: string, leaf: unknown) => void, key = "") {
  if (Array.isArray(v)) v.forEach((x) => walk(x, visit, key));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, visit, k);
  else visit(key, v);
}
/** Real charges under $1,000 (cents, by ISO day): flagged only next to their own date. */
const datedCharges = new Map<string, Set<number>>();
/** The ways code writes an amount in cents: "22.62", "1,234.56", "2262", "2_262", "123_456". */
function amountForms(c: number): RegExp {
  const [whole, frac] = (c / 100).toFixed(2).split(".");
  const grouped = Number(whole).toLocaleString("en-US");
  const inCents = c >= 1900 && c <= 2100 ? [] : [c.toLocaleString("en-US").split(",").join("_?")]; // 2025 cents reads as a year
  return new RegExp(`(?<![\\d.,_])(?:${[`${grouped.split(",").join("[,_]?")}\\.${frac}`, ...inCents].join("|")})(?![\\d_])`);
}
/** Literal words in a pattern source: its alternatives with the regex syntax taken out. */
const fragments = (src: string) => src.replace(/\\b/g, " ").split(/[|()?*+.^$[\]{}\\]/).map((f) => f.trim()).filter(Boolean);

// ---- the household file
const household = readHouseholdFile();
if (household) {
  for (const t of household.privacyTerms ?? []) word(t);
  for (const src of Object.values(household.merchantKeywords ?? {})) for (const f of fragments(src)) word(f);
  for (const f of household.funds ?? []) [f.institution, f.statementName, f.accountName ?? "", ...fragments(f.wirePattern ?? "")].forEach(word);
  for (const f of fragments(household.cardholderNames ?? "")) if (f.length >= 3) word(f);
  for (const src of Object.values(household.partner ?? {}))
    for (const f of fragments(src ?? ""))
      for (const d of f.match(/\d{4,}/g) ?? []) {
        if (d.length === 4) ending(d);
        else word(d);
      }
} else {
  console.log(`No household file at ${householdFilePath()}: checking the database and calculators only.`);
}

// ---- the database (read directly with node:sqlite, so a stale or half-generated Prisma
// client can't quietly drop these terms; a database that exists but can't be read fails)
const dbFile = resolveDbFilePath();
if (!existsSync(dbFile)) {
  console.log(`No database at ${dbFile}: checking the data files only.`);
} else {
  try {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    const rows = <T>(sql: string) => db.prepare(sql).all() as T[];
    const setting = rows<{ value: string }>(`SELECT value FROM AppSetting WHERE key = '${TAX_PROFILE_KEY}'`)[0];
    const profile = normalizeProfile(setting ? JSON.parse(setting.value) : null);
    for (const p of profile.persons) [p.name, ...p.match].forEach(word);
    for (const d of profile.dependents) word(d.name);
    for (const u of profile.unavailableAccounts ?? []) ending(u.last4);
    type Stub = { employer: string; employee: string; depositsJson: string | null; netPayCents: number; grossCurrentCents: number | null; grossYtdCents: number | null };
    for (const s of rows<Stub>("SELECT employer, employee, depositsJson, netPayCents, grossCurrentCents, grossYtdCents FROM PayStub")) {
      [s.employer, s.employee].forEach(word);
      [s.netPayCents, s.grossCurrentCents, s.grossYtdCents].forEach(exact);
      for (const d of (JSON.parse(s.depositsJson ?? "[]") as { last4: string | null }[])) if (d.last4) ending(d.last4);
    }
    for (const a of rows<{ identifier: string }>("SELECT identifier FROM AccountAlias")) {
      const digits = a.identifier.replace(/\D/g, "");
      if (digits.length >= 6) word(a.identifier);
      if (digits.length >= 4) ending(digits.slice(-4));
    }
    // Real amounts: statement closing balances, and transactions of $1,000 or more.
    for (const r of rows<{ c: number }>("SELECT closingBalanceCents AS c FROM StatementImport")) exact(r.c);
    for (const r of rows<{ c: number }>(`SELECT amountCents AS c FROM "Transaction" WHERE abs(amountCents) >= 100000`)) exact(r.c);
    // Smaller charges only count when a line also carries their date (a fixture copied from
    // a statement): alone, "$22.62" turns up in code by chance.
    for (const r of rows<{ date: number | string; c: number }>(`SELECT date, amountCents AS c FROM "Transaction" WHERE abs(amountCents) >= 500 AND amountCents % 100 != 0`)) {
      const day = new Date(typeof r.date === "number" ? r.date : Number(r.date) || r.date).toISOString().slice(0, 10);
      (datedCharges.get(day) ?? datedCharges.set(day, new Set()).get(day)!).add(Math.abs(r.c));
    }
    // Saved settings: every exact "…Cents" figure (car costs and values, goals, …), the tax
    // profile's typed-in dollar figures, and the car's make, model and trim.
    for (const s of rows<{ key: string; value: string }>("SELECT key, value FROM AppSetting")) {
      let value: unknown;
      try {
        value = JSON.parse(s.value);
      } catch {
        continue;
      }
      walk(value, (key, v) => {
        if (typeof v === "number" && key.endsWith("Cents")) exact(v);
        else if (typeof v === "number" && s.key === TAX_PROFILE_KEY) dollars(v);
        else if (typeof v === "string" && ["make", "model", "trim"].includes(key)) word(v);
      });
    }
    db.close();
  } catch (e) {
    console.error(`Could not read the database at ${dbFile}: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    console.error("Its names, employers, account numbers and amounts weren't checked, so this is a failure, not a pass.");
    process.exit(1);
  }
}

// ---- calculator figures
if (existsSync(pageInputsFilePath())) {
  try {
    const saved = JSON.parse(readFileSync(pageInputsFilePath(), "utf8")) as { inputs?: Record<string, { value?: Record<string, unknown> }> };
    // A calculator saves every field, typed or not: its defaults are the app's, not yours.
    const defaults: Record<string, Record<string, unknown>> = { "pf-home-budget-inputs": defaultHomeBudgetInputs(), "pf-mortgage-v2": defaultMortgageInputs() };
    for (const [key, entry] of Object.entries(saved.inputs ?? {}))
      for (const [field, v] of Object.entries(entry.value ?? {}))
        if (typeof v === "number" && v >= 10_000 && v % 50_000 !== 0 && v !== defaults[key]?.[field]) figure(v);
  } catch {
    /* unreadable calculator inputs: nothing to add */
  }
}

// ---- the tax documents (filed returns, W-2s, 1099s, K-1s) as read
for (const d of readTaxDocs()?.docs ?? []) {
  d.names.forEach(word);
  const p = d.parsed;
  if (p.kind === "W2") {
    [p.w2.employer, p.w2.employee, p.w2.ein ?? ""].forEach(word);
    if (p.w2.wages >= 1_000_000) figure(p.w2.wages / 100);
  } else if (p.kind === "K1") {
    [p.k1.partnership, p.k1.partner, p.k1.ein ?? ""].forEach(word);
  } else if (p.kind === "1099_BROKERAGE") {
    word(p.f1099.recipient);
    if (p.f1099.account) ending(p.f1099.account);
  } else if (p.kind === "1099_INT" || p.kind === "1099_R") {
    const f = p.kind === "1099_INT" ? p.int : p.r;
    word(f.recipient);
    if (f.account) ending(f.account);
  } else if ("ret" in p) {
    const s = p.ret.federal ?? p.ret.state;
    for (const v of [s?.["agi" as keyof typeof s], s?.totalTax]) if (typeof v === "number" && v >= 1_000_000) figure(v / 100);
  }
}

// ---- the HSA receipts log
if (existsSync(hsaFilePath())) {
  try {
    const log = JSON.parse(readFileSync(hsaFilePath(), "utf8")) as { expenses?: { provider?: string; patient?: string }[] };
    for (const e of log.expenses ?? []) {
      if (e.patient) word(e.patient);
      if (e.provider && /\S\s+\S/.test(e.provider.trim())) word(e.provider);
    }
  } catch {
    /* unreadable log: nothing to add */
  }
}

// ---- the bonus award letters: employers, and every salary, bonus and comp figure
if (existsSync(awardsFilePath())) {
  try {
    const awards = readAwards();
    for (const l of awards.letters) {
      word(l.employer);
      walk(l.awards, (key, v) => {
        if (key !== "year") dollars(v);
      });
    }
    for (const s of awards.stubOnly ?? []) word(s.employer);
  } catch (e) {
    console.error(`Could not read ${awardsFilePath()}: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

// ---- scan what a public copy would contain: this repo's tracked and unignored files, or
// with --dir, every file in an exported copy (npm run publish:export checks its export so)
const dirArg = process.argv.indexOf("--dir");
const exportDir = dirArg > 0 ? path.resolve(process.argv[dirArg + 1] ?? "") : null;
const listAll = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name === ".git" || e.name === "node_modules" ? [] : e.isDirectory() ? listAll(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
const files = exportDir
  ? listAll(exportDir)
  : execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split("\0")
      .filter((f) => f && existsSync(f));
if (exportDir && !files.length) {
  console.error(`Nothing to check in ${exportDir}.`);
  process.exit(1);
}
const hits: string[] = [];
let scanned = 0;
for (const file of files) {
  const buf = readFileSync(file);
  if (buf.includes(0)) continue; // binary
  scanned++;
  const lines = buf.toString("utf8").split("\n");
  lines.forEach((line, i) => {
    for (const t of terms.values()) if (t.re.test(line)) hits.push(`${file}:${i + 1}  ${t.label}  │ ${line.trim().slice(0, 140)}`);
    for (const [day] of line.matchAll(/20\d\d-\d\d-\d\d/g)) {
      const near = lines.slice(Math.max(0, i - 1), i + 2).join(" ");
      for (const c of datedCharges.get(day) ?? [])
        if (amountForms(c).test(near)) hits.push(`${file}:${i + 1}  a real ${day} charge of $${(c / 100).toFixed(2)}  │ ${line.trim().slice(0, 140)}`);
    }
  });
}

if (hits.length) {
  console.log(`\n${hits.length} personal term(s) found in ${scanned} files (${terms.size} terms checked):\n`);
  for (const h of hits) console.log(`  ${h}`);
  console.log("\nMove them to data/household.json (see household.example.json), or make the example generic.");
  process.exit(1);
}
console.log(`No personal terms in ${scanned} files (${terms.size} terms checked).`);
