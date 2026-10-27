import { formatPercentRatio, formatUsdFromCents } from "../../formatMoney.ts";
import { contributionKind, contributionTaxYear, withdrawalKind, type ExpenseView, type HsaReport } from "../../hsa/report.ts";
import { hsaAfterTax } from "../../hsa/strategy.ts";
import { decompose, valueAt } from "../../ledger/timeline.ts";
import { personPayYear } from "../pay.ts";
import type { Book, BookRow } from "../load.ts";
import type { CheckId } from "../types.ts";
import { checksFor, estimatesFor, perBook, sumCheck } from "./common.ts";
import type { ChainLine, Proof, ProofBlock, ProofCheck, ProofContext, ProofEstimate, ProofGroup, ProofKind, ProofLink } from "./types.ts";
import type { PayDescriptor } from "./payProof.ts";

/**
 * The proof behind a figure on the HSA page. Two kinds of figure live there:
 *
 *  - Book facts: the HSA's balance, who put money in (the HSA's statements, else the pay
 *    stubs) and what came out. These list the HSA statement rows behind them, grouped by
 *    statement, re-added on their own, with the integrity checks over those statements.
 *  - The receipts log (data/hsa-expenses.json): what the owner typed about bills paid out
 *    of pocket. Reimbursable, reimbursed and the growth from waiting add up the log's
 *    entries; they're the owner's word, not a statement's, so they're labelled that way
 *    and no integrity check covers them.
 *
 * Projections built on those (worth in the plan year) are chains whose inputs say where
 * each stands. The what-if comparisons (the three ways to pay a bill, the edge over
 * reimbursing now) are outputs of a slider and stay plain.
 *
 * The page's figures come from GET /api/hsa (lib/hsa/loadReport.ts); the proof reads the
 * same report, then re-derives each Book figure from the Book's own rows.
 */

export type HsaMetric =
  /** The HSA balance (every open HSA account). */
  | "balance"
  /** Money in for the year the funding split reads (part: employee / employer). */
  | "contributions"
  /** Money out of the HSA (part: distribution to you / direct payment to a provider). */
  | "distributions"
  /** Receipts log: unreimbursed and eligible. */
  | "reimbursable"
  /** Receipts log: the reimbursable ones with the receipt saved. */
  | "ready"
  /** Receipts log: marked reimbursed. */
  | "reimbursed"
  /** Receipts log: everything logged. */
  | "logged"
  /** Receipts log: estimated growth so far on what's still unreimbursed. */
  | "growth"
  /** Projection: today's reimbursable total, left invested to the plan year, after any tax. */
  | "future"
  /** Projection: the part of that which is growth. */
  | "future-growth";

export type HsaDescriptor = {
  report: "hsa";
  metric: HsaMetric;
  /** contributions: "employee" | "employer"; distributions: "distribution" | "direct" (required). */
  part?: "employee" | "employer" | "distribution" | "direct";
};

const METRICS: HsaMetric[] = ["balance", "contributions", "distributions", "reimbursable", "ready", "reimbursed", "logged", "growth", "future", "future-growth"];

/** The checks that can withhold a figure read off the HSA's statements. */
export const HSA_STATEMENT_CHECKS: CheckId[] = ["statement.held", "statement.chain", "statement.gap", "statement.history", "statement.overdue", "transfer.unmatched", "ledger.consistency", "ledger.freshness", "networth.reconciles"];

/** The checks over pay-stub HSA money. */
export const HSA_PAY_CHECKS: CheckId[] = ["contributions.hsa", "paystub.arithmetic", "paystub.person", "pay.continuity", "pay.year-gap"];

export function parseHsaDescriptor(d: Record<string, unknown>): HsaDescriptor | { error: string } {
  if (!METRICS.includes(d.metric as HsaMetric)) return { error: `metric must be one of: ${METRICS.join(", ")}.` };
  const metric = d.metric as HsaMetric;
  if (metric === "distributions") {
    if (d.part !== "distribution" && d.part !== "direct") return { error: "distributions needs part: distribution or direct." };
    return { report: "hsa", metric, part: d.part };
  }
  if (metric === "contributions") {
    if (d.part != null && d.part !== "employee" && d.part !== "employer") return { error: "contributions part must be employee or employer." };
    return { report: "hsa", metric, ...(d.part ? { part: d.part } : {}) };
  }
  if (d.part != null) return { error: `${metric} has no part.` };
  return { report: "hsa", metric };
}

