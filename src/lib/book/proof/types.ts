import type { Prisma, PrismaClient } from "@prisma/client";
import type { Book } from "../load.ts";
import type { AcceptedFinding, CheckId, Finding } from "../types.ts";
import type { ProofDescriptor } from "./index.ts";

/**
 * The proof behind any figure, as blocks the one proof drawer knows how to draw. A kind
 * of proof (cash flow, net worth, pay, the forecast…) builds one of these from its
 * figure's recipe; it never needs drawer code of its own.
 *
 *  - rows: the ledger rows that add up to the figure, grouped by the statement each was
 *    read from (facts read off statements).
 *  - breakdown: the figure split into labelled parts (by month, by category, by account).
 *  - chain: how a derived figure is worked out, line by line, each line marked by where
 *    it stands: read off statements (proven), typed by the owner (assumption), set by tax
 *    law, or estimated. Projections (the forecast and everything built on it) are chains.
 *  - facts: words as a document prints them or as the app files them (a row's description
 *    and the rule that filed it, a statement's file and reader): labelled text that wraps.
 *
 * Any breakdown item, chain line or fact can link to another figure's proof, so a
 * forecast's starting balance opens the net-worth proof behind it. Rows and statements
 * that are the Book's own (rowId, importId) open the row's and the statement's proof:
 * the bottom of every chain, what the document itself prints.
 */

export type ProofLink = { label: string; descriptor: ProofDescriptor };

export type ProofRow = {
  id: string;
  /** The date the statement prints. */
  date: string;
  /** Where the ledger books it (date clamped into its statement). */
  bookedOn: string;
  /** Where the figure counts it, when that differs from bookedOn: rent in the month it pays for, a bill charge on its own day. */
  movedTo?: { date: string; why: "rent" | "bill" };
  payee: string;
  category: string;
  account: string;
  /** As the statement prints it (signed). */
  amountCents: number;
  /** The part of it that counts in this figure, in the figure's sign. Unrounded. */
  countedCents: number;
  /** 1 for an exact row; the fraction of a period total that falls in the figure's periods. */
  share: number;
  precision: "EXACT" | "PERIOD";
  /** A further piece of a bill payment split across bank payments. */
  piece?: boolean;
  /** The Book row it is (BookRow.id), when it is one: the drawer opens its row proof. Filled in centrally (proof/index.ts). */
  rowId?: string;
};

export type ProofStatement = {
  id: string;
  account: string;
  institution: string | null;
  periodStart: string;
  periodEnd: string;
  documentTitle: string;
  status: string;
  /** The Book statement it is (BookStatement.id), when it is one: the drawer opens its statement proof. Filled in centrally (proof/index.ts). */
  importId?: string;
};

export type ProofGroup = { statement: ProofStatement; subtotalCents: number; rows: ProofRow[] };

/** A value on a chain line or breakdown item: money, a ratio, or words (a date, a count). */
export type ProofValue = { cents: number } | { ratio: number } | { text: string };

export type ChainLine = {
  /** How the line combines with the ones before it ("=" closes a step). */
  op?: "+" | "−" | "×" | "÷" | "=";
  label: string;
  value: ProofValue;
  /** Where the line stands. */
  source: "proven" | "assumption" | "law" | "estimate" | "derived";
  note?: string;
  link?: ProofLink;
};

export type ProofBlock =
  | {
      kind: "rows";
      title: string;
      /** The figure this block's rows make up (the whole figure, or one part of a net). */
      figureCents: number;
      groups: ProofGroup[];
      note?: string;
    }
  | { kind: "breakdown"; title: string; items: { label: string; value: ProofValue; sub?: string; link?: ProofLink }[]; note?: string }
  | { kind: "chain"; title: string; lines: ChainLine[]; note?: string }
  | { kind: "facts"; title: string; items: ProofFact[]; note?: string };

/** One labelled fact: text as printed or filed, never a figure to add up. `tone` marks one that needs the owner (warn) or settles a question (good). */
export type ProofFact = { label: string; text: string; link?: ProofLink; tone?: "warn" | "good" };

export type ProofCheck = {
  id: CheckId;
  title: string;
  description: string;
  state: "passed" | "open" | "accepted" | "none";
  passed: number;
  /** What it passed on (capped; `passed` is the full count). */
  subjects: string[];
  open: Pick<Finding, "id" | "status" | "title" | "detail" | "fix">[];
  accepted: Pick<AcceptedFinding, "id" | "status" | "title" | "detail" | "note" | "acceptedAt">[];
};

export type ProofEstimate = { id: string; title: string; detail: string };

export type Proof = {
  report: ProofDescriptor["report"];
  descriptor: ProofDescriptor;
  /** Plain words: what the figure is. */
  describes: string;
  /** The figure itself, as the page shows it before any per-month split. */
  figure: ProofValue;
  /**
   * Whether the parts listed re-add to the figure on their own, and in plain words what
   * they came to ("The 62 rows below add up to $1,234.56"; the drawer adds whether that
   * is exactly the figure). Null when the figure isn't a sum (a date, a rate).
   */
  selfCheck: { ok: boolean; deltaCents: number; explain: string } | null;
  /** An open finding covers the figure: pages withhold it. */
  withheld: boolean;
  blocks: ProofBlock[];
  checks: ProofCheck[];
  estimates: ProofEstimate[];
  /** The last day the figure's data runs through. */
  through: string;
  today: string;
};

/** What a kind of proof is built from: the cached Book, and the database for settings it reads outside the Book. */
export type ProofContext = { book: Book; db: PrismaClient | Prisma.TransactionClient };

/**
 * One kind of proof. `parse` checks a request body already known to name this kind's
 * `report`; `build` re-derives the figure from the Book and proves it. Register it in
 * proof/index.ts (KINDS and the ProofDescriptor union).
 */
export type ProofKind<D extends { report: string }> = {
  report: D["report"];
  parse: (body: Record<string, unknown>) => D | { error: string };
  build: (ctx: ProofContext, d: D) => Proof | Promise<Proof>;
};
