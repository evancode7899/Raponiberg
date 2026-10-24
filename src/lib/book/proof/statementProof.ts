import { formatUsdFromCents } from "../../formatMoney.ts";
import { LANE_LABELS, type Lane } from "../../classifier/taxonomy.ts";
import type { Book, BookRow, BookStatement } from "../load.ts";
import type { CheckId } from "../types.ts";
import { checksFor, estimatesFor } from "./common.ts";
import { groupRows } from "./payProof.ts";
import type { ChainLine, Proof, ProofBlock, ProofFact, ProofKind } from "./types.ts";

/**
 * The proof behind one statement: what the document itself prints, and that it ties to
 * the cent. Every other proof's rows are grouped by the statement they were read from;
 * this is where those groups open, the bottom of every chain.
 *
 *  - The statement's own equation: its printed opening balance, plus every row read off
 *    it, plus the market change and fees it prints (or that its balances leave, for a
 *    statement that doesn't print one), equals its printed closing balance. A statement
 *    committed although it doesn't tie lists the gap as its own line, never hidden.
 *  - The subtotals the statement prints (payments, purchases, deposits…) against the rows
 *    read under them, as the reader checked them at import (statement.held re-verifies).
 *  - Where it sits in its account's chain: the statement before closed at this one's
 *    opening, the one after opens at its closing (statement.chain), each a link.
 *  - The document: file, which reader and version read it, when it was imported.
 *
 * Its figure is the printed closing balance. A landlord's bill payment the ledger books in
 * pieces (one per bank payment) is listed whole, as printed.
 */

export type StatementDescriptor = { report: "statement"; statementId: string };

/** The checks that can withhold a figure built on this statement, in the order the drawer lists them. */
export const STATEMENT_CHECKS: CheckId[] = ["statement.held", "statement.chain", "statement.gap", "statement.history", "transfer.unmatched", "ledger.consistency", "ledger.freshness"];

export function parseStatementDescriptor(d: Record<string, unknown>): StatementDescriptor | { error: string } {
  if (typeof d.statementId !== "string" || !d.statementId) return { error: "statementId must name a statement." };
  return { report: "statement", statementId: d.statementId };
}

const money = (c: number) => (c === 0 ? "$0.00" : formatUsdFromCents(c));

/** The rows a statement prints, as printed: a bill payment booked in pieces put back together; the ledger's own corrections left out. */
export function printedRows(book: Book, statementId: string): BookRow[] {
  const mine = book.rows.filter((r) => r.statementImportId === statementId && r.classifiedBy !== "bill-correction");
  const pieces = new Map<string, number>();
  for (const r of mine) if (r.partOf) pieces.set(r.partOf, (pieces.get(r.partOf) ?? 0) + r.amountCents);
  return mine.filter((r) => !r.partOf).map((r) => (pieces.has(r.id) ? { ...r, amountCents: r.amountCents + pieces.get(r.id)! } : r));
}

/** The account's statements in order (summaries apart: they never chain with the statements they recap). */
function neighbours(book: Book, s: BookStatement) {
  const same = book.statements.filter((x) => x.accountId === s.accountId && x.isSummary === s.isSummary && x.status === "COMMITTED").sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  const prev = [...same].reverse().find((x) => x.periodEnd < s.periodStart);
  const next = same.find((x) => x.periodStart > s.periodEnd);
  return { prev, next };
}