const link = (label: string, descriptor: HsaDescriptor): ProofLink => ({ label, descriptor });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Rows grouped by the statement each was read from, largest first; `counted` in the figure's sign. */
function groupRows(book: Book, rows: { row: BookRow; counted: number }[]): ProofGroup[] {
  const statementById = new Map(book.statements.map((s) => [s.id, s]));
  const account = new Map(book.accounts.map((a) => [a.id, a]));
  const groups = new Map<string, ProofGroup>();
  for (const { row: r, counted } of rows) {
    let g = groups.get(r.statementImportId);
    if (!g) {
      const s = statementById.get(r.statementImportId);
      g = {
        statement: {
          id: r.statementImportId,
          account: account.get(r.accountId)?.name ?? "HSA",
          institution: account.get(r.accountId)?.institution ?? null,
          periodStart: s?.periodStart ?? r.statement.start,
          periodEnd: s?.periodEnd ?? r.statement.end,
          documentTitle: s?.documentTitle ?? "",
          status: s?.status ?? "COMMITTED",
        },
        subtotalCents: 0,
        rows: [],
      };
      groups.set(r.statementImportId, g);
    }
    g.subtotalCents += counted;
    g.rows.push({
      id: r.id,
      date: r.date,
      bookedOn: r.bookedOn,
      payee: r.payee,
      category: r.category,
      account: g.statement.account,
      amountCents: r.amountCents,
      countedCents: counted,
      share: 1,
      precision: r.precision,
    });
  }
  return [...groups.values()]
    .map((g) => ({ ...g, rows: g.rows.sort((a, b) => a.bookedOn.localeCompare(b.bookedOn)) }))
    .sort((a, b) => Math.abs(b.subtotalCents) - Math.abs(a.subtotalCents));
}

const total = (rows: { counted: number }[]) => rows.reduce((t, r) => t + r.counted, 0);
const span = (rows: { row: BookRow }[]) => {
  const ds = rows.map((r) => r.row.bookedOn).sort();
  return { from: ds[0] ?? null, to: ds.at(-1) ?? null };
};

type Built = Omit<Proof, "report" | "descriptor" | "today">;

const LANE_LABEL: Record<string, string> = {
  INCOME: "Interest and other income",
  EXPENSE: "Paid out",
  TRANSFER: "Moved to or from your other accounts",
  EXTERNAL_TRANSFER: "Moved to or from untracked money",
  CONTRIBUTION_EMPLOYEE: "Contributions from your pay",
  CONTRIBUTION_EMPLOYER: "Employer contributions",
  CONTRIBUTION_PERSONAL: "Contributions you made directly",
};

// ------------------------------------------------------------------ Book figures

