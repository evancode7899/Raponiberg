import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../dataDir.ts";

/**
 * Accounts the owner says are closed although their last statement didn't end at $0 (a
 * card closed with a small credit, whose closing statement isn't on file; or a closing
 * statement with a balance that was paid off after it). Such an account counts as closed
 * after its last statement: it no longer holds back the data edge or waits for newer
 * statements. Payments to it after that statement first settle what the statement left
 * owing (a transfer: the card ends at $0 on the payoff's day); any beyond that paid
 * charges on a closing statement that isn't on file (spending, like an untracked card).
 *
 * Like the other owner decisions it lives in a file next to the database, keyed by the
 * account's institution and number, so a rebuild keeps it. Every change is also appended
 * to a journal beside the file.
 */

export type ClosedAccount = {
  institution: string;
  /** The account's number at the institution, as on its statements. */
  identifier: string;
  /** Why the owner knows it's closed. */
  note: string;
  savedAt: string;
};

export type ClosedAccountsFile = { version: 1; accounts: ClosedAccount[] };

export function closedAccountsFilePath(): string {
  return process.env.CLOSED_ACCOUNTS_FILE || path.join(dataDir(), "closed-accounts.json");
}

const journalPath = (file: string) => file.replace(/\.json$/, "") + ".journal.jsonl";

/** Reads the list. A missing file is none; a damaged one is an error, never none. */
export function readClosedAccounts(file = closedAccountsFilePath()): ClosedAccountsFile {
  if (!existsSync(file)) return { version: 1, accounts: [] };
  let parsed: Partial<ClosedAccountsFile>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ClosedAccountsFile>;
  } catch {
    throw new Error(`The closed accounts file ${file} is damaged (not valid JSON). Restore it from ${journalPath(file)} before continuing.`);
  }
  if (typeof parsed.version === "number" && parsed.version > 1) {
    throw new Error(`The closed accounts file ${file} was written by a newer version of the app (format ${parsed.version}). Update the app before continuing.`);
  }
  if (!Array.isArray(parsed.accounts)) {
    throw new Error(`The closed accounts file ${file} is damaged (missing its list). Restore it from ${journalPath(file)} before continuing.`);
  }
  return { version: 1, accounts: parsed.accounts };
}

/** Marks an account closed (replacing an earlier entry for it). */
export function saveClosedAccount(entry: Omit<ClosedAccount, "savedAt">, file = closedAccountsFilePath()): ClosedAccount {
  const data = readClosedAccounts(file);
  const saved: ClosedAccount = { ...entry, savedAt: new Date().toISOString() };
  data.accounts = [...data.accounts.filter((a) => !sameAccount(a, entry.institution, [entry.identifier])), saved];
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(journalPath(file), JSON.stringify({ at: saved.savedAt, op: "close", account: saved }) + "\n");
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
  return saved;
}

const upper = (s: string) => s.trim().toUpperCase().replace(/\s+/g, " ");

function sameAccount(a: Pick<ClosedAccount, "institution" | "identifier">, institution: string | null, identifiers: string[]): boolean {
  return upper(a.institution) === upper(institution ?? "") && identifiers.some((i) => upper(i) === upper(a.identifier));
}

/** The owner's closure entry for an account (by institution and any identifier it goes by), if any. */
export function declaredClosure(
  list: ClosedAccount[],
  institution: string | null,
  identifiers: string[],
): ClosedAccount | undefined {
  return list.find((a) => sameAccount(a, institution, identifiers));
}

/**
 * The payments (bank-side, so negative; in date order) that settle what a closed card's
 * last statement left owing: the first ones, when they add up to it exactly. None when
 * nothing was owing or no run of them does.
 */
export function settlement<T extends { amountCents: number }>(payments: T[], owingCents: number): T[] {
  let paid = 0;
  for (let n = 0; n < payments.length && owingCents > 0; n++) {
    paid -= payments[n]!.amountCents;
    if (paid === owingCents) return payments.slice(0, n + 1);
    if (paid > owingCents) break;
  }
  return [];
}
