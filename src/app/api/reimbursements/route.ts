import { checkApiAuth } from "@/lib/auth/checkApiSecret";
import { getBook } from "@/lib/book/cache";
import type { Book } from "@/lib/book/load";
import {
  EMPTY_REIMBURSEMENTS,
  inWindow,
  reimbursedCents,
  rowFingerprint,
  rowSourceKey,
  sourceRemaining,
  stubReimbursementLines,
  stubSourceKey,
  type ResolvedLink,
} from "@/lib/book/reimbursements";
import { prisma } from "@/lib/db";
import { addReimbursementLink, removeReimbursementLink, type ReimbursementSource } from "@/lib/reimbursements/store";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** A payback a charge could be linked to, and how much of it is still free. */
export type PaybackCandidate =
  | { kind: "stub"; key: string; stubId: string; line: string; date: string; person: string | null; employer: string; cents: number; remaining: number }
  | { kind: "row"; key: string; rowId: string; date: string; payee: string; account: string; category: string; cents: number; remaining: number };

export type ReimbursementLinkView = ResolvedLink & { expensePayee: string; expenseCents: number };

export type ReimbursementsResponse = {
  error: string | null;
  links: ReimbursementLinkView[];
  /** Each charge (row id) paid back by applied links, and how much. */
  byExpense: Record<string, number>;
};

export type ChargeReimbursementsResponse = {
  expense: { id: string; date: string; payee: string; account: string; category: string; cents: number };
  reimbursed: number;
  links: ReimbursementLinkView[];
  candidates: PaybackCandidate[];
};

const stateOf = (book: Book) => book.reimbursements ?? EMPTY_REIMBURSEMENTS;
const viewOf = (l: ResolvedLink): ReimbursementLinkView => ({ ...l, expensePayee: l.expense.fingerprint.payee, expenseCents: -l.expense.fingerprint.amountCents });

/**
 * The owner's reimbursement links (book/reimbursements.ts). GET: every link and what each
 * charge has paid back; ?expense=<row id>: that charge's links and the paybacks it could be
 * linked to (pay stub reimbursement lines and incoming rows from a month before to six
 * months after it).
 */
export async function GET(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const book = await getBook(prisma);
  const state = stateOf(book);
  const expenseId = request.nextUrl.searchParams.get("expense");
  if (!expenseId) {
    const byExpense: Record<string, number> = {};
    for (const l of state.links) if (l.status === "APPLIED" && l.expense.rowId) byExpense[l.expense.rowId] = (byExpense[l.expense.rowId] ?? 0) + l.cents;
    return NextResponse.json({ error: state.error ?? null, links: state.links.map(viewOf), byExpense } satisfies ReimbursementsResponse);
  }

  const r = book.rowById.get(expenseId);
  if (!r || r.lane !== "EXPENSE" || r.amountCents >= 0) return NextResponse.json({ error: "Only a spending row can be marked as paid back." }, { status: 400 });
  const accountName = new Map(book.accounts.map((a) => [a.id, a.name]));
  const personName = new Map(book.persons.map((p) => [p.id, p.name]));
  const deposits = new Set(book.stubs.map((s) => s.depositTransactionId).filter(Boolean));
  const fp = rowFingerprint(r, book.accounts);
  const sameCharge = (l: ResolvedLink) => l.expense.rowId === r.id || (l.expense.rowId == null && JSON.stringify(l.expense.fingerprint) === JSON.stringify(fp));

  const candidates: PaybackCandidate[] = [];
  for (const s of book.stubs) {
    if (!s.personId || !inWindow(r.date, s.payDate)) continue;
    for (const l of stubReimbursementLines(s)) {
      const key = stubSourceKey(s.id, l.name);
      candidates.push({ kind: "stub", key, stubId: s.id, line: l.name, date: s.payDate, person: personName.get(s.personId) ?? null, employer: s.employer, cents: l.current!, remaining: sourceRemaining(state, key, l.current!) });
    }
  }
  for (const x of book.rows) {
    // A paycheck deposit is offered through its stub's lines; interest is never a payback.
    if (x.lane !== "INCOME" || x.amountCents <= 0 || x.category === "Interest" || deposits.has(x.id) || !inWindow(r.date, x.bookedOn)) continue;
    const key = rowSourceKey(x.id);
    candidates.push({ kind: "row", key, rowId: x.id, date: x.bookedOn, payee: x.payee, account: accountName.get(x.accountId) ?? "", category: x.category, cents: x.amountCents, remaining: sourceRemaining(state, key, x.amountCents) });
  }
  // Pay stub lines first (where work reimbursements usually are), then by date.
  candidates.sort((a, b) => (a.kind === b.kind ? a.date.localeCompare(b.date) : a.kind === "stub" ? -1 : 1));

  return NextResponse.json({
    expense: { id: r.id, date: r.date, payee: r.payee, account: accountName.get(r.accountId) ?? "", category: r.category, cents: -r.amountCents },
    reimbursed: reimbursedCents(state, r.id),
    links: state.links.filter(sameCharge).map(viewOf),
    candidates,
  } satisfies ChargeReimbursementsResponse);
}