function balanceProof(book: Book, r: HsaReport): Built {
  const figure = r.hsa.balanceCents;
  const open = book.ledger.accounts.filter((a) => a.group === "Health savings" && !a.closed);
  if (figure == null || !open.length)
    return {
      describes: "HSA balance",
      figure: { text: "No HSA statements" },
      selfCheck: null,
      withheld: false,
      blocks: [{ kind: "breakdown", title: "Nothing to prove", items: [], note: "No HSA statements are imported, so there's no balance to show." }],
      checks: [],
      estimates: [],
      through: book.horizon.netWorth,
    };
  const blocks: ProofBlock[] = [];
  const listed: { row: BookRow; counted: number }[] = [];
  let chainsCents = 0;
  let from = r.hsa.asOf ?? book.horizon.netWorth;
  const shown = new Map(r.hsa.accounts.map((a) => [a.name, a]));
  for (const a of open) {
    const asOf = shown.get(a.name)?.asOf ?? r.hsa.asOf ?? book.horizon.netWorth;
    // The statement the balance stands on: the latest one that starts on or before that day.
    const st = book.statements.filter((s) => s.accountId === a.id && !s.isSummary && s.periodStart <= asOf).sort((x, y) => x.periodStart.localeCompare(y.periodStart)).at(-1);
    if (!st) {
      const v = valueAt(a.timeline, asOf);
      chainsCents += v.cents;
      blocks.push({ kind: "chain", title: a.name, lines: [{ op: "=", label: `Balance on ${asOf}`, value: { cents: v.cents }, source: "estimate", note: "No statement covers this day." }] });
      continue;
    }
    if (st.periodStart < from) from = st.periodStart;
    const dec = decompose(a.timeline, st.periodStart, asOf);
    const lines: ChainLine[] = [{ label: `Opening balance on the ${st.periodStart} – ${st.periodEnd} statement`, value: { cents: dec.openingCents }, source: "proven" }];
    for (const [lane, cents] of Object.entries(dec.flowsByLane)) if (cents) lines.push({ op: "+", label: LANE_LABEL[lane] ?? lane, value: { cents }, source: "proven" });
    if (dec.growthCents) lines.push({ op: "+", label: "Investment growth (as the statement reports it)", value: { cents: dec.growthCents }, source: "proven" });
    if (dec.feesCents) lines.push({ op: "+", label: "Fees", value: { cents: dec.feesCents }, source: "proven" });
    if (dec.unexplainedCents) lines.push({ op: "+", label: "Change no statement explains", value: { cents: dec.unexplainedCents }, source: "estimate", note: "A gap in statements: the balance moved by this much with no rows to say why." });
    lines.push({ op: "=", label: `Balance on ${asOf}`, value: { cents: dec.closingCents }, source: "derived" });
    chainsCents += dec.openingCents + Object.values(dec.flowsByLane).reduce((t, v) => t + (v ?? 0), 0) + dec.growthCents + dec.feesCents + dec.unexplainedCents;
    blocks.push({ kind: "chain", title: open.length > 1 ? a.name : "How the balance is worked out", lines, note: st.documentTitle ? `Read from ${st.documentTitle}.` : undefined });
    for (const row of book.rows) if (row.accountId === a.id && row.bookedOn >= st.periodStart && row.bookedOn <= asOf) listed.push({ row, counted: row.amountCents });
  }
  if (listed.length)
    blocks.push({ kind: "rows", title: "The rows since that opening balance", figureCents: total(listed), groups: groupRows(book, listed), note: "Money in and out of the HSA on the statements the balance stands on." });
  const ids = open.map((a) => a.id);
  const to = r.hsa.asOf ?? book.horizon.netWorth;
  const { checks, withheld } = checksFor(book, { affects: "NET_WORTH", from, to, accountIds: ids }, HSA_STATEMENT_CHECKS);
  return {
    describes: `HSA balance${r.hsa.asOf ? `, as of ${r.hsa.asOf}` : ""}`,
    figure: { cents: figure },
    selfCheck: sumCheck(figure, chainsCents, `The ${plural(open.length, "account")} worked out below ${open.length === 1 ? "comes" : "come"} to ${formatUsdFromCents(chainsCents)}`),
    withheld,
    blocks,
    checks,
    estimates: estimatesFor(book, { rowIds: new Set(listed.map((x) => x.row.id)), from, to, accountIds: ids }),
    through: to,
  };
}

const isHsa = (book: Book) => {
  const ids = new Set(book.accounts.filter((a) => a.group === "Health savings").map((a) => a.id));
  return (id: string) => ids.has(id);
};

/** How your part came in: through payroll, or put in directly from your bank. */
const viaPayroll = (r: BookRow) => r.lane === "CONTRIBUTION_EMPLOYEE" || /PAYROLL/i.test(r.payee);

