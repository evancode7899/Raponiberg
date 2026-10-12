import type { Prisma, PrismaClient } from "@prisma/client";
import type { Lane } from "../classifier/taxonomy.ts";
import { CLASSIFIER_HOUSEHOLD_SETTING, CLASSIFIER_VERSION_SETTING } from "../classifier/version.ts";
import { householdPatterns } from "../household/householdFile.ts";
import type { HouseholdPatterns } from "../household/patterns.ts";
import { payrollCodeOf, type PayStubFacts, type PayStubSource, type StubLineKind } from "../ingest/payroll/types.ts";
import type { BrokerageFacts, HoldingsFacts } from "../ingest/types.ts";
import { groupFor, loadLedger, type AccountGroup, type Ledger } from "../ledger/loadLedger.ts";
import { loadTaxProfile, type TaxPerson, type TaxProfile } from "../tax/profile.ts";
import { readTaxDocs } from "../taxdocs/store.ts";
import type { TaxDocsFile } from "../taxdocs/types.ts";
import { readDecisions, type DecisionsFile } from "../transfers/decisionStore.ts";
import { billAccountIds, transferDifferenceAdjustments } from "../ledger/transferFees.ts";
import { bookedOn } from "./booking.ts";
import { readExceptions } from "./exceptionStore.ts";
import { applyIdleWindows, type IdleReport } from "./idleCards.ts";
import { addDays, localToday, startOfMonth } from "../dates/isoDate.ts";
import { findingStart } from "./checks/collector.ts";
import { runChecks } from "./checks/index.ts";
import type { IntegrityReport } from "./types.ts";

type Db = PrismaClient | Prisma.TransactionClient;

export type BookAccount = {
  id: string;
  name: string;
  institution: string | null;
  type: string;
  subtype: string | null;
  group: AccountGroup;
  /** Every identifier the institution has used for the account. */
  identifiers: string[];
};

export type BookStatement = {
  id: string;
  accountId: string;
  documentId: string;
  documentTitle: string;
  /** When its document was imported (ISO timestamp). */
  importedAt: string;
  status: "PENDING_REVIEW" | "COMMITTED" | "DISCREPANT";
  isSummary: boolean;
  periodStart: string;
  periodEnd: string;
  deltaCents: number;
};

/** A committed, non-summary ledger row. */
export type BookRow = {
  id: string;
  /** The date the statement prints. */
  date: string;
  /**
   * How the ledger books it: EXACT on `bookedOn`, or PERIOD: the statement gave only a
   * period total (spread across `statement`).
   */
  precision: "EXACT" | "PERIOD";
  /** The period of the statement the row came from. */
  statement: { start: string; end: string };
  /**
   * The day the ledger books the row on: `date` clamped into `statement` (see
   * booking.ts); a landlord's bill row on its own day, its payments on the bank's
   * (ledger/billBooking.ts). Figures that bucket rows by period use it, so they agree
   * with net worth.
   */
  bookedOn: string;
  /** A landlord's bill charge dated after the last bill on file: not in the ledger (or any figure) until a bill covers its day. */
  pending?: true;
  /** A further piece of a bill payment made by more than one bank payment, booked on its own day; the row it's part of. */
  partOf?: string;
  amountCents: number;
  lane: Lane;
  accountId: string;
  payee: string;
  /** The statement's second line for the row, when it prints one (Amex: the merchant's category or phone). */
  detail?: string | null;
  merchantKey: string | null;
  category: string;
  categoryGroup: string | null;
  counterpartyKind: string | null;
  counterpartyInstitution: string | null;
  /** Digits of the other account when the description names it. */
  counterpartyAccountHint: string | null;
  /** Which classifier rule decided ("untracked-card:...", USER, MATCH...). */
  classifiedBy: string | null;
  transferMatchId: string | null;
};

export type BookStub = PayStubFacts & {
  id: string;
  documentId: string;
  documentTitle: string;
  /** When its document was imported (ISO timestamp). */
  importedAt: string;
  employerKey: string;
  /** Household member the stub belongs to (tax profile name rules), or null. */
  personId: string | null;
  depositTransactionId: string | null;
};