export function buildStatementProof(book: Book, d: StatementDescriptor): Proof {
  const s = book.statements.find((x) => x.id === d.statementId);
  if (!s) throw new Error("No statement with that id is on file: it may have been deleted or re-imported. Reload the page.");
  const account = book.accounts.find((a) => a.id === s.accountId);
  const name = account?.name ?? "Account";
  const doc = book.documents.find((x) => x.id === s.documentId);
  const p = s.printed ?? {
    openingCents: 0,
    closingCents: 0,
    growthCents: 0,
    feesCents: 0,
  };
  const counted = s.status === "COMMITTED" && !s.isSummary;
  const rows = counted ? printedRows(book, s.id) : [];
  const rowsCents = rows.reduce((t, r) => t + r.amountCents, 0);
  const investment = p.growthCents !== 0 || p.feesCents !== 0 || !!s.growthDerived;

  // The statement's own equation, line by line.
  const lines: ChainLine[] = [
    {
      label: "Opening balance, as printed",
      value: { cents: p.openingCents },
      source: "proven",
    },
  ];
  const { prev, next } = neighbours(book, s);
  if (counted) {
    const byLane = new Map<Lane, { n: number; cents: number }>();
    for (const r of rows) {
      const x = byLane.get(r.lane) ?? { n: 0, cents: 0 };
      byLane.set(r.lane, { n: x.n + 1, cents: x.cents + r.amountCents });
    }
    lines.push({
      op: "+",
      label: `${rows.length} row${rows.length === 1 ? "" : "s"} read off it`,
      value: { cents: rowsCents },
      source: "proven",
      note: [...byLane].map(([lane, x]) => `${LANE_LABELS[lane].toLowerCase()} ${money(x.cents)} (${x.n})`).join(" · ") || undefined,
    });
  } else {
    lines.push({
      op: "+",
      label: s.isSummary ? "Rows: a summary's rows are never counted on their own" : "Rows: not in the ledger until the statement is committed",
      value: { text: "—" },
      source: "derived",
    });
  }
  if (investment) {
    lines.push({
      op: "+",
      label: s.growthDerived ? "Market change, worked out from the balances" : "Market change, as printed",
      value: { cents: p.growthCents },
      source: s.growthDerived ? "derived" : "proven",
      note: s.growthDerived ? "This statement prints no market change: it's what its opening and closing balances leave after the listed flows." : undefined,
    });
    if (p.feesCents)
      lines.push({
        op: "+",
        label: "Fees, as printed",
        value: { cents: p.feesCents },
        source: "proven",
      });
  }
  if (s.deltaCents !== 0)
    lines.push({
      op: "+",
      label: "Not explained by the statement's own lines",
      value: { cents: s.deltaCents },
      source: "estimate",
      note: "The statement doesn't tie by this much and was committed anyway: the gap shows as unexplained on Net worth (statement.held below).",
    });
  lines.push({
    op: "=",
    label: "Closing balance, as printed",
    value: { cents: p.closingCents },
    source: "proven",
    link: counted
      ? {
          label: `${name} on ${s.periodEnd}`,
          descriptor: {
            report: "net-worth",
            metric: "balance",
            date: s.periodEnd,
            accountIds: [s.accountId],
          },
        }
      : undefined,
  });

  const blocks: ProofBlock[] = [
    {
      kind: "chain",
      title: "The statement's own arithmetic",
      lines,
      note: counted ? "Every figure built on this account reads these rows and balances: net worth uses the balances, cash flow the rows." : undefined,
    },
  ];

  // The subtotals the statement prints, re-added from the rows read under each.
  if (s.checks?.length)
    blocks.push({
      kind: "chain",
      title: "Totals the statement prints, re-added from its rows",
      lines: s.checks.map((c): ChainLine => {
        const off = c.actualCents - c.expectedCents;
        return {
          label: c.label,
          value: { cents: c.expectedCents },
          source: "proven",
          note: Math.abs(off) <= c.toleranceCents ? `the rows read come to ${money(c.actualCents)}: they match` : `the rows read come to ${money(c.actualCents)}: ${money(off)} off`,
        };
      }),
      note: "Checked when the statement was imported; the statement.held check below re-checks every one.",
    });

  // Its place in the account's chain of statements.
  const chain: ProofFact[] = [];
  if (prev?.printed)
    chain.push({
      label: "The statement before",
      text: `${prev.periodStart} – ${prev.periodEnd}, closed at ${money(prev.printed.closingCents)}${prev.printed.closingCents === p.openingCents ? ": this one opens there" : `: this one opens at ${money(p.openingCents)}, ${money(p.openingCents - prev.printed.closingCents)} apart`}${dayGap(prev.periodEnd, s.periodStart)}`,
      link: {
        label: `${name}, statement ending ${prev.periodEnd}`,
        descriptor: { report: "statement", statementId: prev.id },
      },
      tone: prev.printed.closingCents === p.openingCents ? "good" : "warn",
    });
  else
    chain.push({
      label: "The statement before",
      text: s.isSummary ? "A summary: it recaps the statements it overlaps." : "None on file: this is the account's first statement.",
    });
  if (next?.printed)
    chain.push({
      label: "The statement after",
      text: `${next.periodStart} – ${next.periodEnd}, opens at ${money(next.printed.openingCents)}${next.printed.openingCents === p.closingCents ? ": where this one closed" : `: ${money(next.printed.openingCents - p.closingCents)} from where this one closed`}${dayGap(s.periodEnd, next.periodStart)}`,
      link: {
        label: `${name}, statement ending ${next.periodEnd}`,
        descriptor: { report: "statement", statementId: next.id },
      },
      tone: next.printed.openingCents === p.closingCents ? "good" : "warn",
    });
  else if (!s.isSummary)
    chain.push({
      label: "The statement after",
      text: "None on file yet: this is the latest.",
    });
  blocks.push({
    kind: "facts",
    title: "Its place among the account's statements",
    items: chain,
  });

  if (rows.length)
    blocks.push({
      kind: "rows",
      title: "Every row read off it",
      figureCents: rowsCents,
      groups: groupRows(book, rows),
      note: "As printed, in date order. Open a row for how it's filed and where it counts.",
    });

  blocks.push({
    kind: "facts",
    title: "The document",
    items: [
      {
        label: "Account",
        text: `${name}${account?.institution ? ` · ${account.institution}` : ""}`,
      },
      {
        label: "Period",
        text: `${s.periodStart} – ${s.periodEnd}${s.isSummary ? " (a year-end summary: it fills gaps between statements only)" : ""}`,
      },
      { label: "File", text: s.documentTitle || "—" },
      ...(doc
        ? [
            {
              label: "Read by",
              text: doc.parserId === "manual" ? "Hand-parsed (typed in from the document)" : `${doc.parserId}, version ${doc.parserVersion}`,
            },
          ]
        : []),
      { label: "Imported", text: s.importedAt.slice(0, 10) },
      {
        label: "Status",
        text:
          s.status === "COMMITTED"
            ? "Committed: it counts in every figure"
            : s.status === "DISCREPANT"
              ? "Held out: it doesn't tie, and wasn't committed"
              : "Awaiting commit on Statements → Documents",
        tone: s.status === "COMMITTED" ? "good" : "warn",
      },
    ],
  });

  const { checks, withheld } = checksFor(
    book,
    {
      affects: "NET_WORTH",
      from: s.periodStart,
      to: s.periodEnd,
      accountIds: [s.accountId],
    },
    STATEMENT_CHECKS,
  );
  const partsCents = p.openingCents + rowsCents + (investment ? p.growthCents + p.feesCents : 0) + s.deltaCents;
  const parts = [
    `The printed opening of ${money(p.openingCents)}`,
    `the ${rows.length} row${rows.length === 1 ? "" : "s"} read off it (${money(rowsCents)})`,
    ...(investment ? [`${p.feesCents ? "market change and fees" : "market change"} (${money(p.growthCents + p.feesCents)})`] : []),
    ...(s.deltaCents ? [`the unexplained gap (${money(s.deltaCents)})`] : []),
  ];
  return {
    report: "statement",
    descriptor: d,
    describes: `${name} statement, ${s.periodStart} – ${s.periodEnd}`,
    figure: { cents: p.closingCents },
    selfCheck: counted
      ? {
          ok: partsCents === p.closingCents,
          deltaCents: partsCents - p.closingCents,
          explain: `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)} come to ${money(partsCents)}`,
        }
      : null,
    withheld,
    blocks,
    checks,
    estimates: counted
      ? estimatesFor(book, {
          rowIds: new Set(rows.map((r) => r.id)),
          from: s.periodStart,
          to: s.periodEnd,
          accountIds: [s.accountId],
        })
      : [],
    through: s.periodEnd,
    today: book.today,
  };
}

/** Words for days between two statements that aren't back to back. */
function dayGap(end: string, start: string): string {
  const days = Math.round((Date.parse(start) - Date.parse(end)) / 86_400_000) - 1;
  return days > 0 ? ` (${days} day${days === 1 ? "" : "s"} between them)` : "";
}

export const statementKind: ProofKind<StatementDescriptor> = {
  report: "statement",
  parse: parseStatementDescriptor,
  build: ({ book }, d) => buildStatementProof(book, d),
};
