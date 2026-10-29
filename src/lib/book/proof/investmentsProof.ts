import { sumPositions, type Holding } from "../../ingest/holdings/types.ts";
import { INVESTMENT_SETTINGS_KEY, normalizeInvestmentSettings, type InvestmentSettings } from "../../investments/settings.ts";
import { valueAt } from "../../ledger/timeline.ts";
import { formatUsdFromCents } from "../../formatMoney.ts";
import { loadJsonSetting } from "../../settingsStore.ts";
import type { Book, BookHoldings } from "../load.ts";
import { household } from "../householdView.ts";
import { holdingsByAccount, type AccountHoldings, type HoldingsStatus, type PositionRow } from "../reports/investments.ts";
import type { CheckId } from "../types.ts";
import { checksFor, estimatesFor } from "./common.ts";
import type { ChainLine, Proof, ProofBlock, ProofCheck, ProofKind } from "./types.ts";

/**
 * The proof behind an Investments figure: the household total (every account at the
 * proven-through date), one account's value, or one position in it. An account's value is
 * its balance on that date (what Net worth shows); its positions come
 * from the holdings that statement (or an older one) lists, re-added here on their own
 * and set against the total the statement prints and the balance on the same day.
 * Whatever the positions don't explain is the page's one balancing line, shown as such.
 */

export type InvestmentsDescriptor = {
  report: "investments";
  /** One account's value; omitted: the household total. */
  accountId?: string;
  /** One position in that account, by its security key (PositionRow.key). */
  position?: string;
  /** One line of that security when the statement lists it more than once (PositionRow.lot); omitted: every line of it. */
  lot?: number;
};

/** The checks that can withhold an account's value at the proven-through date. */
export const INVESTMENTS_CHECKS: CheckId[] = [
  "statement.held",
  "statement.chain",
  "statement.gap",
  "statement.history",
  "statement.overdue",
  "ledger.consistency",
  "ledger.freshness",
  "networth.reconciles",
];

export function parseInvestmentsDescriptor(d: Record<string, unknown>): InvestmentsDescriptor | { error: string } {
  if (d.accountId != null && (typeof d.accountId !== "string" || !d.accountId)) return { error: "accountId must be an account id." };
  if (d.position != null && (typeof d.position !== "string" || !d.position)) return { error: "position must be a security key." };
  if (d.position != null && d.accountId == null) return { error: "a position needs its accountId." };
  if (d.lot != null && (d.position == null || typeof d.lot !== "number" || !Number.isInteger(d.lot) || d.lot < 1)) return { error: "lot must be a line number (1, 2…) of a position." };
  return { report: "investments", ...(d.accountId ? { accountId: d.accountId as string } : {}), ...(d.position ? { position: d.position as string } : {}), ...(d.lot != null ? { lot: d.lot as number } : {}) };
}

const usd = formatUsdFromCents;
const STATUS_WORDS: Record<HoldingsStatus, string> = {
  TIES: "positions tie to the balance",
  STALE: "positions from an earlier statement",
  MISMATCH: "positions on file don't tie",
  NONE: "no positions on file",
};
const positionLabel = (p: Pick<Holding, "symbol" | "name">) => p.symbol ?? p.name;

type Ctx = { book: Book; accounts: AccountHoldings[]; positions: PositionRow[] };

/** Every check over one account's value on the proven-through date (the page's own blocker query). */
function accountChecks(book: Book, a: AccountHoldings) {
  return checksFor(book, { affects: "NET_WORTH", from: a.asOf, to: a.asOf, accountIds: [a.accountId] }, INVESTMENTS_CHECKS);
}

/** Check results merged into one list (each check once): the household total is withheld when any account's value is. */
function mergeChecks(parts: { checks: ProofCheck[]; withheld: boolean }[]): { checks: ProofCheck[]; withheld: boolean } {
  const ids = [...new Set(parts.flatMap((p) => p.checks.map((c) => c.id)))];
  const checks = ids.map((id): ProofCheck => {
    const mine = parts.flatMap((p) => p.checks.filter((c) => c.id === id));
    const open = [...new Map(mine.flatMap((c) => c.open).map((f) => [f.id, f])).values()];
    const accepted = [...new Map(mine.flatMap((c) => c.accepted).map((f) => [f.id, f])).values()];
    const passed = mine.reduce((t, c) => t + c.passed, 0);
    return {
      ...mine[0]!,
      state: open.length ? "open" : accepted.length ? "accepted" : passed ? "passed" : "none",
      passed,
      subjects: [...new Set(mine.flatMap((c) => c.subjects))].slice(0, 200),
      open,
      accepted,
    };
  });
  return { checks, withheld: parts.some((p) => p.withheld) };
}

