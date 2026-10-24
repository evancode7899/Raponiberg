import { endOfMonth, startOfMonth } from "../../dates/isoDate.ts";
import { formatUsdFromCents } from "../../formatMoney.ts";
import { LANE_LABELS } from "../../classifier/taxonomy.ts";
import { RELABEL } from "../../transfers/relabel.ts";
import type { Book, BookAccount, BookRow, BookStatement, BookStub, BookTransferMatch } from "../load.ts";
import { dayOfFor } from "../reports/cashFlow.ts";
import type { CheckId } from "../types.ts";
import { checksFor, estimatesFor } from "./common.ts";
import { groupRows } from "./payProof.ts";
import type { CashFlowMetric } from "./cashFlowProof.ts";
import type { Proof, ProofBlock, ProofFact, ProofKind, ProofLink } from "./types.ts";

/**
 * The proof behind one ledger row: the line as its statement prints it, how the app files
 * it and which rule decided, the other side of a transfer, the pay stub behind a paycheck,
 * any "paid back" link, and the figures it counts in, each a link. Every rows block in
 * every other proof opens here, so any figure can be followed down to one printed line.
 *
 * Its figure is the amount as printed (a piece's own amount, for a further piece of a
 * landlord's bill payment). It isn't a sum, so there's nothing to re-add.
 */

export type RowDescriptor = { report: "row"; rowId: string };

/** The checks over the row's account and day, in the order the drawer lists them. */
export const ROW_CHECKS: CheckId[] = ["statement.held", "transfer.unmatched", "transfer.decisions", "ledger.consistency", "ledger.freshness"];

export function parseRowDescriptor(d: Record<string, unknown>): RowDescriptor | { error: string } {
  if (typeof d.rowId !== "string" || !d.rowId) return { error: "rowId must name a ledger row." };
  return { report: "row", rowId: d.rowId };
}

const money = (c: number) => (c === 0 ? "$0.00" : formatUsdFromCents(c));

type Link = NonNullable<Book["reimbursements"]>["links"][number];
/** What a row's proof looks up, by id, built once per Book: the sweep opens every row, and a scan of the whole Book for each made it quadratic. */
type RowLookups = {
  accounts: Map<string, BookAccount>;
  statements: Map<string, BookStatement>;
  pieces: Map<string, BookRow[]>;
  matches: Map<string, BookTransferMatch>;
  stubs: Map<string, BookStub[]>;
  links: Map<string, Link[]>;
};
const lookups = new WeakMap<Book, RowLookups>();
const push = <T,>(m: Map<string, T[]>, k: string | null | undefined, v: T) => {
  if (!k) return;
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
};
function lookupsFor(book: Book): RowLookups {
  let l = lookups.get(book);
  if (l) return l;
  l = {
    accounts: new Map(book.accounts.map((a) => [a.id, a])),
    statements: new Map(book.statements.map((s) => [s.id, s])),
    pieces: new Map(),
    matches: new Map(book.matches.map((m) => [m.id, m])),
    stubs: new Map(),
    links: new Map(),
  };
  for (const x of book.rows) push(l.pieces, x.partOf, x);
  for (const s of book.stubs) push(l.stubs, s.depositTransactionId, s);
  for (const k of book.reimbursements?.links ?? []) {
    push(l.links, k.expense.rowId, k);
    if (k.source.rowId !== k.expense.rowId) push(l.links, k.source.rowId, k);
  }
  lookups.set(book, l);
  return l;
}

/** A row by id: a statement's, or one a reimbursement link books. */
export function findRow(book: Book, id: string): BookRow | undefined {
  return book.rowById.get(id) ?? book.reimbursements?.rows.find((r) => r.id === id);
}

