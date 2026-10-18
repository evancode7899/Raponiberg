import { addDays } from "../dates/isoDate.ts";
import { normPayee, sameRow, type RowFingerprint } from "../review/rowDecisions.ts";
import type { ReimbursementLink, ReimbursementLinksFile, ReimbursementSource, StubLineRef } from "../reimbursements/store.ts";
import type { Book, BookAccount, BookRow, BookStub } from "./load.ts";

/**
 * Reimbursement links (reimbursements/store.ts) found again in the Book, and what they do
 * to the figures.
 *
 * Without a link, a charge the employer paid back counts as spending in its category and
 * the payback offsets total living cost (Annual, Forecast) as "reimbursements received".
 * A link moves that money into the charge's own category: on the day the payback arrived
 * it books a credit in the charge's category (like a merchant refund) and takes the same
 * amount off the money it came in with (the paycheck deposit's or the incoming row's
 * income). The pair sums to zero on the same day and account, so cash flow's net, net
 * worth and total living cost don't move; only which category the money sits in does.
 *
 * The pair lives in `rows`, never in Book.rows: only the views that split spending by
 * category (cash flow, the spending tabs, Annual) read them, so pay, tax, HSA and the
 * integrity checks keep seeing the statements exactly as printed.
 */

export type ReimbursementSide = "credit" | "debit";

/** What a reimbursement row says about where it came from (only set on `rows` below). */
export type ReimbursementTag = { linkId: string; side: ReimbursementSide; source: "stub" | "row"; expenseId: string };

/** A link as found today: applied, or waiting with the reason. */
export type ResolvedLink = {
  id: string;
  cents: number;
  note: string | null;
  linkedAt: string;
  expense: { fingerprint: RowFingerprint; rowId: string | null };
  /** `key` names the payback (one stub line or one incoming row) while it's found; links sharing it share its amount. */
  source: { key: string | null; label: string; date: string; rowId: string | null; stubId: string | null };
  status: "APPLIED" | "WAITING";
  /** Why a waiting link isn't applied, in plain words. */
  reason?: string;
};

export type ReimbursementState = {
  links: ResolvedLink[];
  /** The credit/debit pairs of every applied link. */
  rows: (BookRow & { reimbursement: ReimbursementTag })[];
  /** Set when the file can't be read: no link is applied. */
  error?: string;
};

export const EMPTY_REIMBURSEMENTS: ReimbursementState = { links: [], rows: [] };

/** The rows the category views count: the statements' rows plus the reimbursement pairs. */
export function withReimbursements(book: Pick<Book, "rows" | "reimbursements">): BookRow[] {
  const extra = book.reimbursements?.rows ?? [];
  return extra.length ? [...book.rows, ...extra] : book.rows;
}

/** The row a one-off tag is read from: a reimbursement credit counts the way its charge does. */
export const oneOffSubject = (r: BookRow, rowById: Map<string, BookRow>) => (r.reimbursement ? (rowById.get(r.reimbursement.expenseId) ?? r) : r);

/** A row as a link identifies it across imports. */
export function rowFingerprint(r: Pick<BookRow, "accountId" | "date" | "amountCents" | "payee">, accounts: Pick<BookAccount, "id" | "institution" | "identifiers">[]): RowFingerprint {
  const a = accounts.find((x) => x.id === r.accountId);
  return { institution: a?.institution ?? "", identifiers: a?.identifiers ?? [], date: r.date, amountCents: r.amountCents, payee: normPayee(r.payee) };
}

/**
 * The same row (review/rowDecisions.ts sameRow); an account with no identifiers on file
 * matches by institution alone (two look-alike rows then wait as ambiguous).
 */
const sameCharge = (a: RowFingerprint, b: RowFingerprint) =>
  a.identifiers.length === 0 && b.identifiers.length === 0
    ? a.date === b.date && a.amountCents === b.amountCents && a.payee === b.payee && a.institution === b.institution
    : sameRow(a, b);

/** A pay stub's non-taxable lines paid this period: the ones a link can name. */
export const stubReimbursementLines = (s: BookStub) => s.lines.filter((l) => l.kind === "NONTAXABLE" && (l.current ?? 0) > 0);

const sameStubLine = (a: StubLineRef, s: BookStub) =>
  s.employerKey === a.employerKey && s.payDate === a.payDate && stubReimbursementLines(s).some((l) => l.name === a.line && l.current === a.cents);