/** Where the account's figures were read: the balance's statement and the holdings' statement. */
function readFrom(book: Book, a: AccountHoldings, snap: BookHoldings | null): ProofBlock {
  const balance = book.statements.find((s) => s.accountId === a.accountId && s.periodEnd === a.asOf && !s.isSummary) ?? book.statements.find((s) => s.accountId === a.accountId && s.periodEnd === a.asOf);
  const doc = snap ? book.documents.find((x) => x.id === snap.documentId) : undefined;
  const items: Extract<ProofBlock, { kind: "breakdown" }>["items"] = [
    { label: a.name, value: { text: a.treatment }, sub: a.institution ?? undefined },
    { label: balance?.documentTitle || "A statement", value: { text: `balance at ${a.asOf}` }, sub: balance ? `statement ${balance.periodStart} – ${balance.periodEnd}` : undefined },
  ];
  if (snap) items.push({ label: doc?.title || "A statement", value: { text: `positions at ${snap.asOf}` }, sub: doc?.periodStart ? `statement ${doc.periodStart} – ${doc.periodEnd ?? snap.asOf}` : undefined });
  return { kind: "breakdown", title: "Read from", items };
}

function accountProof({ book, positions }: Ctx, a: AccountHoldings, d: InvestmentsDescriptor): Proof {
  const snap = a.holdingsId ? (book.holdings.find((h) => h.id === a.holdingsId) ?? null) : null;
  const timeline = household(book).ledger.accounts.find((x) => x.id === a.accountId)!.timeline;
  const shown = positions.filter((p) => p.accountId === a.accountId);
  const held = shown.filter((p) => p.kind !== "ACCOUNT");
  const plug = shown.find((p) => p.kind === "ACCOUNT") ?? null;
  const blocks: ProofBlock[] = [readFrom(book, a, snap)];

  blocks.push({
    kind: "breakdown",
    title: held.length ? `Positions at ${held[0]!.asOf}` : "What the page shows",
    items: [
      ...held.map((p) => ({
        label: positionLabel(p),
        sub: p.symbol ? p.name : undefined,
        value: { cents: p.valueCents },
        link: { label: positionLabel(p), descriptor: { report: "investments" as const, accountId: a.accountId, position: p.key, ...(p.lot ? { lot: p.lot } : {}) } },
      })),
      ...(plug ? [{ label: plug.name, sub: held.length ? "the balance less the positions above" : "the statement's balance as one line", value: { cents: plug.valueCents } }] : []),
    ],
  });

  if (snap) {
    // The snapshot's own arithmetic: its positions re-added against the total it prints.
    const computed = sumPositions(snap.positions);
    const lines: ChainLine[] = [{ label: `${snap.positions.length} position${snap.positions.length === 1 ? "" : "s"} re-added`, value: { cents: computed }, source: "derived" }];
    if (snap.printedTotalCents != null) {
      lines.push({ label: "Total the statement prints", value: { cents: snap.printedTotalCents }, source: "proven" });
      lines.push({
        op: "=",
        label: "Difference",
        value: { cents: computed - snap.printedTotalCents },
        source: "derived",
        note: computed === snap.printedTotalCents ? undefined : `The positions come to ${usd(Math.abs(computed - snap.printedTotalCents))} ${computed > snap.printedTotalCents ? "more" : "less"} than the printed total.`,
      });
    } else lines.push({ label: "Total the statement prints", value: { text: "none printed" }, source: "proven" });
    if (a.status === "MISMATCH") {
      blocks.push({
        kind: "breakdown",
        title: `Positions on file at ${snap.asOf} (not used)`,
        items: snap.positions.map((p) => ({ label: positionLabel(p), sub: p.symbol ? p.name : undefined, value: { cents: p.valueCents } })),
        note: "These don't add up to the balance on the same day, so the page shows the account as one line instead.",
      });
    }
    blocks.push({ kind: "chain", title: "Printed total vs positions", lines });

    // Against the balance net worth uses, on the snapshot's day and (if later) the latest statement.
    const onSnap = valueAt(timeline, snap.asOf).cents;
    const vs: ChainLine[] = [
      { label: `Positions at ${snap.asOf}`, value: { cents: computed }, source: "derived" },
      { op: "−", label: `Net-worth balance at ${snap.asOf}`, value: { cents: onSnap }, source: "proven" },
      {
        op: "=",
        label: "Difference",
        value: { cents: computed - onSnap },
        source: "derived",
        note: computed === onSnap ? undefined : `The positions come to ${usd(Math.abs(computed - onSnap))} ${computed > onSnap ? "more" : "less"} than the balance: not used.`,
      },
    ];
    if (snap.asOf !== a.asOf && computed === onSnap)
      vs.push(
        { label: `Net-worth balance at ${a.asOf}`, value: { cents: a.valueCents }, source: "proven", note: "the proven-through date" },
        { op: "−", label: `Positions at ${snap.asOf}`, value: { cents: computed }, source: "derived" },
        { op: "=", label: plug?.name ?? "Change since holdings", value: { cents: a.valueCents - computed }, source: "derived" },
      );
    blocks.push({ kind: "chain", title: "Against the net-worth balance", lines: vs });
  } else {
    blocks.push({ kind: "chain", title: "Against the net-worth balance", lines: [{ label: `Balance at ${a.asOf}`, value: { cents: a.valueCents }, source: "proven", note: "No statement lists this account's positions." }] });
  }

  const parts = shown.reduce((t, p) => t + p.valueCents, 0);
  const heldCents = held.reduce((t, p) => t + p.valueCents, 0);
  const explain = held.length
    ? `The ${held.length} position${held.length === 1 ? "" : "s"} add up to ${usd(heldCents)}${plug ? `; with ${plug.name.toLowerCase()}, ${usd(parts)}` : ""}`
    : `One line for the whole account: ${usd(parts)}`;
  const { checks, withheld } = accountChecks(book, a);
  return {
    report: "investments",
    descriptor: d,
    describes: `${a.name}: value at ${a.asOf} (${STATUS_WORDS[a.status]})`,
    figure: { cents: a.valueCents },
    selfCheck: { ok: parts === a.valueCents, deltaCents: parts - a.valueCents, explain },
    withheld,
    blocks,
    checks,
    estimates: estimatesFor(book, { rowIds: new Set(), from: a.asOf, to: a.asOf, accountIds: [a.accountId] }),
    through: a.asOf,
    today: book.today,
  };
}