/** Which rule filed the row, in plain words, with the rule's own name kept for the record. */
export function decidedBy(r: Pick<BookRow, "classifiedBy" | "merchantKey" | "section">): string {
  const by = r.classifiedBy;
  if (!by) return "No rule: nothing filed it yet";
  const relabel: [string, string][] = [
    [RELABEL.PROMOTED, "The transfer matcher: it's the other side of a transfer between your own accounts"],
    [RELABEL.UNTRACKED_CARD, "The transfer matcher: a card payment no tracked card received, so it's spending on a card with no statements"],
    [RELABEL.CLOSED_CARD_PAYOFF, "The transfer matcher: it paid off what a closed card's last statement left owing"],
    [RELABEL.CLOSED_CARD, "The transfer matcher: a payment to a closed card beyond what its last statement left owing (charges on a statement not on file)"],
    [RELABEL.PARTNER_PAID, "The transfer matcher: a payment on the partner's card that no tracked account sent"],
    [RELABEL.PAID_BILL, "The transfer matcher: a rent payment that paid a landlord's bill on file (the bill's charges are the spending)"],
    [RELABEL.BILL_CREDIT, "The transfer matcher: a payment on a landlord's first bill that no bank payment made"],
  ];
  const hit = relabel.find(([p]) => by.startsWith(p));
  if (hit) return `${hit[1]} · ${by.split(":")[0]}`;
  const words: Record<string, string> = {
    USER: "You, by hand on this row",
    "user-merchant-rule": `Your rule for every row from “${r.merchantKey ?? "this merchant"}”`,
    "merchant-keyword": "The merchant list: the description names a known merchant",
    "square-small-ticket": "A guess: a small purchase through Square",
    fallback: "Nothing recognised it: filed as the default and flagged for review",
    "recurring-check": "Same-amount checks every month: rent",
    "bill-correction": "The ledger: a confirmed bill payment that differs from what the bank paid",
    REIMBURSEMENT: "Your “Paid back” link",
  };
  if (words[by]) return `${words[by]} · ${by}`;
  if (by.startsWith("card-") || by.startsWith("investment-") || by.startsWith("retirement-")) return `The statement's own section${r.section ? ` (“${r.section}”)` : ""} · ${by}`;
  return `A built-in rule for this description · ${by}`;
}

const METRIC: Partial<Record<BookRow["lane"], CashFlowMetric>> = {
  INCOME: "income",
  EXPENSE: "spending",
  EXTERNAL_TRANSFER: "external",
};