const usd = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What a source is in a few words ("Pat's pay stub 2026-03-13 · Parking Reimb"). */
export function sourceLabel(src: ReimbursementSource, personName?: string | null): string {
  if (src.kind === "stub") return `${personName ? `${personName}'s pay stub` : "Pay stub"} ${src.stub.payDate} · ${src.stub.line}`;
  return `${src.row.date} ${src.row.payee || "incoming row"}`;
}

/** A source found in the Book: the money it brought in, the day, and the row it came in with. */
type FoundSource = { key: string; cents: number; date: string; anchor: BookRow | null; stub: BookStub | null };

export function resolveReimbursements(
  file: ReimbursementLinksFile,
  book: { rows: BookRow[]; rowById: Map<string, BookRow>; accounts: BookAccount[]; stubs: BookStub[]; persons?: { id: string; name: string }[] },
): ReimbursementState {
  const prints = new Map<number, { row: BookRow; fp: RowFingerprint }[]>();
  const amounts = new Set(file.links.flatMap((l) => [l.expense.amountCents, ...(l.source.kind === "row" ? [l.source.row.amountCents] : [])]));
  for (const r of book.rows) {
    if (!amounts.has(r.amountCents) || r.partOf) continue;
    const list = prints.get(r.amountCents) ?? [];
    list.push({ row: r, fp: rowFingerprint(r, book.accounts) });
    prints.set(r.amountCents, list);
  }
  const findRow = (fp: RowFingerprint) => (prints.get(fp.amountCents) ?? []).filter((p) => sameCharge(fp, p.fp)).map((p) => p.row);
  const personName = (id: string | null) => book.persons?.find((p) => p.id === id)?.name ?? null;

  const findSource = (src: ReimbursementSource): FoundSource | string => {
    if (src.kind === "stub") {
      const hits = book.stubs.filter((s) => sameStubLine(src.stub, s));
      if (hits.length === 0) return `the pay stub line (${src.stub.payDate}, ${src.stub.line} ${usd(src.stub.cents)}) isn't on file`;
      if (hits.length > 1) return `${hits.length} pay stubs on ${src.stub.payDate} carry that line, so it can't tell which one you meant`;
      const s = hits[0]!;
      // Only a household member's stubs count toward living cost's paycheck reimbursements.
      if (!s.personId) return `the pay stub on ${s.payDate} isn't matched to anyone in the household`;
      const deposit = s.depositTransactionId ? (book.rowById.get(s.depositTransactionId) ?? null) : null;
      return { key: stubSourceKey(s.id, src.stub.line), cents: src.stub.cents, date: s.payDate, anchor: deposit, stub: s };
    }
    const hits = findRow(src.row).filter((r) => r.lane === "INCOME" && r.amountCents > 0);
    if (hits.length === 0) return `the incoming row ${src.row.date} ${usd(src.row.amountCents)} isn't on any statement as income`;
    if (hits.length > 1) return `${hits.length} incoming rows look like ${src.row.date} ${usd(src.row.amountCents)}, so it can't tell which one you meant`;
    const r = hits[0]!;
    return { key: rowSourceKey(r.id), cents: r.amountCents, date: r.bookedOn, anchor: r, stub: null };
  };

  const usedBySource = new Map<string, number>();
  const usedByExpense = new Map<string, number>();
  const links: ResolvedLink[] = [];
  const rows: ReimbursementState["rows"] = [];
  // Oldest first: when two links can't both fit, the one made first keeps its place.
  for (const l of [...file.links].sort((a, b) => a.linkedAt.localeCompare(b.linkedAt))) {
    const base = { id: l.id, cents: l.cents, note: l.note, linkedAt: l.linkedAt };
    const expenses = findRow(l.expense).filter((r) => r.lane === "EXPENSE" && r.amountCents < 0);
    const expense = expenses.length === 1 ? expenses[0]! : null;
    const found = findSource(l.source);
    const src = typeof found === "string" ? null : found;
    const stubPerson = src?.stub?.personId ?? null;
    const view: Omit<ResolvedLink, "status"> = {
      ...base,
      expense: { fingerprint: l.expense, rowId: expense?.id ?? null },
      source: { key: src?.key ?? null, label: sourceLabel(l.source, personName(stubPerson)), date: src?.date ?? (l.source.kind === "stub" ? l.source.stub.payDate : l.source.row.date), rowId: src?.anchor?.id ?? null, stubId: src?.stub?.id ?? null },
    };
    const wait = (reason: string) => links.push({ ...view, status: "WAITING", reason });
    if (!expense) {
      wait(
        expenses.length > 1
          ? `${expenses.length} charges look like ${l.expense.date} ${usd(-l.expense.amountCents)}, so it can't tell which one you meant`
          : `the charge ${l.expense.date} ${usd(-l.expense.amountCents)} isn't on any statement as spending`,
      );
      continue;
    }
    if (!src) {
      wait(found as string);
      continue;
    }
    if (!Number.isInteger(l.cents) || l.cents <= 0) {
      wait("its amount isn't more than $0");
      continue;
    }
    const sourceUsed = usedBySource.get(src.key) ?? 0;
    const expenseUsed = usedByExpense.get(expense.id) ?? 0;
    if (sourceUsed + l.cents > src.cents) {
      wait(`the payback is ${usd(src.cents)} and other links already use ${usd(sourceUsed)} of it`);
      continue;
    }
    if (expenseUsed + l.cents > -expense.amountCents) {
      wait(`the charge is ${usd(-expense.amountCents)} and other links already pay back ${usd(expenseUsed)} of it`);
      continue;
    }
    usedBySource.set(src.key, sourceUsed + l.cents);
    usedByExpense.set(expense.id, expenseUsed + l.cents);
    links.push({ ...view, status: "APPLIED" });
    rows.push(...pair(l, expense, src));
  }
  return { links, rows };
}