function contributionsProof(book: Book, r: HsaReport, part: "employee" | "employer" | undefined): Built {
  const f = r.growth.funding;
  const whose = part === "employee" ? "Your" : part === "employer" ? "Your employer's" : "All";
  const figure = part === "employee" ? f.employeeCents : part === "employer" ? f.employerCents : f.employeeCents + f.employerCents;
  const describes = `${whose} HSA contributions${f.year ? ` for ${f.year}` : ""}`;
  const parts = (): ProofBlock => ({
    kind: "breakdown",
    title: "Whose money",
    items: [
      { label: "From your pay", value: { cents: f.employeeCents }, link: link("your contributions", { report: "hsa", metric: "contributions", part: "employee" }) },
      { label: "From your employer", value: { cents: f.employerCents }, link: link("your employer's contributions", { report: "hsa", metric: "contributions", part: "employer" }) },
    ],
    note: `Your share: ${formatPercentRatio(f.employeeShare, 0)}.`,
  });

  if (f.source === "STATEMENTS") {
    const hsa = isHsa(book);
    const want = part === "employee" ? "EMPLOYEE" : part === "employer" ? "EMPLOYER" : null;
    const rows = book.rows
      .filter((x) => x.amountCents > 0 && hsa(x.accountId) && contributionTaxYear(x) === f.year && (want ? contributionKind(x) === want : contributionKind(x) != null))
      .map((row) => ({ row, counted: row.amountCents }));
    const blocks: ProofBlock[] = [];
    if (!part) blocks.push(parts());
    if (part !== "employer") {
      const mine = rows.filter((x) => contributionKind(x.row) === "EMPLOYEE");
      const payroll = total(mine.filter((x) => viaPayroll(x.row)));
      if (mine.length)
        blocks.push({
          kind: "breakdown",
          title: "Your part, by how it came in",
          items: [
            { label: "Through payroll", value: { cents: payroll } },
            { label: "Put in directly", value: { cents: total(mine) - payroll } },
          ],
          note: "Payroll: the statement files it as a payroll contribution. Directly: any other deposit the statement calls a contribution.",
        });
    }
    blocks.push({ kind: "rows", title: "How it adds up", figureCents: total(rows), groups: groupRows(book, rows), note: `Deposits on the HSA's statements counted for ${f.year} (a deposit marked "for ${f.year}" counts there even if it landed later).` });
    const { from, to } = span(rows);
    const q = { affects: "NET_WORTH" as const, from: from ?? `${f.year}-01-01`, to: to ?? `${f.year}-12-31`, accountIds: book.accounts.filter((a) => hsa(a.id)).map((a) => a.id) };
    const { checks, withheld } = checksFor(book, q, HSA_STATEMENT_CHECKS);
    return {
      describes: `${describes}, from the HSA's statements`,
      figure: { cents: figure },
      selfCheck: sumCheck(figure, total(rows), `The ${plural(rows.length, "deposit")} below add up to ${formatUsdFromCents(total(rows))}`),
      withheld,
      blocks,
      checks,
      estimates: estimatesFor(book, { rowIds: new Set(rows.map((x) => x.row.id)), from: q.from, to: q.to, accountIds: q.accountIds }),
      through: to ?? book.horizon.netWorth,
    };
  }

  if (f.source === "PAY_STUBS") {
    const year = f.year!;
    const items: { label: string; value: { cents: number }; sub?: string; link?: ProofLink }[] = [];
    // Each stub total opens the pay proof of exactly that line, that person and employer, year to date on that stub.
    const payLink = (personId: string, employerKey: string, through: string, line: "hsa" | "employer-hsa", label: string): ProofLink => ({
      label,
      descriptor: { report: "pay", basis: "ytd", personId, employerKeys: [employerKey], lines: [line], year, through } satisfies PayDescriptor,
    });
    for (const p of book.taxProfile.persons)
      for (const e of personPayYear(book, p.id, year).employers) {
        const sub = `${e.employer}, year to date on the ${e.lastPayDate} stub`;
        if (part !== "employer" && e.ytd.hsa)
          items.push({ label: `${p.name}: from pay`, value: { cents: e.ytd.hsa }, sub, link: payLink(p.id, e.employerKey, e.lastPayDate, "hsa", `${p.name}'s HSA from pay`) });
        if (part !== "employee" && e.ytd.employerHsa)
          items.push({ label: `${p.name}: from the employer`, value: { cents: e.ytd.employerHsa }, sub, link: payLink(p.id, e.employerKey, e.lastPayDate, "employer-hsa", `${p.name}'s employer HSA money`) });
      }
    const sum = items.reduce((t, i) => t + i.value.cents, 0);
    const { checks, withheld } = checksFor(book, { affects: "PAY", from: `${year}-01-01`, to: `${year}-12-31` }, HSA_PAY_CHECKS);
    return {
      describes: `${describes}, from the pay stubs`,
      figure: { cents: figure },
      selfCheck: sumCheck(figure, sum, `The ${plural(items.length, "stub total")} below add up to ${formatUsdFromCents(sum)}`),
      withheld,
      blocks: [
        ...(!part ? [parts()] : []),
        { kind: "breakdown", title: "From the pay stubs", items, note: "The HSA's statements don't say whose money each deposit is, so this reads the year's last pay stub from each employer." },
      ],
      checks,
      estimates: [],
      through: `${year}-12-31`,
    };
  }

  return {
    describes: "HSA contributions",
    figure: { cents: 0 },
    selfCheck: sumCheck(figure, 0, "No contribution found on the HSA's statements or pay stubs"),
    withheld: false,
    blocks: [{ kind: "breakdown", title: "Nothing found", items: [], note: "No HSA deposit says whose money it is and no pay stub shows HSA money, so the page assumes it's all yours." }],
    checks: [],
    estimates: [],
    through: book.horizon.netWorth,
  };
}