/** The earliest day a position's lines were listed (the holdings date), else the account's. */
const first0 = (mine: PositionRow[], a: AccountHoldings) => mine.map((p) => p.asOf).sort()[0] ?? a.asOf;

function positionProof({ book, positions }: Ctx, a: AccountHoldings, d: InvestmentsDescriptor & { position: string }): Proof {
  const mine = positions.filter((p) => p.accountId === a.accountId && p.key === d.position && p.kind !== "ACCOUNT" && (d.lot == null || p.lot === d.lot));
  const snap = a.holdingsId ? (book.holdings.find((h) => h.id === a.holdingsId) ?? null) : null;
  const figure = mine.reduce((t, p) => t + p.valueCents, 0);
  const blocks: ProofBlock[] = [readFrom(book, a, snap)];
  for (const p of mine) {
    const lines: ChainLine[] = [];
    if (p.quantity != null && p.price != null) {
      const priced = Math.round(p.quantity * p.price * 100);
      lines.push(
        { label: "Quantity", value: { text: p.quantity.toLocaleString("en-US", { maximumFractionDigits: 6 }) }, source: "proven" },
        { op: "×", label: "Price", value: { text: `$${p.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}` }, source: "proven" },
        { op: "=", label: "Quantity × price", value: { cents: priced }, source: "derived", note: priced === p.valueCents ? undefined : `${usd(Math.abs(priced - p.valueCents))} from the printed value: the statement rounds the price or quantity.` },
      );
    }
    lines.push({ label: "Value the statement prints", value: { cents: p.valueCents }, source: "proven" });
    if (p.costBasisCents != null)
      lines.push({ op: "−", label: "Cost basis", value: { cents: p.costBasisCents }, source: "proven" }, { op: "=", label: "Unrealized gain", value: { cents: p.unrealizedCents! }, source: "derived" });
    blocks.push({ kind: "chain", title: mine.length > 1 ? `${positionLabel(p)} · ${usd(p.valueCents)}` : `${positionLabel(p)} at ${p.asOf}`, lines });
  }
  blocks.push({
    kind: "breakdown",
    title: "Part of",
    items: [{ label: a.name, value: { cents: a.valueCents }, sub: `as of ${a.asOf}`, link: { label: a.name, descriptor: { report: "investments", accountId: a.accountId } } }],
  });
  // The positions themselves: a list that doesn't add up to the balance (holdings.ties) isn't used.
  const { checks, withheld } = mergeChecks([accountChecks(book, a), checksFor(book, { affects: "HOLDINGS", from: first0(mine, a), to: a.asOf, accountIds: [a.accountId] }, ["holdings.ties"])]);
  const first = mine[0];
  return {
    report: "investments",
    descriptor: d,
    describes: first ? `${positionLabel(first)} in ${a.name}, as listed at ${first.asOf}` : `A position no longer in ${a.name}`,
    figure: { cents: figure },
    selfCheck: mine.length > 1 ? { ok: true, deltaCents: 0, explain: `${mine.length} lines add up to ${usd(figure)}` } : null,
    withheld,
    blocks,
    checks,
    estimates: [],
    through: first?.asOf ?? a.asOf,
    today: book.today,
  };
}

