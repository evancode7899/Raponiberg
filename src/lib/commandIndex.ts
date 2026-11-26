import type { Book } from "./book/load.ts";

/**
 * What the command line can find by name besides pages: the accounts and the merchants of
 * the Book (no figure: a name opens the rows or the proof, which show their own). Built once
 * per Book (api/command/index, cachedReport).
 */
export type CommandIndex = {
  accounts: { id: string; name: string; institution: string | null; archived: boolean }[];
  /** Merchants by how many rows they have, most first: their key and the payee their rows print most. */
  merchants: { key: string; name: string; rows: number }[];
};

const MAX_MERCHANTS = 1500;

export function buildCommandIndex(book: Pick<Book, "accounts" | "rows">): CommandIndex {
  const accounts = book.accounts.map((a) => ({ id: a.id, name: a.name, institution: a.institution, archived: !!a.archived })).sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name));
  const byKey = new Map<string, { rows: number; payees: Map<string, number> }>();
  for (const r of book.rows) {
    if (!r.merchantKey || r.lane === "TRANSFER") continue;
    let m = byKey.get(r.merchantKey);
    if (!m) byKey.set(r.merchantKey, (m = { rows: 0, payees: new Map() }));
    m.rows++;
    m.payees.set(r.payee, (m.payees.get(r.payee) ?? 0) + 1);
  }
  const merchants = [...byKey]
    .map(([key, m]) => ({ key, name: [...m.payees].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? key, rows: m.rows }))
    .sort((a, b) => b.rows - a.rows || a.key.localeCompare(b.key))
    .slice(0, MAX_MERCHANTS);
  return { accounts, merchants };
}