export function buildRowProof(book: Book, d: RowDescriptor): Proof {
  const r = findRow(book, d.rowId);
  if (!r)
    throw new Error(
      "That row isn't in the ledger: its statement isn't committed (or is a summary), or it was deleted or re-imported since the page loaded. Only committed statements count in figures.",
    );
  const at = lookupsFor(book);
  const name = (id: string) => at.accounts.get(id)?.name ?? "Account";
  const st = at.statements.get(r.statementImportId);
  // A bill payment booked in pieces: the row the statement prints keeps the first piece, the rest point back at it.
  const whole = r.partOf ? book.rowById.get(r.partOf) : undefined;
  const pieces = at.pieces.get(r.partOf ?? r.id) ?? [];
  const printedCents = (r.partOf ? (whole?.amountCents ?? 0) : r.amountCents) + pieces.reduce((t, x) => t + x.amountCents, 0);
  const isBill = at.accounts.get(r.accountId)?.subtype === "BILL";
  const statementLink: ProofLink | undefined = st
    ? {
        label: `${name(r.accountId)} statement ending ${st.periodEnd}`,
        descriptor: { report: "statement", statementId: st.id },
      }
    : undefined;

  // As printed.
  const printed: ProofFact[] = [
    { label: "Date printed", text: r.date },
    { label: "Description", text: r.payee || "—" },
    ...(r.detail ? [{ label: "Second line", text: r.detail }] : []),
    ...(r.section ? [{ label: "Section", text: r.section }] : []),
    { label: "Amount printed", text: money(printedCents) },
    { label: "Account", text: name(r.accountId) },
    {
      label: "Statement",
      text: st ? `${st.periodStart} – ${st.periodEnd} · ${st.documentTitle || "—"}` : `${r.statement.start} – ${r.statement.end}`,
      link: statementLink,
    },
  ];
  if (r.reimbursement)
    printed.splice(0, printed.length, {
      label: "Not on a statement",
      text: `Booked by your “Paid back” link: a ${r.reimbursement.side === "credit" ? "credit in the charge's category" : "debit from the money the payback came in with"}. It and its pair sum to zero on the same day, so only which category the money sits in moves.`,
      link: {
        label: "The charge it pays back",
        descriptor: { report: "row", rowId: r.reimbursement.expenseId },
      },
    });
  if (r.classifiedBy === "bill-correction")
    printed.unshift({
      label: "Not printed as its own line",
      text: "The ledger books it: a bill payment you confirmed differs from what the bank paid, so the difference is spending on the bill.",
    });
  if (r.partOf || pieces.length)
    printed.push({
      label: "Booked in pieces",
      text: r.partOf
        ? `This is ${money(r.amountCents)} of a ${money(printedCents)} bill payment, booked on ${r.bookedOn} with the bank payment that paid it.`
        : `The bill's ${money(printedCents)} payment is booked with each bank payment that paid it: ${money(r.amountCents)} here and ${pieces.map((x) => `${money(x.amountCents)} on ${x.bookedOn}`).join(", ")}.`,
      ...(whole
        ? {
            link: {
              label: "The whole bill payment",
              descriptor: { report: "row", rowId: whole.id },
            },
          }
        : {}),
    });

  // How it's filed.
  const filed: ProofFact[] = [
    { label: "Counts as", text: LANE_LABELS[r.lane] },
    { label: "Category", text: r.category },
    { label: "Decided by", text: decidedBy(r) },
    r.needsReview
      ? {
          label: "Sure?",
          text: "No: the classifier asked for your answer. It counts as filed until you answer it on Review.",
          tone: "warn",
        }
      : { label: "Sure?", text: "Yes", tone: "good" },
  ];
  if (r.counterpartyKind && r.counterpartyKind !== "MERCHANT")
    filed.push({
      label: "Other side",
      text: [r.counterpartyKind.toLowerCase().replace(/_/g, " "), r.counterpartyInstitution, r.counterpartyAccountHint ? `••${r.counterpartyAccountHint}` : null].filter(Boolean).join(" · "),
    });

  // Where it counts.
  const counts: ProofFact[] = [];
  const dayOf = dayOfFor(book);
  const metric = METRIC[r.lane];
  if (metric) {
    const on = r.precision === "EXACT" ? dayOf(r) : null;
    const month = on ?? r.statement.start;
    counts.push({
      label: "Cash flow",
      text:
        r.precision === "PERIOD"
          ? `A period total: spread evenly across the statement's days, ${r.statement.start} – ${r.statement.end}.`
          : on !== r.bookedOn
            ? `Counts on ${on}${isBill ? ", the bill's own day" : ": rent counts in the month it pays for"} (booked on ${r.bookedOn}).`
            : `Counts on ${on}${on !== r.date ? `: dated ${r.date}, outside its statement's period, so it's booked on the statement's nearest day` : ""}.`,
      link: {
        label: `${r.category}, ${month.slice(0, 7)}`,
        descriptor: {
          report: "cash-flow",
          metric,
          granularity: "month",
          start: startOfMonth(month),
          end: endOfMonth(month),
          category: r.category,
        },
      },
    });
    if (month > book.horizon.cashFlow)
      counts.push({
        label: "Not on pages yet",
        text: `Past the data edge: cash flow is shown through ${book.horizon.cashFlow}, the last day every bank and card account has a statement for.`,
        tone: "warn",
      });
  } else if (r.lane === "TRANSFER") {
    counts.push({
      label: "Cash flow",
      text: "Not income or spending: money moving between your own accounts. The pair nets to zero.",
    });
  } else {
    counts.push({
      label: "Cash flow",
      text: "Not income or spending: a retirement contribution. Net worth counts it as money contributed.",
    });
  }
  if (!r.reimbursement)
    counts.push({
      label: "Net worth",
      text: `Moves ${name(r.accountId)}'s balance on ${r.bookedOn}.`,
      link: {
        label: `${name(r.accountId)} on ${r.bookedOn}`,
        descriptor: {
          report: "net-worth",
          metric: "balance",
          date: r.bookedOn,
          accountIds: [r.accountId],
        },
      },
    });

  const blocks: ProofBlock[] = [
    {
      kind: "facts",
      title: r.reimbursement ? "Where it comes from" : "As the statement prints it",
      items: printed,
    },
    {
      kind: "facts",
      title: "How the app files it",
      items: filed,
      note: "Change it on Transactions (this row, or every row from the merchant) or answer it on Review.",
    },
  ];

  // The other side of a transfer.
  const match = r.transferMatchId ? at.matches.get(r.transferMatchId) : undefined;
  if (match) {
    const others = match.legs.filter((l) => l.transactionId !== r.id);
    blocks.push({
      kind: "facts",
      title: "The other side",
      items: [
        ...others.map((l): ProofFact => ({
          label: name(l.accountId),
          text: `${money(l.amountCents)} on ${l.date}`,
          ...(book.rowById.has(l.transactionId)
            ? {
                link: {
                  label: `${name(l.accountId)} ${l.date}`,
                  descriptor: { report: "row", rowId: l.transactionId },
                },
              }
            : {}),
        })),
        {
          label: "Paired by",
          text: `${match.status === "CONFIRMED" ? "You (confirmed, never re-decided)" : "The transfer matcher, re-checked on every run"}${match.differenceCents ? ` · the legs differ by ${money(match.differenceCents)}, booked as a fee` : " · the legs net to $0.00"}`,
          tone: "good",
        },
      ],
    });
  } else if (r.lane === "TRANSFER" && !r.reimbursement)
    blocks.push({
      kind: "facts",
      title: "The other side",
      items: [
        {
          label: "Unpaired",
          text: "No row on another account's statement is paired with it yet: the statement that shows the other side may not be on file.",
          tone: "warn",
        },
      ],
    });

  // A paycheck: the stub behind it.
  const stubs = at.stubs.get(r.id) ?? [];
  if (stubs.length)
    blocks.push({
      kind: "facts",
      title: "The pay stub behind it",
      items: stubs.map((s) => ({
        label: `${s.employer} · ${s.payDate}`,
        text: `Net pay ${money(s.printed.netCurrent)}${s.printed.netCurrent === r.amountCents ? ": exactly this deposit" : `, ${money(r.amountCents - s.printed.netCurrent)} from this deposit (a split paycheck)`}`,
        link: {
          label: `${s.employer} stub ${s.payDate}`,
          descriptor: { report: "stub", stubId: s.id },
        },
        tone: s.printed.netCurrent === r.amountCents ? ("good" as const) : undefined,
      })),
    });

  // "Paid back" links on it.
  const links = at.links.get(r.id) ?? [];
  if (links.length)
    blocks.push({
      kind: "facts",
      title: "Paid back",
      items: links.map((l) => {
        const charge = l.expense.rowId === r.id;
        const other = charge ? l.source.rowId : l.expense.rowId;
        return {
          label: charge ? `Paid back by ${l.source.label}` : "Pays back a charge",
          text: `${money(l.cents)} · ${l.status === "APPLIED" ? "applied: it moves into the charge's category" : `waiting: ${l.reason ?? "not applied"}`}${l.note ? ` · “${l.note}”` : ""}`,
          ...(other && findRow(book, other)
            ? {
                link: {
                  label: charge ? "The payback" : "The charge",
                  descriptor: { report: "row" as const, rowId: other },
                },
              }
            : {}),
          tone: l.status === "APPLIED" ? ("good" as const) : ("warn" as const),
        };
      }),
    });

  blocks.push({ kind: "facts", title: "Where it counts", items: counts });
  if (st && !r.reimbursement)
    blocks.push({
      kind: "rows",
      title: "The row on its statement",
      figureCents: printedCents,
      groups: groupRows(book, [{ ...(whole ?? r), amountCents: printedCents }]),
      note: "Open the statement for every row it prints and the balances they tie to.",
    });

  const day = r.bookedOn;
  const { checks, withheld } = checksFor(
    book,
    {
      affects: r.lane === "TRANSFER" || r.lane.startsWith("CONTRIBUTION") ? "NET_WORTH" : "CASH_FLOW",
      from: day,
      to: day,
      accountIds: [r.accountId],
    },
    ROW_CHECKS,
  );
  return {
    report: "row",
    descriptor: d,
    describes: `${r.payee || "A row"} · ${name(r.accountId)}, ${r.date}`,
    // As printed: a bill payment booked in pieces is its whole printed amount (the piece itself, opened as a piece).
    figure: { cents: r.partOf ? r.amountCents : printedCents },
    selfCheck: null,
    withheld,
    blocks,
    checks,
    estimates: estimatesFor(book, {
      rowIds: new Set([r.id, ...(r.reimbursement ? [r.reimbursement.expenseId] : [])]),
      from: day,
      to: day,
      accountIds: [r.accountId],
    }),
    through: day,
    today: book.today,
  };
}

export const rowKind: ProofKind<RowDescriptor> = {
  report: "row",
  parse: parseRowDescriptor,
  build: ({ book }, d) => buildRowProof(book, d),
};