function distributionsProof(book: Book, r: HsaReport, part: "distribution" | "direct"): Built {
  const kind = part === "direct" ? "DIRECT" : "DISTRIBUTION";
  const figure = r.withdrawals.filter((w) => w.kind === kind).reduce((t, w) => t + w.amountCents, 0);
  const hsa = isHsa(book);
  const rows = book.rows.filter((x) => x.amountCents < 0 && hsa(x.accountId) && withdrawalKind(x) === kind).map((row) => ({ row, counted: -row.amountCents }));
  const { from, to } = span(rows);
  const accountIds = book.accounts.filter((a) => hsa(a.id)).map((a) => a.id);
  const q = { affects: "NET_WORTH" as const, from: from ?? book.ledger.firstDay ?? book.today, to: to ?? book.horizon.netWorth, accountIds };
  const { checks, withheld } = checksFor(book, q, HSA_STATEMENT_CHECKS);
  const tied = r.withdrawals.filter((w) => w.kind === kind && w.linkedIds.length).length;
  return {
    describes: part === "direct" ? "Paid straight from the HSA to providers" : "Distributions from the HSA to you",
    figure: { cents: figure },
    selfCheck: sumCheck(figure, total(rows), `The ${plural(rows.length, "row")} below add up to ${formatUsdFromCents(total(rows))}`),
    withheld,
    blocks: [
      {
        kind: "rows",
        title: "How it adds up",
        figureCents: total(rows),
        groups: groupRows(book, rows),
        note:
          part === "direct"
            ? "The HSA's card or bill pay paying a provider: nothing comes back to you, so these never reimburse a receipt."
            : `Money the HSA sent you. ${tied} of ${rows.length} ${rows.length === 1 ? "is" : "are"} tied to receipts in your log.`,
      },
    ],
    checks,
    estimates: estimatesFor(book, { rowIds: new Set(rows.map((x) => x.row.id)), from: q.from, to: q.to, accountIds }),
    through: to ?? book.horizon.netWorth,
  };
}

// ------------------------------------------------------------------ receipts log

const LOG_NOTE = "These come from your receipts log (data/hsa-expenses.json): what you typed about each bill, not a line on a statement. No integrity check covers the log.";

const eligibleOpen = (e: ExpenseView) => !e.reimbursement && !e.flags.includes("BEFORE_OPEN") && !e.flags.includes("NOT_MEDICAL");

