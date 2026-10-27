import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../dataDir.ts";
import { isIsoDate } from "../dates/isoDate.ts";
import type { RowFingerprint } from "../review/rowDecisions.ts";
import { asObject, asString, isNum } from "../settingsStore.ts";
import { isExpenseKind, type ExpenseKind } from "./qualify.ts";

/**
 * The HSA receipts log: medical expenses paid out of pocket that the HSA could reimburse
 * tax-free at any time, kept unreimbursed so the account stays invested, plus when each
 * one was finally reimbursed. Like the other owner decisions it lives in a file next to
 * the database (data/hsa-expenses.json), never only in it, so rebuilding the database
 * can't lose a receipt; links to ledger rows are kept by what identifies a row across
 * imports (RowFingerprint), not by row id. Every change is appended to a journal beside
 * the file. The Book never reads it, so saving doesn't rebuild the Book (lib/book/cache.ts).
 */

export type Reimbursement = {
  /** Day the HSA paid it back (null: reimbursed, date not recorded, e.g. from an old spreadsheet). */
  date: string | null;
  /** The HSA withdrawal that paid it, when tied to one. */
  withdrawal: RowFingerprint | null;
  note: string;
  /** When it was marked reimbursed in the app (absent on older entries). */
  markedAt?: string;
};

export type HsaExpense = {
  id: string;
  /** Day the care was paid for (or received): what the IRS cares about is that it came after the HSA was opened. */
  date: string;
  /** Out-of-pocket amount, positive cents. */
  amountCents: number;
  provider: string;
  /** Household member the care was for (free text; the page offers the household's names). */
  patient: string;
  kind: ExpenseKind;
  notes: string;
  /** The owner has the receipt / EOB saved somewhere (the IRS can ask for it years later). */
  receipt: boolean;
  /** Where the receipt lives (a path, a folder, a note). */
  receiptRef: string;
  /** How it entered the log (IMPORT: an old spreadsheet import, no longer offered). */
  source: "MANUAL" | "IMPORT" | "LEDGER";
  /** The card or bank row that paid it, when tied to one by hand or added from the ledger. */
  paidWith: RowFingerprint | null;
  reimbursement: Reimbursement | null;
  /** The owner looked at a flagged expense (its charge doesn't look medical) and kept it. */
  kept?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type HsaSettings = {
  /** The HSA's establishment date: expenses before it can never be reimbursed. */
  openedOn: string | null;
  /** Annual return assumed for "growth from waiting" (null: the HSA's own measured return, else 7%). */
  growthRate: number | null;
  /** Federal + state rate for the strategy comparison (null: the Retirement page's, else 32%). */
  marginalRate: number | null;
  /** Year the owner plans to reimburse the backlog (null: 20 years out). */
  planYear: number | null;
  /** Part of the return paid as dividends, taxed yearly in a taxable account (null: 1.5%). */
  dividendYield: number | null;
  /** Tax on taxable-account dividends and gains: LTCG + NIIT + state (null: 20%). */
  taxableRate: number | null;
  /** Social Security + Medicare saved by contributing through payroll (null: 1.45%, Medicare alone). */
  payrollRate: number | null;
  /** Later medical bills will cover the HSA's growth, so it comes out tax-free too (null: yes). */
  growthCovered: boolean | null;
  /** Tax on HSA growth with no receipt behind it, when it isn't covered (null: the marginal rate). */
  exitRate: number | null;
};

export type HsaFile = {
  version: 1;
  expenses: HsaExpense[];
  /** Ledger rows the owner said aren't HSA expenses: never suggested again. */
  dismissed: RowFingerprint[];
  /** Merchants (merchantKey or payee) never to suggest. */
  ignoredMerchants: string[];
  settings: HsaSettings;
};

export const EMPTY_SETTINGS: HsaSettings = {
  openedOn: null,
  growthRate: null,
  marginalRate: null,
  planYear: null,
  dividendYield: null,
  taxableRate: null,
  payrollRate: null,
  growthCovered: null,
  exitRate: null,
};

export function hsaFilePath(): string {
  return process.env.HSA_EXPENSES_FILE || path.join(dataDir(), "hsa-expenses.json");
}
const journalPath = (file: string) => file.replace(/\.json$/, "") + ".journal.jsonl";

const empty = (): HsaFile => ({ version: 1, expenses: [], dismissed: [], ignoredMerchants: [], settings: { ...EMPTY_SETTINGS } });

/** Reads the log. A missing file is an empty log; a damaged one is an error, never an empty log. */
export function readHsaFile(file = hsaFilePath()): HsaFile {
  if (!existsSync(file)) return empty();
  let parsed: Partial<HsaFile>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<HsaFile>;
  } catch {
    throw new Error(`The HSA receipts file ${file} is damaged (not valid JSON). Restore it from ${journalPath(file)} or a backup before continuing.`);
  }
  if (typeof parsed.version === "number" && parsed.version > 1) {
    throw new Error(`The HSA receipts file ${file} was written by a newer version of the app (format ${parsed.version}). Update the app before continuing.`);
  }
  if (!Array.isArray(parsed.expenses)) {
    throw new Error(`The HSA receipts file ${file} is damaged (missing its list). Restore it from ${journalPath(file)} or a backup before continuing.`);
  }
  return {
    version: 1,
    expenses: parsed.expenses,
    dismissed: Array.isArray(parsed.dismissed) ? parsed.dismissed : [],
    ignoredMerchants: Array.isArray(parsed.ignoredMerchants) ? parsed.ignoredMerchants : [],
    settings: normalizeSettings(parsed.settings),
  };
}