function householdProof({ book, accounts, positions }: Ctx, d: InvestmentsDescriptor): Proof {
  const total = positions.reduce((t, p) => t + p.valueCents, 0);
  const parts = accounts.reduce((t, a) => t + a.valueCents, 0);
  const { checks, withheld } = mergeChecks(accounts.map((a) => accountChecks(book, a)));
  return {
    report: "investments",
    descriptor: d,
    describes: `Invested: every account at ${book.horizon.netWorth}`,
    figure: { cents: total },
    selfCheck: { ok: parts === total, deltaCents: parts - total, explain: `The ${accounts.length} account${accounts.length === 1 ? "" : "s"} below add up to ${usd(parts)}` },
    withheld,
    blocks: [
      {
        kind: "breakdown",
        title: "By account",
        items: [...accounts]
          .sort((x, y) => y.valueCents - x.valueCents)
          .map((a) => ({ label: a.name, sub: `as of ${a.asOf} · ${STATUS_WORDS[a.status]}`, value: { cents: a.valueCents }, link: { label: a.name, descriptor: { report: "investments" as const, accountId: a.accountId } } })),
        note: "Each account counts at its balance on the proven-through date, the same balance Net worth shows.",
      },
    ],
    checks,
    estimates: estimatesFor(book, { rowIds: new Set(), from: book.horizon.netWorth, to: book.horizon.netWorth, accountIds: accounts.map((x) => x.accountId) }),
    through: book.horizon.netWorth,
    today: book.today,
  };
}

/** The proof for a descriptor, given the investment settings (which accounts count: includeBankCash). */
export function buildInvestmentsProof(book: Book, settings: InvestmentSettings, d: InvestmentsDescriptor): Proof {
  const ctx: Ctx = { book, ...holdingsByAccount(book, settings) };
  if (!d.accountId) return householdProof(ctx, d);
  const a = ctx.accounts.find((x) => x.accountId === d.accountId);
  if (!a)
    return {
      report: "investments",
      descriptor: d,
      describes: "An account the Investments page doesn't show (closed, at $0, or not an investment account)",
      figure: { cents: 0 },
      selfCheck: null,
      withheld: false,
      blocks: [],
      checks: [],
      estimates: [],
      through: book.horizon.netWorth,
      today: book.today,
    };
  return d.position ? positionProof(ctx, a, { ...d, position: d.position }) : accountProof(ctx, a, d);
}

export const investmentsKind: ProofKind<InvestmentsDescriptor> = {
  report: "investments",
  parse: parseInvestmentsDescriptor,
  build: async ({ book, db }, d) => buildInvestmentsProof(book, await loadJsonSetting(db, INVESTMENT_SETTINGS_KEY, normalizeInvestmentSettings), d),
};