function receiptsProof(book: Book, r: HsaReport, metric: "reimbursable" | "ready" | "reimbursed" | "logged" | "growth"): Built {
  const pick: Record<typeof metric, (e: ExpenseView) => boolean> = {
    reimbursable: eligibleOpen,
    ready: (e) => eligibleOpen(e) && e.hasReceipt,
    reimbursed: (e) => e.reimbursement != null,
    logged: () => true,
    growth: eligibleOpen,
  };
  const figure = { reimbursable: r.totals.unreimbursedCents, ready: r.totals.readyCents, reimbursed: r.totals.reimbursedCents, logged: r.totals.loggedCents, growth: r.totals.growthCents }[metric];
  const value = (e: ExpenseView) => (metric === "growth" ? e.growthCents : e.amountCents);
  const mine = [...r.expenses].filter(pick[metric]).sort((a, b) => a.date.localeCompare(b.date));
  const sum = mine.reduce((t, e) => t + value(e), 0);
  const items = mine.map((e) => ({
    label: e.provider || "Unnamed provider",
    sub: [
      e.date,
      e.patient || "unassigned",
      metric === "growth" ? `${formatUsdFromCents(e.amountCents)} waiting ${e.daysWaiting} days` : null,
      e.reimbursement ? `reimbursed${e.reimbursement.date ? ` ${e.reimbursement.date}` : ""}` : e.hasReceipt ? "receipt saved" : "no receipt",
      e.paid ? `paid by ${e.paid.account || "a card"} ${e.paid.date}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    value: { cents: value(e) },
  }));
  const blocks: ProofBlock[] = [{ kind: "breakdown", title: "From your receipts log", items, note: LOG_NOTE }];
  if (metric === "reimbursable" || metric === "growth") {
    const out = r.expenses.filter((e) => !e.reimbursement && !eligibleOpen(e));
    if (out.length)
      blocks.push({
        kind: "breakdown",
        title: "Logged but left out",
        items: out.map((e) => ({ label: e.provider || "Unnamed provider", sub: `${e.date} · ${e.flags.includes("BEFORE_OPEN") ? "before the HSA opened" : "doesn't look medical"}`, value: { cents: e.amountCents } })),
        note: "Unreimbursed, but not counted: paid before the HSA was opened, or the charge that paid it doesn't look like medical care.",
      });
  }
  // The card or bank charges that paid them, as the statements print them.
  const paid = mine.flatMap((e) => {
    const row = e.paid?.rowId ? book.rowById.get(e.paid.rowId) : undefined;
    return row ? [{ row, counted: -row.amountCents }] : [];
  });
  if (paid.length && metric !== "growth")
    blocks.push({
      kind: "rows",
      title: "The charges that paid them",
      figureCents: total(paid),
      groups: groupRows(book, paid),
      note: `${paid.length} of ${plural(mine.length, "receipt")} ${paid.length === 1 ? "is" : "are"} tied to a statement row; ${mine.length - paid.length ? "the rest are only in the log" : "every one is"}. Shown for reference: the figure is the log's amounts.`,
    });
  const estimates: ProofEstimate[] =
    metric === "growth"
      ? [
          {
            id: "hsa.growth-rate",
            title: `Grown at ${formatPercentRatio(r.growth.rate, 1)} a year`,
            detail:
              r.growth.rateSource === "MEASURED"
                ? "Your HSA's own return, measured from its statements. Each receipt's growth is its amount compounded at that rate for the days it has waited."
                : `${r.growth.rateSource === "SETTING" ? "Your setting" : r.growth.rateSource === "FORECAST" ? "The forecast's return, the one every page assumes" : "An assumed long-run return"}: each receipt's growth is its amount compounded at that rate for the days it has waited.`,
          },
        ]
      : [];
  const describes = {
    reimbursable: "Reimbursable today",
    ready: "Reimbursable today, with the receipt saved",
    reimbursed: "Reimbursed so far",
    logged: "Everything in the receipts log",
    growth: "Estimated growth from waiting",
  }[metric];
  const checks: ProofCheck[] = [];
  return {
    describes: `${describes} (receipts log)`,
    figure: { cents: figure },
    selfCheck: sumCheck(figure, sum, `The ${plural(mine.length, "receipt")} below add up to ${formatUsdFromCents(sum)}`),
    withheld: false,
    blocks,
    checks,
    estimates,
    through: r.today,
  };
}

// ------------------------------------------------------------------ projections

function futureProof(r: HsaReport, metric: "future" | "future-growth"): Built {
  const g = r.growth;
  const a = g.assumptions;
  const base = r.totals.unreimbursedCents;
  const factor = hsaAfterTax(a, g.years);
  const worth = Math.round(base * factor);
  const rateLine: ChainLine =
    g.rateSource === "MEASURED"
      ? { label: "Growth a year", value: { ratio: g.rate }, source: "proven", note: "Your HSA's return, measured from its statements, assumed to continue." }
      : { label: "Growth a year", value: { ratio: g.rate }, source: "assumption", note: g.rateSource === "SETTING" ? "Your setting." : g.rateSource === "FORECAST" ? "The forecast's return (Forecast page), the one every page assumes." : "An assumed long-run stock-market return." };
  const baseLine: ChainLine = {
    label: "Reimbursable today",
    value: { cents: base },
    source: "assumption",
    note: "From your receipts log, not statements.",
    link: link("reimbursable today", { report: "hsa", metric: "reimbursable" }),
  };
  if (metric === "future") {
    const lines: ChainLine[] = [
      baseLine,
      rateLine,
      { label: `Years to ${g.planYear}`, value: { text: String(g.years) }, source: "assumption", note: r.settings.planYear ? "Your plan year." : "Twenty years out, by default." },
      ...(a.growthCovered ? [] : [{ label: "Tax on the growth when taken out", value: { ratio: a.exitRate }, source: "assumption" as const, note: "No receipt left to cover it." }]),
      { op: "×", label: a.growthCovered ? "Growth over those years" : "Growth over those years, after that tax", value: { ratio: factor }, source: "derived", note: "What a dollar grows to: (1 + growth)^years." },
      { op: "=", label: `Worth in ${g.planYear}`, value: { cents: worth }, source: "derived" },
    ];
    return {
      describes: `Worth in ${g.planYear}: today's receipts left invested`,
      figure: { cents: g.futureValueCents },
      selfCheck: sumCheck(g.futureValueCents, worth, `Reimbursable today × the growth comes to ${formatUsdFromCents(worth)}`),
      withheld: g.withheld != null,
      blocks: [{ kind: "chain", title: "How it's worked out", lines, note: "A projection: what the receipts would be worth if left invested and taken out then." }],
      checks: [],
      estimates: [],
      through: r.today,
    };
  }
  const growth = g.futureValueCents - base;
  return {
    describes: `Growth by ${g.planYear} on today's receipts`,
    figure: { cents: growth },
    selfCheck: sumCheck(growth, worth - base, `Worth in ${g.planYear} less reimbursable today comes to ${formatUsdFromCents(worth - base)}`),
    withheld: g.withheld != null,
    blocks: [
      {
        kind: "chain",
        title: "How it's worked out",
        lines: [
          { label: `Worth in ${g.planYear}`, value: { cents: g.futureValueCents }, source: "derived", link: link(`worth in ${g.planYear}`, { report: "hsa", metric: "future" }) },
          { ...baseLine, op: "−" },
          { op: "=", label: "Growth", value: { cents: growth }, source: "derived" },
        ],
        note: "A projection, not a fact on a statement.",
      },
    ],
    checks: [],
    estimates: [],
    through: r.today,
  };
}

/** The proof behind an HSA-page figure, from the page's own report and the Book. Pure: tested on invented fixtures. */
export function buildHsaProof(book: Book, r: HsaReport, d: HsaDescriptor): Proof {
  const built =
    d.metric === "balance" ? balanceProof(book, r)
    : d.metric === "contributions" ? contributionsProof(book, r, d.part as "employee" | "employer" | undefined)
    : d.metric === "distributions" ? distributionsProof(book, r, d.part as "distribution" | "direct")
    : d.metric === "future" || d.metric === "future-growth" ? futureProof(r, d.metric)
    : receiptsProof(book, r, d.metric);
  return { report: "hsa", descriptor: d, today: r.today, ...built };
}

/** A kind reading the page's report through `load`; the app's reads GET /api/hsa's (tests pass their own). */
export function makeHsaKind(load: (ctx: ProofContext) => Promise<HsaReport>): ProofKind<HsaDescriptor> {
  return { report: "hsa", parse: parseHsaDescriptor, build: async (ctx, d) => buildHsaProof(ctx.book, await load(ctx), d) };
}

export const hsaKind = makeHsaKind((ctx) => perBook(ctx, "hsa-report", async () => (await import("../../hsa/loadReport.ts")).loadHsaReport(ctx.db)));