type PostBody = { expenseId?: unknown; source?: { kind?: unknown; stubId?: unknown; line?: unknown; rowId?: unknown }; cents?: unknown; note?: unknown };

/** Body: { expenseId, source: { kind: "stub", stubId, line } | { kind: "row", rowId }, cents, note }. Links part or all of a charge to a payback. */
export async function POST(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as PostBody | null;
  const cents = typeof body?.cents === "number" ? body.cents : NaN;
  if (!body || typeof body.expenseId !== "string" || !body.source || !Number.isInteger(cents) || cents <= 0) {
    return NextResponse.json({ error: "Expected { expenseId, source, cents } with an amount over $0" }, { status: 400 });
  }
  const book = await getBook(prisma);
  const state = stateOf(book);
  if (state.error) return NextResponse.json({ error: state.error }, { status: 409 });
  const r = book.rowById.get(body.expenseId);
  if (!r || r.lane !== "EXPENSE" || r.amountCents >= 0) return NextResponse.json({ error: "Only a spending row can be marked as paid back." }, { status: 400 });
  const left = -r.amountCents - reimbursedCents(state, r.id);
  if (cents > left) return NextResponse.json({ error: `Only $${(left / 100).toFixed(2)} of this charge isn't paid back yet.` }, { status: 400 });

  let source: ReimbursementSource;
  let free: number;
  if (body.source.kind === "stub" && typeof body.source.stubId === "string" && typeof body.source.line === "string") {
    const s = book.stubs.find((x) => x.id === body.source!.stubId);
    const line = s && stubReimbursementLines(s).find((l) => l.name === body.source!.line);
    if (!s || !line || !s.personId) return NextResponse.json({ error: "That pay stub line isn't a household member's reimbursement." }, { status: 400 });
    source = { kind: "stub", stub: { employerKey: s.employerKey, payDate: s.payDate, line: line.name, cents: line.current! } };
    free = sourceRemaining(state, stubSourceKey(s.id, line.name), line.current!);
  } else if (body.source.kind === "row" && typeof body.source.rowId === "string") {
    const x = book.rowById.get(body.source.rowId);
    if (!x || x.lane !== "INCOME" || x.amountCents <= 0) return NextResponse.json({ error: "A payback must be money in (an income row)." }, { status: 400 });
    source = { kind: "row", row: rowFingerprint(x, book.accounts) };
    free = sourceRemaining(state, rowSourceKey(x.id), x.amountCents);
  } else {
    return NextResponse.json({ error: "source must be { kind: \"stub\", stubId, line } or { kind: \"row\", rowId }" }, { status: 400 });
  }
  if (cents > free) return NextResponse.json({ error: `Only $${(free / 100).toFixed(2)} of that payback isn't linked to other charges yet.` }, { status: 400 });

  try {
    const link = addReimbursementLink({ expense: rowFingerprint(r, book.accounts), source, cents, note: typeof body.note === "string" ? body.note : null });
    return NextResponse.json({ link });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not save" }, { status: 400 });
  }
}

/** ?id=<link id>: removes a link. */
export async function DELETE(request: NextRequest) {
  if (!checkApiAuth(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  try {
    if (!removeReimbursementLink(id)) return NextResponse.json({ error: "No such link" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not save" }, { status: 400 });
  }
}