export type BookBrokerage = BrokerageFacts & { id: string; documentId: string; institution: string };

/** Positions an investment statement listed at its period end (see ingest/holdings). */
export type BookHoldings = HoldingsFacts & {
  id: string;
  documentId: string;
  institution: string;
  /** Ledger account the snapshot belongs to (by institution and account number), or null. */
  accountId: string | null;
  totalCents: number;
};

/** A stored source document, with the code versions that read it. */
export type BookDocument = {
  id: string;
  title: string;
  institution: string;
  parserId: string;
  parserVersion: number;
  /** Version of the pay stub / brokerage fact extraction stored for it. */
  factsVersion: number;
  periodStart: string | null;
  periodEnd: string | null;
};

export type BookTransferMatch = {
  id: string;
  status: string;
  differenceCents: number;
  legs: { transactionId: string; accountId: string; date: string; amountCents: number }[];
};

export type Book = {
  today: string;
  /**
   * The last day each kind of figure is complete through: every open account involved
   * has a statement covering it. Figures past these dates aren't produced. `netWorth` is
   * also the data edge (every open account is on file through it); cash flow stops at
   * the last whole month before any open finding past the edge (see cashFlowThrough).
   */
  horizon: { cashFlow: string; netWorth: string };
  ledger: Ledger;
  accounts: BookAccount[];
  statements: BookStatement[];
  rows: BookRow[];
  rowById: Map<string, BookRow>;
  stubs: BookStub[];
  brokerage: BookBrokerage[];
  /** Holdings snapshots, oldest first. */
  holdings: BookHoldings[];
  matches: BookTransferMatch[];
  documents: BookDocument[];
  /** The owner's saved transfer decisions (transfers/decisionStore.ts), or why the file can't be read. */
  decisions: DecisionsFile | { error: string };
  /** The classification rules version the rows were last filed with (null: never recorded). */
  classifiedWith: number | null;
  /** The household file (lib/household) as it is now: local merchants for rent detection, tax-year caveats. */
  household: HouseholdPatterns;
  /** The household file's fingerprint when the rows were last filed (null: never recorded). */
  classifiedWithHousehold: string | null;
  taxProfile: TaxProfile;
  /** The tax documents folder as last scanned (lib/taxdocs): filed returns, W-2s, 1099s, K-1s. Null before the first scan. */
  taxDocs: TaxDocsFile | null;
  persons: TaxPerson[];
  /** Card cycles with no statement because nothing happened, proven from the bank side (filled into the ledger at $0). */
  idle: IdleReport;
  integrity: IntegrityReport;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** A committed, non-summary ledger row as the Book's query returns it. */
type RawRow = {
  id: string;
  date: Date;
  datePrecision: string;
  periodStart: Date;
  periodEnd: Date;
  amountCents: number;
  lane: string | null;
  accountId: string;
  payee: string | null;
  detail: string | null;
  merchantKey: string | null;
  counterpartyKind: string | null;
  counterpartyInstitution: string | null;
  counterpartyAccountHint: string | null;
  classifiedBy: string | null;
  categoryName: string | null;
  categoryGroup: string | null;
  matchId: string | null;
};

/**
 * Loads the whole Book and runs every integrity check over it. The one entry point for
 * figures: modules take a Book, never the database.
 */
export async function loadBook(db: Db, opts: { today?: string; exceptionsFile?: string; decisionsFile?: string } = {}): Promise<Book> {
  const today = opts.today ?? localToday();
  // Read first: a damaged exceptions file stops the Book rather than silently dropping them.
  const exceptions = readExceptions(opts.exceptionsFile);
  // A damaged decisions file is reported as a finding (transfer.decisions), which withholds every figure it could touch.
  let decisions: Book["decisions"];
  try {
    decisions = readDecisions(opts.decisionsFile);
  } catch (e) {
    decisions = { error: e instanceof Error ? e.message : String(e) };
  }
  const household = householdPatterns();
  const [ledger, accounts, imports, rows, stubs, brokerage, holdings, matches, taxProfile, documents, classifiedWith, classifiedWithHousehold] = await Promise.all([
    loadLedger(db, { today }),
    db.account.findMany({ where: { archivedAt: null }, include: { aliases: { select: { identifier: true } } } }),
    db.statementImport.findMany({
      select: {
        id: true,
        accountId: true,
        documentId: true,
        status: true,
        isSummary: true,
        periodStart: true,
        periodEnd: true,
        reconciliationDeltaCents: true,
        document: { select: { title: true, originalFileName: true, createdAt: true } },
      },
    }),
    // One join rather than findMany with nested selects: same rows, about 7x faster
    // (Prisma's per-row relation handling was most of the Book's load time).
    db.$queryRaw<RawRow[]>`
      SELECT t.id, t.date, t.datePrecision, s.periodStart, s.periodEnd, t.amountCents, t.lane, t.accountId, t.payee, t.detail,
             t.merchantKey, t.counterpartyKind, t.counterpartyInstitution, t.counterpartyAccountHint, t.classifiedBy,
             c.name AS categoryName, c.groupName AS categoryGroup, l.matchId
      FROM "Transaction" t
      JOIN "StatementImport" s ON s.id = t.statementImportId
      JOIN "Account" a ON a.id = t.accountId
      LEFT JOIN "Category" c ON c.id = t.categoryId
      LEFT JOIN "TransferLeg" l ON l.transactionId = t.id
      WHERE s.status = 'COMMITTED' AND s.isSummary = 0 AND a.archivedAt IS NULL
      ORDER BY t.date ASC, t.id ASC`,
    db.payStub.findMany({
      orderBy: [{ payDate: "asc" }, { netYtdCents: "asc" }],
      include: { lines: { orderBy: { position: "asc" } }, document: { select: { title: true, originalFileName: true, createdAt: true } } },
    }),
    db.brokerageTaxFacts.findMany({ orderBy: { periodEnd: "asc" }, include: { document: { select: { institution: true } } } }),
    db.holdingSnapshot.findMany({ orderBy: { asOf: "asc" }, include: { document: { select: { institution: true } } } }),
    db.transferMatch.findMany({
      select: {
        id: true,
        status: true,
        differenceCents: true,
        legs: { select: { transaction: { select: { id: true, accountId: true, date: true, amountCents: true } } } },
      },
    }),
    loadTaxProfile(db),
    db.sourceDocument.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, title: true, originalFileName: true, institution: true, parserId: true, parserVersion: true, factsVersion: true, periodStart: true, periodEnd: true },
    }),
    db.appSetting.findUnique({ where: { key: CLASSIFIER_VERSION_SETTING } }).then((s) => (s && Number.isFinite(Number(s.value)) ? Number(s.value) : null)),
    db.appSetting.findUnique({ where: { key: CLASSIFIER_HOUSEHOLD_SETTING } }).then((s) => s?.value ?? null),
  ]);

  const persons = taxProfile.persons;
  const personFor = (employee: string) => {
    const u = employee.toUpperCase();
    return persons.find((p) => p.match.some((m) => u.includes(m)))?.id ?? null;
  };
  const bookRows: BookRow[] = rows.flatMap((r) => {
    const date = iso(r.date);
    const statement = { start: iso(r.periodStart), end: iso(r.periodEnd) };
    const row: BookRow = {
      id: r.id,
      date,
      precision: r.datePrecision === "PERIOD" ? ("PERIOD" as const) : ("EXACT" as const),
      statement,
      bookedOn: bookedOn({ date, statement }),
      amountCents: r.amountCents,
      lane: (r.lane ?? "EXPENSE") as Lane,
      accountId: r.accountId,
      payee: r.payee ?? "",
      detail: r.detail,
      merchantKey: r.merchantKey,
      category: r.categoryName ?? "Uncategorized",
      categoryGroup: r.categoryGroup ?? null,
      counterpartyKind: r.counterpartyKind,
      counterpartyInstitution: r.counterpartyInstitution,
      counterpartyAccountHint: r.counterpartyAccountHint,
      classifiedBy: r.classifiedBy,
      transferMatchId: r.matchId ?? null,
    };
    // A landlord's bill row books where the ledger does (billBooking.ts).
    const bill = ledger.billRows?.get(r.id);
    if (!bill) return [row];
    if (bill.pending) return [{ ...row, precision: "EXACT", bookedOn: date, pending: true }];
    const [first, ...more] = bill.parts;
    const rest = more.reduce((s, p) => s + p.amountCents, 0);
    return [
      { ...row, precision: "EXACT", bookedOn: first!.date, amountCents: r.amountCents - rest },
      ...more.map((p, i): BookRow => ({ ...row, id: `${r.id}:part${i + 2}`, partOf: r.id, precision: "EXACT", bookedOn: p.date, amountCents: p.amountCents })),
    ];
  });
  const bookMatches: BookTransferMatch[] = matches.map((m) => ({
    id: m.id,
    status: m.status,
    differenceCents: m.differenceCents,
    legs: m.legs.map((l) => ({ transactionId: l.transaction.id, accountId: l.transaction.accountId, date: iso(l.transaction.date), amountCents: l.transaction.amountCents })),
  }));
  // A bill's payments that differ from what the bank paid (confirmed by the owner): the
  // landlord changed the bill without itemizing it. The ledger books the difference as
  // spending on the bill (transferFees.ts), so it's a row of its own here too.
  const bills = billAccountIds(accounts);
  const corrections = transferDifferenceAdjustments(
    bookMatches.filter((m) => m.status === "CONFIRMED").map((m) => ({ differenceCents: m.differenceCents, legs: m.legs.map((l) => ({ id: l.transactionId, amountCents: l.amountCents, accountId: l.accountId })) })),
    bills,
  );
  for (const [id, cents] of corrections) {
    const leg = bookRows.find((r) => r.id === id);
    if (!leg || !bills.has(leg.accountId)) continue;
    const booked = ledger.billRows?.get(id);
    bookRows.push({
      ...leg,
      ...(booked && !booked.pending && booked.correction ? { precision: "EXACT" as const, bookedOn: booked.correction.date } : {}),
      id: `${id}:correction`,
      amountCents: cents,
      lane: "EXPENSE",
      payee: "Bill changed without an itemized line",
      merchantKey: null,
      category: "Housing & utilities",
      categoryGroup: "Essentials",
      counterpartyKind: "MERCHANT",
      counterpartyInstitution: null,
      counterpartyAccountHint: null,
      classifiedBy: "bill-correction",
      transferMatchId: null,
    });
  }
  if (corrections.size || bookRows.some((r) => r.partOf)) bookRows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Months a card issuer sent no statement for because nothing happened: $0, covered.
  const idle = applyIdleWindows(ledger, bookRows, bookMatches, today, new Map(accounts.map((a) => [a.id, a.aliases.map((x) => x.identifier)])));

  const lastDayOf = (pick: (a: Ledger["accounts"][number]) => boolean) =>
    ledger.accounts.filter((a) => !a.closed && pick(a)).map((a) => a.timeline.lastDay!).sort()[0] ?? today;
  const book: Book = {
    today,
    horizon: {
      cashFlow: lastDayOf((a) => a.group === "Cash" || a.group === "Credit cards"),
      netWorth: lastDayOf(() => true),
    },
    ledger,
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      institution: a.institution,
      type: a.type,
      subtype: a.subtype,
      group: groupFor(a.subtype, a.type),
      identifiers: a.aliases.map((x) => x.identifier),
    })),
    statements: imports.map((s) => ({
      id: s.id,
      accountId: s.accountId,
      documentId: s.documentId,
      documentTitle: s.document.originalFileName ?? s.document.title,
      importedAt: s.document.createdAt.toISOString(),
      status: s.status,
      isSummary: s.isSummary,
      periodStart: iso(s.periodStart),
      periodEnd: iso(s.periodEnd),
      deltaCents: s.reconciliationDeltaCents,
    })),
    rows: bookRows,
    rowById: new Map(bookRows.map((r) => [r.id, r])),
    stubs: stubs.map((s) => ({
      id: s.id,
      documentId: s.documentId,
      documentTitle: s.document.originalFileName ?? s.document.title,
      importedAt: s.document.createdAt.toISOString(),
      source: s.source as PayStubSource,
      employee: s.employee,
      // A second payroll company under one employer name is labelled with its code.
      employer: payrollCodeOf(s.employerKey) ? `${s.employer} · payroll ${payrollCodeOf(s.employerKey)}` : s.employer,
      payrollCode: payrollCodeOf(s.employerKey),
      employerKey: s.employerKey,
      personId: personFor(s.employee),
      payDate: iso(s.payDate),
      periodStart: s.periodStart ? iso(s.periodStart) : null,
      periodEnd: s.periodEnd ? iso(s.periodEnd) : null,
      federalFilingStatus: s.federalFilingStatus,
      lines: s.lines.map((l) => ({ name: l.name, kind: l.kind as StubLineKind, current: l.currentCents, ytd: l.ytdCents })),
      printed: {
        grossCurrent: s.grossCurrentCents,
        grossYtd: s.grossYtdCents,
        withheldCurrent: s.withheldCurrentCents,
        withheldYtd: s.withheldYtdCents,
        netCurrent: s.netPayCents,
        netYtd: s.netYtdCents,
      },
      deposits: (s.depositsJson ?? []) as PayStubFacts["deposits"],
      warnings: (s.warningsJson ?? []) as string[],
      depositTransactionId: s.depositTransactionId,
    })),
    brokerage: brokerage.map((b) => ({
      id: b.id,
      documentId: b.documentId,
      institution: b.document.institution,
      accountNumber: b.accountNumber,
      ownerLine: b.ownerLine,
      kind: b.kind as BrokerageFacts["kind"],
      periodStart: iso(b.periodStart),
      periodEnd: iso(b.periodEnd),
      isYearEnd: b.isYearEnd,
      isChet: b.isChet,
      endingValue: b.endingValueCents,
      contributionsYtd: b.contributionsYtdCents,
      income: (b.incomeJson ?? null) as BrokerageFacts["income"],
      realized: (b.realizedJson ?? null) as BrokerageFacts["realized"],
      incomeRows: b.incomeRowsJson as BrokerageFacts["incomeRows"],
      distributions: b.distributionsJson as BrokerageFacts["distributions"],
    })),
    holdings: holdings.map((h) => ({
      id: h.id,
      documentId: h.documentId,
      institution: h.document.institution,
      accountNumber: h.accountNumber,
      accountId: accounts.find((a) => a.institution === h.document.institution && a.aliases.some((x) => x.identifier === h.accountNumber))?.id ?? null,
      asOf: iso(h.asOf),
      positions: h.positionsJson as HoldingsFacts["positions"],
      totalCents: h.totalCents,
      printedTotalCents: h.printedTotalCents,
    })),
    matches: bookMatches,
    documents: documents.map((d) => ({
      id: d.id,
      title: d.originalFileName ?? d.title,
      institution: d.institution,
      parserId: d.parserId,
      parserVersion: d.parserVersion,
      factsVersion: d.factsVersion,
      periodStart: d.periodStart ? iso(d.periodStart) : null,
      periodEnd: d.periodEnd ? iso(d.periodEnd) : null,
    })),
    decisions,
    classifiedWith,
    household,
    classifiedWithHousehold,
    taxProfile,
    taxDocs: readTaxDocs(),
    persons,
    idle,
    integrity: { checks: [], findings: [], inferences: [], accepted: [], stale: [], retired: [] },
  };
  book.integrity = { ...runChecks(book, exceptions.exceptions), retired: exceptions.retired };
  book.horizon.cashFlow = cashFlowThrough(book);
  return book;
}

/**
 * Cash flow runs past the data edge (net worth's horizon) only while nothing is wrong
 * there: the first finding past the edge that touches cash flow — usually a statement
 * that hasn't arrived yet — pulls the horizon back to the last whole month before it
 * (never before the edge), so pages end tidily at the latest data that's complete.
 */
export function cashFlowThrough(book: Book): string {
  const { netWorth: edge, cashFlow } = book.horizon;
  const first = book.integrity.findings
    .filter((f) => f.atEdge && [f.scope, ...(f.extraScopes ?? [])].some((s) => s.affects.includes("CASH_FLOW")))
    .map(findingStart)
    .sort()[0];
  if (!first || first > cashFlow) return cashFlow;
  const monthBefore = addDays(startOfMonth(first), -1);
  return monthBefore > edge ? monthBefore : edge;
}