function write(file: string, data: HsaFile, journal: Record<string, unknown>) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(journalPath(file), JSON.stringify({ at: new Date().toISOString(), ...journal }) + "\n");
  data.expenses.sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  const text = JSON.stringify(data, null, 2) + "\n";
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, file);
  } catch {
    // OneDrive can briefly lock the file mid-sync (EPERM on rename); write in place instead.
    writeFileSync(file, text);
    rmSync(tmp, { force: true });
  }
}

// ---------------------------------------------------------------------------- validation

const ratio = (v: unknown, max: number) => (isNum(v) && v >= 0 && v <= max ? v : null);
const isoOrNull = (v: unknown) => (typeof v === "string" && isIsoDate(v) ? v : null);

export function normalizeSettings(raw: unknown): HsaSettings {
  const r = asObject(raw);
  const planYear = isNum(r.planYear) && r.planYear >= 2000 && r.planYear <= 2100 ? Math.round(r.planYear) : null;
  return {
    openedOn: isoOrNull(r.openedOn),
    growthRate: ratio(r.growthRate, 0.3),
    marginalRate: ratio(r.marginalRate, 0.7),
    planYear,
    dividendYield: ratio(r.dividendYield, 0.1),
    taxableRate: ratio(r.taxableRate, 0.5),
    payrollRate: ratio(r.payrollRate, 0.2),
    growthCovered: typeof r.growthCovered === "boolean" ? r.growthCovered : null,
    exitRate: ratio(r.exitRate, 0.7),
  };
}

export function normalizeFingerprint(raw: unknown): RowFingerprint | null {
  const r = asObject(raw);
  if (!isIsoDate(asString(r.date, 10)) || !isNum(r.amountCents) || !Array.isArray(r.identifiers)) return null;
  return {
    institution: asString(r.institution, 80),
    identifiers: r.identifiers.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 80)).slice(0, 20),
    date: asString(r.date, 10),
    amountCents: Math.round(r.amountCents),
    payee: asString(r.payee, 300),
  };
}

/** The editable fields of an expense, validated. Throws with a plain message on bad input. */
export type ExpenseInput = Pick<HsaExpense, "date" | "amountCents" | "provider" | "patient" | "kind" | "notes" | "receipt" | "receiptRef"> & {
  paidWith?: RowFingerprint | null;
  reimbursement?: Reimbursement | null;
  source?: HsaExpense["source"];
};

function normalizeReimbursement(raw: unknown): Reimbursement | null {
  if (raw == null || raw === false) return null;
  const r = asObject(raw);
  const markedAt = asString(r.markedAt, 40);
  return { date: isoOrNull(r.date), withdrawal: normalizeFingerprint(r.withdrawal), note: asString(r.note, 300), ...(markedAt ? { markedAt } : {}) };
}