/**
 * The two rows an applied link books, on the payback's day and account: a credit in the
 * charge's category and merchant, and the same amount off the income it came in with.
 */
function pair(l: ReimbursementLink, expense: BookRow, src: FoundSource): ReimbursementState["rows"] {
  // Where the money landed: the deposit (or incoming row); a stub whose deposit isn't on
  // file books on the charge's account (the pair sums to zero either way).
  const at = src.anchor ?? expense;
  const source = src.stub ? "stub" : "row";
  const common = {
    date: src.date,
    precision: "EXACT" as const,
    statement: { start: src.date, end: src.date },
    bookedOn: src.date,
    accountId: at.accountId,
    detail: null,
    counterpartyKind: null,
    counterpartyInstitution: null,
    counterpartyAccountHint: null,
    classifiedBy: "REIMBURSEMENT",
    transferMatchId: null,
    statementImportId: at.statementImportId,
    documentId: at.documentId,
  };
  return [
    {
      ...common,
      id: `reimb:${l.id}:credit`,
      amountCents: l.cents,
      lane: "EXPENSE",
      payee: `Paid back: ${expense.payee}`,
      merchantKey: expense.merchantKey,
      category: expense.category,
      categoryGroup: expense.categoryGroup,
      reimbursement: { linkId: l.id, side: "credit", source, expenseId: expense.id },
    },
    {
      ...common,
      id: `reimb:${l.id}:debit`,
      amountCents: -l.cents,
      lane: "INCOME",
      payee: src.stub ? `Reimbursement in pay: ${src.stub.employer}` : `Reimbursement: ${src.anchor!.payee}`,
      merchantKey: src.anchor?.merchantKey ?? null,
      category: src.anchor?.category ?? "Paycheck",
      categoryGroup: src.anchor?.categoryGroup ?? "Income",
      reimbursement: { linkId: l.id, side: "debit", source, expenseId: expense.id },
    },
  ];
}

/** How much of a payback is still free: its amount less the applied links on it. */
export function sourceRemaining(state: ReimbursementState, key: string, cents: number): number {
  return cents - state.links.filter((l) => l.status === "APPLIED" && l.source.key === key).reduce((t, l) => t + l.cents, 0);
}

/** The key a payback goes by (as `ResolvedLink.source.key`). */
export const stubSourceKey = (stubId: string, line: string) => `stub:${stubId}:${line}`;
export const rowSourceKey = (rowId: string) => `row:${rowId}`;

/** How much of a charge is paid back by applied links. */
export const reimbursedCents = (state: ReimbursementState, expenseId: string) =>
  state.links.filter((l) => l.status === "APPLIED" && l.expense.rowId === expenseId).reduce((t, l) => t + l.cents, 0);

/** Pay-stub sources a charge could have been paid back by: from a month before it to six months after. */
export const STUB_WINDOW = { before: 31, after: 183 };
export const inWindow = (expenseDate: string, d: string) => d >= addDays(expenseDate, -STUB_WINDOW.before) && d <= addDays(expenseDate, STUB_WINDOW.after);