export function normalizeExpenseInput(raw: unknown): ExpenseInput {
  const r = asObject(raw);
  const date = asString(r.date, 10);
  if (!isIsoDate(date)) throw new Error("Each expense needs a date (YYYY-MM-DD).");
  if (!isNum(r.amountCents) || r.amountCents <= 0 || r.amountCents > 100_000_000) throw new Error("Each expense needs a positive amount.");
  const provider = asString(r.provider, 200).trim();
  if (!provider) throw new Error("Each expense needs a provider or description.");
  return {
    date,
    amountCents: Math.round(r.amountCents),
    provider,
    patient: asString(r.patient, 80).trim(),
    kind: isExpenseKind(r.kind) ? r.kind : "MEDICAL",
    notes: asString(r.notes, 1000),
    receipt: r.receipt === true,
    receiptRef: asString(r.receiptRef, 500),
    ...("paidWith" in r ? { paidWith: normalizeFingerprint(r.paidWith) } : {}),
    ...("reimbursement" in r ? { reimbursement: normalizeReimbursement(r.reimbursement) } : {}),
    ...(r.source === "IMPORT" || r.source === "LEDGER" || r.source === "MANUAL" ? { source: r.source } : {}),
  };
}

// ---------------------------------------------------------------------------- operations

export type HsaOp =
  | { op: "add"; expenses: unknown[] }
  | { op: "update"; id: string; expense: unknown }
  /** `dismiss`: also never suggest their statement rows again ("not an HSA expense"). */
  | { op: "delete"; ids: string[]; dismiss?: boolean }
  | { op: "reimburse"; ids: string[]; date: string | null; withdrawal?: unknown; note?: string }
  | { op: "unreimburse"; ids: string[] }
  /** `receiptRef`: also say where the receipt is (a file in the receipts folder ties it there). */
  | { op: "receipt"; ids: string[]; receipt: boolean; receiptRef?: string }
  | { op: "keep"; ids: string[] }
  | { op: "link"; id: string; row: unknown }
  | { op: "dismiss"; rows: unknown[] }
  | { op: "undismiss"; rows: unknown[] }
  | { op: "ignoreMerchant"; merchant: string }
  | { op: "unignoreMerchant"; merchant: string }
  | { op: "settings"; settings: unknown };

/** The same ledger row (see review/rowDecisions.ts sameRow): institution, a shared identifier, date, amount, payee. */
export const sameFp = (a: RowFingerprint, b: RowFingerprint) =>
  a.date === b.date && a.amountCents === b.amountCents && a.payee === b.payee && a.institution === b.institution && a.identifiers.some((i) => b.identifiers.includes(i));

/** Applies one change to the log and saves it; returns a short summary of what changed. */
export function applyHsaOp(input: HsaOp, file = hsaFilePath()): { changed: number } {
  const data = readHsaFile(file);
  const now = new Date().toISOString();
  const byIds = (ids: unknown) => {
    const want = new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []);
    return data.expenses.filter((e) => want.has(e.id));
  };
  let changed = 0;
  switch (input.op) {
    case "add": {
      if (!Array.isArray(input.expenses) || input.expenses.length === 0) throw new Error("Nothing to add.");
      if (input.expenses.length > 2000) throw new Error("Too many expenses in one go (2,000 at most).");
      const added = input.expenses.map((raw): HsaExpense => {
        const e = normalizeExpenseInput(raw);
        return { id: randomUUID(), ...e, paidWith: e.paidWith ?? null, reimbursement: e.reimbursement ?? null, source: e.source ?? "MANUAL", createdAt: now, updatedAt: now };
      });
      data.expenses.push(...added);
      changed = added.length;
      write(file, data, { op: "add", expenses: added });
      break;
    }
    case "update": {
      const e = data.expenses.find((x) => x.id === input.id);
      if (!e) throw new Error("That expense is no longer in the log.");
      const patch = normalizeExpenseInput(input.expense);
      const before = { ...e };
      Object.assign(e, patch, { source: e.source, updatedAt: now });
      changed = 1;
      write(file, data, { op: "update", before, after: e });
      break;
    }
    case "delete": {
      const gone = byIds(input.ids);
      data.expenses = data.expenses.filter((e) => !gone.includes(e));
      changed = gone.length;
      const dismissed = input.dismiss === true ? gone.flatMap((e) => (e.paidWith && !data.dismissed.some((d) => sameFp(d, e.paidWith!)) ? [e.paidWith] : [])) : [];
      data.dismissed.push(...dismissed);
      if (changed) write(file, data, { op: "delete", expenses: gone, dismissed });
      break;
    }
    case "reimburse": {
      const date = input.date == null ? null : isoOrNull(input.date);
      if (input.date != null && !date) throw new Error("Reimbursement date must be YYYY-MM-DD.");
      const withdrawal = normalizeFingerprint(input.withdrawal);
      const note = asString(input.note, 300);
      for (const e of byIds(input.ids)) {
        e.reimbursement = { date, withdrawal, note, markedAt: now };
        e.updatedAt = now;
        changed++;
      }
      if (changed) write(file, data, { op: "reimburse", ids: input.ids, date, withdrawal, note });
      break;
    }
    case "unreimburse": {
      for (const e of byIds(input.ids)) {
        if (!e.reimbursement) continue;
        e.reimbursement = null;
        e.updatedAt = now;
        changed++;
      }
      if (changed) write(file, data, { op: "unreimburse", ids: input.ids });
      break;
    }
    case "receipt": {
      const ref = typeof input.receiptRef === "string" ? asString(input.receiptRef, 500) : null;
      for (const e of byIds(input.ids)) {
        if (e.receipt === (input.receipt === true) && (ref == null || e.receiptRef === ref)) continue;
        e.receipt = input.receipt === true;
        if (ref != null) e.receiptRef = ref;
        e.updatedAt = now;
        changed++;
      }
      if (changed) write(file, data, { op: "receipt", ids: input.ids, receipt: input.receipt === true, ...(ref != null ? { receiptRef: ref } : {}) });
      break;
    }
    case "keep": {
      for (const e of byIds(input.ids)) {
        if (e.kept) continue;
        e.kept = true;
        e.updatedAt = now;
        changed++;
      }
      if (changed) write(file, data, { op: "keep", ids: input.ids });
      break;
    }
    case "link": {
      const e = data.expenses.find((x) => x.id === input.id);
      if (!e) throw new Error("That expense is no longer in the log.");
      e.paidWith = normalizeFingerprint(input.row);
      e.updatedAt = now;
      changed = 1;
      write(file, data, { op: "link", id: e.id, row: e.paidWith });
      break;
    }
    case "dismiss":
    case "undismiss": {
      const rows = (Array.isArray(input.rows) ? input.rows : []).map(normalizeFingerprint).filter((x): x is RowFingerprint => x != null);
      for (const r of rows) {
        const i = data.dismissed.findIndex((d) => sameFp(d, r));
        if (input.op === "dismiss" && i < 0) {
          data.dismissed.push(r);
          changed++;
        } else if (input.op === "undismiss" && i >= 0) {
          data.dismissed.splice(i, 1);
          changed++;
        }
      }
      if (changed) write(file, data, { op: input.op, rows });
      break;
    }
    case "ignoreMerchant":
    case "unignoreMerchant": {
      const m = asString(input.merchant, 200).trim();
      if (!m) throw new Error("Which merchant?");
      const has = data.ignoredMerchants.includes(m);
      if (input.op === "ignoreMerchant" && !has) data.ignoredMerchants.push(m);
      else if (input.op === "unignoreMerchant" && has) data.ignoredMerchants = data.ignoredMerchants.filter((x) => x !== m);
      else break;
      changed = 1;
      write(file, data, { op: input.op, merchant: m });
      break;
    }
    case "settings": {
      const before = data.settings;
      data.settings = normalizeSettings(input.settings);
      changed = 1;
      write(file, data, { op: "settings", before, after: data.settings });
      break;
    }
    default:
      throw new Error("Unknown change.");
  }
  return { changed };
}
