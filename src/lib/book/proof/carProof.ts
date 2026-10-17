import { buildGarage, COST_LINES, interestSpan, LINE_INFO, lineOf, overlap, type CarReport, type CostItem, type CostLine, type GarageReport } from "../../car/report.ts";
import { CAR_KEY, CAR_KINDS, carName, KIND_INFO, normalizeGarage, ownedOn, SHARED, type Car, type CarEntry, type CarKind, type GarageSettings } from "../../car/settings.ts";
import { addDays, endOfMonth } from "../../dates/isoDate.ts";
import { formatUsdFromCents } from "../../formatMoney.ts";
import { loadJsonSetting } from "../../settingsStore.ts";
import type { Book, BookRow } from "../load.ts";
import { buildCashFlowProof, CASH_FLOW_CHECKS } from "./cashFlowProof.ts";
import { checksFor, estimatesFor, sumCheck } from "./common.ts";
import type { ChainLine, Proof, ProofBlock, ProofGroup, ProofKind, ProofLink } from "./types.ts";

/**
 * The proof behind a Car page figure. The page's engine (lib/car/report.ts) is re-run
 * from the Book's rows and the garage as stored, and the figure is re-added from the
 * cost items it is made of, each period and line rounded once as the report does.
 *
 * Statements are the only money: every statement row in the figure is listed under the
 * statement it was read from. A log entry matched to a row is only a hint about it (what
 * it was, the odometer, gallons), listed as such; a log entry with no statement row adds
 * nothing and is listed as not counted. What isn't on a statement is named for what it
 * is: an entry the owner said was paid outside the statements (their word), parking
 * typed in as part of the rent, financing interest typed from the loan, and depreciation
 * worked out from the typed purchase, plan and the odometer readings in the log.
 */

/** "toDate", "last12", a calendar year ("2025") or one month ("2025-03"), as the page shows them. */
export type CarSpan = string;

export type CarFigureDescriptor = {
  report: "car";
  carId: string;
  /** accrued: what the car used in the span (a premium spread over its months). cash: what was paid (to date only). */
  basis: "accrued" | "cash";
  span: CarSpan;
  /** One cost line (accrued) or kind (cash); every line when omitted. */
  line?: CostLine | CarKind | "INTEREST";
  /** The figure as a rate: per mile driven, or per month owned, in the span. */
  per?: "mile" | "month";
};

/** One line of the garage log (a counted cost at its full amount). */
export type CarItemDescriptor = { report: "car"; itemId: string };

export type CarDescriptor = CarFigureDescriptor | CarItemDescriptor;

const isSpan = (v: unknown): v is string => typeof v === "string" && (v === "toDate" || v === "last12" || /^\d{4}$/.test(v) || /^\d{4}-(0[1-9]|1[0-2])$/.test(v));
const CASH_LINES = [...CAR_KINDS, "INTEREST"] as const;

export function parseCarDescriptor(d: Record<string, unknown>): CarDescriptor | { error: string } {
  if (d.itemId != null) {
    if (typeof d.itemId !== "string" || !d.itemId || d.itemId.length > 200) return { error: "itemId must be a log line's id." };
    return { report: "car", itemId: d.itemId };
  }
  if (typeof d.carId !== "string" || !d.carId || d.carId.length > 40) return { error: "carId must be a car's id." };
  const basis = d.basis ?? "accrued";
  if (basis !== "accrued" && basis !== "cash") return { error: "basis must be accrued or cash." };
  if (!isSpan(d.span)) return { error: "span must be toDate, last12, a year (YYYY) or a month (YYYY-MM)." };
  if (basis === "cash" && d.span !== "toDate") return { error: "cash figures are to date only." };
  if (d.line != null && !(basis === "accrued" ? (COST_LINES as string[]) : (CASH_LINES as readonly string[])).includes(d.line as string)) return { error: `line must be one of: ${(basis === "accrued" ? COST_LINES : CASH_LINES).join(", ")}.` };
  if (d.per != null && d.per !== "mile" && d.per !== "month") return { error: "per must be mile or month." };
  if (d.per != null && basis === "cash") return { error: "cash figures have no rate." };
  return {
    report: "car",
    carId: d.carId,
    basis,
    span: d.span,
    ...(d.line != null ? { line: d.line as CarFigureDescriptor["line"] } : {}),
    ...(d.per != null ? { per: d.per as "mile" | "month" } : {}),
  };
}

const DAYS_PER_MONTH = 365.25 / 12;

/** One stretch the report rounds on its own: a month of the table, or the whole span ("to date": each item from its own start). */
type Period = { from: string | null; to: string; month: string | null };

function periodsOf(r: CarReport, span: string, purchaseDate: string | null): Period[] {
  if (span === "toDate") return [{ from: null, to: r.through, month: null }];
  if (span === "last12") return [{ from: r.last12.from, to: r.through, month: null }];
  return r.months
    .filter((m) => m.month.startsWith(span))
    .map((m) => {
      const start = `${m.month}-01`;
      return { from: purchaseDate && start < purchaseDate ? purchaseDate : start, to: endOfMonth(start) < r.through ? endOfMonth(start) : r.through, month: m.month };
    });
}

/** What an item puts in a period, unrounded, as the report counts it. */
function itemIn(it: CostItem, p: Period, end: string, basis: "accrued" | "cash"): number {
  if (basis === "cash") return it.date <= end ? it.cents : 0;
  if (p.from == null) return it.date > end ? 0 : overlap(it, it.start, end);
  return overlap(it, p.from, p.to);
}

/** The report's figure for one line in the span, as the page shows it. */
function shownFor(r: CarReport, span: string, line: CostLine): number {
  if (span === "toDate") return r.accrued[line];
  if (span === "last12") return r.last12.lines[line];
  return r.months.filter((m) => m.month.startsWith(span)).reduce((t, m) => t + m.lines[line], 0);
}

const spanLabel = (span: string, r: CarReport) =>
  span === "toDate" ? `to date (through ${r.through})` : span === "last12" ? `last 12 months (${r.last12.from} – ${r.through})` : span.length === 4 ? span : r.months.find((m) => m.month === span)?.label ?? span;

const lineLabel = (l: string) => (l in LINE_INFO ? LINE_INFO[l as CostLine].label : l === "INTEREST" ? "Financing interest" : KIND_INFO[l as CarKind].label);

type RowPart = { row: BookRow; cents: number; share: number; item: CostItem };

/** Rows grouped by the statement each was read from, largest first; each row's counted cents in the figure's sign (spent positive). */
function groupRows(book: Book, parts: RowPart[]): ProofGroup[] {
  const accountName = new Map(book.accounts.map((a) => [a.id, a.name]));
  const statementById = new Map(book.statements.map((s) => [s.id, s]));
  const byRow = new Map<string, RowPart>();
  for (const p of parts) {
    const cur = byRow.get(p.row.id);
    if (cur) {
      cur.cents += p.cents;
      cur.share += p.share;
    } else byRow.set(p.row.id, { ...p });
  }
  const groups = new Map<string, ProofGroup>();
  for (const { row: r, cents, share } of byRow.values()) {
    let g = groups.get(r.statementImportId);
    if (!g) {
      const s = statementById.get(r.statementImportId);
      g = {
        statement: {
          id: r.statementImportId,
          account: accountName.get(r.accountId) ?? "Account",
          institution: book.accounts.find((a) => a.id === r.accountId)?.institution ?? null,
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
    g.subtotalCents += cents;
    g.rows.push({ id: r.id, date: r.date, bookedOn: r.bookedOn, payee: r.payee, category: r.category, account: accountName.get(r.accountId) ?? "Account", amountCents: r.amountCents, countedCents: cents, share, precision: r.precision });
  }
  return [...groups.values()]
    .map((g) => ({ ...g, subtotalCents: Math.round(g.subtotalCents), rows: g.rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)) }))
    .sort((a, b) => Math.abs(b.subtotalCents) - Math.abs(a.subtotalCents));
}

/** Log entries as hints: what the log says about a row (never money). */
function hintText(e: CarEntry): string {
  const bits = [e.date, e.item || KIND_INFO[e.kind].label];
  if (e.odometer != null) bits.push(`${e.odometer.toLocaleString("en-US")} mi`);
  if (e.gallons != null) bits.push(`${e.gallons} gal`);
  if (e.note) bits.push(e.note);
  return bits.join(" · ");
}

type Ctx = { book: Book; settings: GarageSettings; garage: GarageReport };

function garageFor(book: Book, settings: GarageSettings): GarageReport {
  // As /api/car builds it: a log entry after the last day the statements are in for is awaiting its statement.
  return buildGarage(settings, book.rows, book.today, { statementsThrough: book.horizon.cashFlow });
}

/** The proof behind a Car page figure, from the Book and the garage as stored. */
export function buildCarProof(book: Book, settings: GarageSettings, d: CarDescriptor): Proof {
  const ctx: Ctx = { book, settings, garage: garageFor(book, settings) };
  return "itemId" in d ? itemProof(ctx, d) : d.per ? rateProof(ctx, d) : figureProof(ctx, d);
}

function carOf(ctx: Ctx, carId: string): { car: Car; r: CarReport } {
  const car = ctx.settings.cars.find((c) => c.id === carId);
  const r = ctx.garage.cars.find((c) => c.carId === carId);
  if (!car || !r) throw new Error("No car with that id in the garage.");
  return { car, r };
}

function figureProof(ctx: Ctx, d: CarFigureDescriptor): Proof {
  const { book, settings, garage } = ctx;
  const { car, r } = carOf(ctx, d.carId);
  const end = r.through;
  const periods = periodsOf(r, d.span, car.vehicle.purchaseDate);
  const chargeById = new Map(garage.statements.charges.map((c) => [c.rowId, c]));
  const entryById = new Map(settings.entries.map((e) => [e.id, e]));
  const interest = interestSpan(car);

  // Which lines (accrued) or kinds (cash) make the figure.
  type Key = CostLine | CarKind | "INTEREST";
  const keys: Key[] = d.line ? [d.line] : d.basis === "accrued" ? COST_LINES : [...CASH_LINES];
  const keyOf = (it: CostItem): Key | null => (d.basis === "accrued" ? lineOf(it.kind) : it.kind);

  // Re-add: each (period, line) is the unrounded sum of its parts, rounded once.
  const parts = { rows: 0, off: 0, rent: 0, interest: 0, depreciation: 0 };
  const rowParts: RowPart[] = [];
  const spreads = new Map<string, { item: CostItem; cents: number }>();
  const offItems = new Map<string, { item: CostItem; cents: number }>();
  const rentItems: { item: CostItem; cents: number }[] = [];
  let partsCents = 0;
  for (const p of periods) {
    for (const k of keys) {
      if (k === "DEPRECIATION") continue;
      let sum = 0;
      if (k === "INTEREST") {
        if (interest) {
          // Cash: the interest paid by the end (all of it once the loan's paid off).
          const c = d.basis === "cash" ? (interest.start <= end ? (interest.end <= addDays(end, 1) ? interest.cents : overlap(interest, interest.start, end)) : 0) : p.from == null ? (interest.start <= end ? overlap(interest, interest.start, end) : 0) : overlap(interest, p.from, p.to);
          sum += c;
          parts.interest += c;
        }
      } else
        for (const it of r.items) {
          if (keyOf(it) !== k) continue;
          const c = itemIn(it, p, end, d.basis);
          if (!c) continue;
          sum += c;
          if (it.source === "RENT") {
            parts.rent += c;
            rentItems.push({ item: it, cents: c });
          } else if (it.source === "OFF_STATEMENT") {
            parts.off += c;
            const cur = offItems.get(it.id) ?? { item: it, cents: 0 };
            cur.cents += c;
            offItems.set(it.id, cur);
          } else {
            parts.rows += c;
            // The item's rows, each its own share: a tax and its card fee, a shared policy split between the cars.
            const ways = it.splitWays ?? 1;
            const whole = it.rowIds.reduce((t, id) => t + (chargeById.get(id)?.cents ?? 0), 0) / ways;
            for (const id of it.rowIds) {
              const row = book.rowById.get(id);
              const ch = chargeById.get(id);
              if (!row || !ch) continue;
              const rowCents = ch.cents / ways;
              const cents = whole ? (c * rowCents) / whole : c / it.rowIds.length;
              rowParts.push({ row, cents, share: rowCents ? cents / ch.cents : 0, item: it });
            }
            if (Math.abs(c - it.cents) > 1e-9 || ways > 1) {
              const cur = spreads.get(it.id) ?? { item: it, cents: 0 };
              cur.cents += c;
              spreads.set(it.id, cur);
            }
          }
        }
      partsCents += Math.round(sum);
    }
    if (keys.includes("DEPRECIATION")) {
      const dep = p.month ? r.months.find((m) => m.month === p.month)!.lines.DEPRECIATION : d.span === "toDate" ? r.accrued.DEPRECIATION : r.last12.lines.DEPRECIATION;
      parts.depreciation += dep;
      partsCents += dep;
    }
  }

  // The figure as the page shows it.
  const figureCents =
    d.basis === "cash"
      ? keys.reduce((t, k) => t + (k === "INTEREST" ? r.cash.INTEREST : r.cash[k as CarKind]), 0)
      : (keys as CostLine[]).reduce((t, l) => t + shownFor(r, d.span, l), 0);

  const blocks: ProofBlock[] = [];
  const nonRow = [parts.off, parts.rent, parts.interest, parts.depreciation].filter((c) => Math.abs(c) >= 0.5).length;
  if (nonRow > 0)
    blocks.push({
      kind: "breakdown",
      title: "What it's made of",
      items: [
        ...(rowParts.length ? [{ label: "Statement rows", sub: "read off your statements", value: { cents: Math.round(parts.rows) } }] : []),
        ...(Math.abs(parts.off) >= 0.5 ? [{ label: "Paid outside the statements", sub: "your word: no statement row", value: { cents: Math.round(parts.off) } }] : []),
        ...(Math.abs(parts.rent) >= 0.5 ? [{ label: "Parking in the rent", sub: "typed: a monthly amount inside the rent", value: { cents: Math.round(parts.rent) } }] : []),
        ...(Math.abs(parts.interest) >= 0.5 ? [{ label: "Financing interest", sub: "typed: the loan's interest, spread from purchase to payoff", value: { cents: Math.round(parts.interest) } }] : []),
        ...(Math.abs(parts.depreciation) >= 0.5
          ? [{ label: "Depreciation", sub: "worked out from the typed purchase, plan and odometer readings", value: { cents: parts.depreciation }, link: d.line === "DEPRECIATION" ? undefined : link("Depreciation", { ...d, line: "DEPRECIATION" }) }]
          : []),
      ],
      note: periods.length > 1 ? "Each month is rounded once with all its parts, as the page adds them." : undefined,
    });

  if (!d.line) {
    const items = (keys as Key[])
      .map((k) => ({ k, cents: d.basis === "cash" ? (k === "INTEREST" ? r.cash.INTEREST : r.cash[k as CarKind]) : shownFor(r, d.span, k as CostLine) }))
      .filter((x) => x.cents !== 0)
      .sort((a, b) => b.cents - a.cents);
    if (items.length > 1) blocks.push({ kind: "breakdown", title: "By cost", items: items.map((x) => ({ label: lineLabel(x.k), value: { cents: x.cents }, link: link(lineLabel(x.k), { ...d, line: x.k }) })) });
  }

  if (d.basis === "accrued" && /^\d{4}$/.test(d.span) && periods.length > 1)
    blocks.push({
      kind: "breakdown",
      title: "By month",
      items: periods.map((p) => {
        const m = r.months.find((x) => x.month === p.month)!;
        return { label: m.label, value: { cents: (keys as CostLine[]).reduce((t, l) => t + m.lines[l], 0) }, link: link(m.label, { ...d, span: m.month }) };
      }),
    });
  if (d.basis === "accrued" && d.span === "toDate") {
    const years = [...new Set(r.months.map((m) => m.month.slice(0, 4)))];
    if (years.length > 1) {
      const items = years.map((y) => ({ label: y, value: { cents: (keys as CostLine[]).reduce((t, l) => t + shownFor(r, y, l), 0) }, link: link(y, { ...d, span: y }) }));
      const sum = items.reduce((t, i) => t + i.value.cents, 0);
      blocks.push({
        kind: "breakdown",
        title: "By year",
        items,
        note: sum !== figureCents ? `The years add up to ${formatUsdFromCents(sum)}: each month is rounded on its own, and the total to date counts each cost from its own first day.` : undefined,
      });
    }
  }

  if (d.line === "DEPRECIATION") blocks.push(depreciationChain(car, r, d, figureCents));

  const rowCount = new Set(rowParts.map((p) => p.row.id)).size;
  if (rowParts.length || !keys.every((k) => k === "DEPRECIATION" || k === "INTEREST"))
    blocks.push({ kind: "rows", title: "Statement rows", figureCents: Math.round(parts.rows), groups: groupRows(book, rowParts), note: rowParts.length ? undefined : "No statement row in this figure." });

  if (spreads.size)
    blocks.push({
      kind: "breakdown",
      title: "Rows that count only in part",
      items: [...spreads.values()].map(({ item: it, cents }) => ({
        label: it.item,
        sub: [
          `${formatUsdFromCents(Math.round(it.cents * (it.splitWays ?? 1)))} paid ${it.date}`,
          it.months > 1 && d.basis === "accrued" ? `pays for ${it.months} months (${it.start} – ${addDays(it.end, -1)}); this figure counts the days that fall in it` : null,
          it.splitWays ? `shared between ${it.splitWays} cars owned that day: this car's share` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        value: { cents: Math.round(cents) },
      })),
    });

  // Log entries matched to the rows: hints about them, never money.
  const hinted = [...new Map(rowParts.filter((p) => p.item.entryIds.length).map((p) => [p.item.id, p.item])).values()];
  if (hinted.length)
    blocks.push({
      kind: "breakdown",
      title: "From your log: hints, not money",
      items: hinted.map((it) => {
        const es = it.entryIds.map((id) => entryById.get(id)).filter((e): e is CarEntry => !!e);
        const logged = es.reduce((t, e) => t + e.cents, 0);
        return {
          label: it.item,
          sub: `log: ${es.map(hintText).join("; ")}${it.loggedCents != null ? ` · you logged ${formatUsdFromCents(logged)}; the statement's amount is what counts` : ""}`,
          value: { text: "hint" },
        };
      }),
      note: "A log entry matched to a statement row says what the row was (the odometer, gallons, the months it pays for). The amount always comes from the statement.",
    });

  if (offItems.size)
    blocks.push({
      kind: "breakdown",
      title: "Paid outside the statements (your word)",
      items: [...offItems.values()].map(({ item: it, cents }) => ({ label: it.item || KIND_INFO[it.kind].label, sub: `${it.date} · you marked it paid outside your statements`, value: { cents: Math.round(cents) } })),
    });
  if (rentItems.length) {
    const monthly = new Map<number, number>();
    for (const x of rentItems) monthly.set(x.item.cents, (monthly.get(x.item.cents) ?? 0) + 1);
    blocks.push({
      kind: "breakdown",
      title: "Parking in the rent (typed)",
      items: [...monthly].map(([c, n]) => ({ label: `${formatUsdFromCents(c)} a month`, sub: `${n} month${n === 1 ? "" : "s"} of parking paid inside the rent (Car details)`, value: { cents: Math.round(rentItems.filter((x) => x.item.cents === c).reduce((t, x) => t + x.cents, 0)) } })),
    });
  }

  const unmatched = notCounted(ctx, car, d, periods, keys);
  if (unmatched.length)
    blocks.push({
      kind: "breakdown",
      title: "In your log, not on any statement: not counted",
      items: unmatched.map((h) => ({
        label: h.item || KIND_INFO[h.kind].label,
        sub: `${h.date} · logged ${formatUsdFromCents(h.cents)} · ${h.status === "AWAITING" ? "after the last statement in: awaiting its statement" : "no statement row found"}`,
        value: { text: "$0 counted" },
      })),
      note: "A log entry is a note on a statement row. Until a statement shows it (or you mark it paid outside the statements), it adds nothing.",
    });

  const sameInCashFlow = cashFlowLinks(ctx, rowParts, periods, d);
  if (sameInCashFlow.length) blocks.push({ kind: "breakdown", title: "The same figure in cash flow", items: sameInCashFlow, note: "These rows are exactly the ones cash flow counts for that category and month." });

  const { from, to } = window(periods, r, car);
  const { checks, withheld } = checksFor(book, { affects: "CASH_FLOW", from, to }, CASH_FLOW_CHECKS);
  const listed = new Set(rowParts.map((p) => p.row.id));
  const explainBits = [
    rowParts.length || nonRow === 0 ? `the ${rowCount} statement row${rowCount === 1 ? "" : "s"} below` : null,
    Math.abs(parts.off) >= 0.5 ? "what you paid outside the statements" : null,
    Math.abs(parts.rent) >= 0.5 ? "parking in the rent" : null,
    Math.abs(parts.interest) >= 0.5 ? "interest" : null,
    Math.abs(parts.depreciation) >= 0.5 ? "depreciation" : null,
  ].filter(Boolean) as string[];
  const explain = `${cap(explainBits.length > 1 ? `${explainBits.slice(0, -1).join(", ")} and ${explainBits.at(-1)}` : explainBits[0]!)} come to ${formatUsdFromCents(partsCents)}`;
  // Depreciation alone over one stretch isn't a sum of parts (it's the chain above).
  const onlyDep = keys.every((k) => k === "DEPRECIATION") && periods.length < 2;

  return {
    report: "car",
    descriptor: d,
    describes: `${r.name} · ${d.line ? lineLabel(d.line) : d.basis === "cash" ? "Everything paid" : "Cost of ownership"}${d.basis === "cash" ? ", paid" : ""}, ${spanLabel(d.span, r)}`,
    figure: { cents: figureCents },
    selfCheck: onlyDep ? null : sumCheck(figureCents, partsCents, explain),
    withheld,
    blocks,
    checks,
    estimates: estimatesFor(book, { rowIds: listed, from, to }),
    through: r.through,
    today: book.today,
  };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const link = (label: string, descriptor: CarDescriptor): ProofLink => ({ label, descriptor });

/** The days a figure's statements must cover. */
function window(periods: Period[], r: CarReport, car: Car) {
  // To date: from the first cost counted (one can come before the purchase) or the purchase, whichever is first.
  const starts = [r.items[0]?.date, car.vehicle.purchaseDate, r.through].filter((x): x is string => !!x).sort();
  return { from: periods[0]?.from ?? starts[0]!, to: periods.at(-1)?.to ?? r.through };
}

/** Log entries for the figure's car, lines and span that no statement row is: listed, never counted. */
function notCounted(ctx: Ctx, car: Car, d: CarFigureDescriptor, periods: Period[], keys: string[]) {
  const end = ctx.garage.cars.find((c) => c.carId === car.id)!.through;
  const inSpan = (date: string) => (d.span === "toDate" ? date <= end : periods.some((p) => (p.from ?? "") <= date && date <= p.to));
  return ctx.garage.statements.hints.filter(
    (h) =>
      (h.status === "NOT_FOUND" || h.status === "AWAITING") &&
      h.cents !== 0 &&
      (h.carId === car.id || (h.carId === SHARED && ownedOn(car, h.date))) &&
      keys.includes(d.basis === "accrued" ? (lineOf(h.kind) ?? "") : h.kind) &&
      inSpan(h.date),
  );
}

/**
 * Car spending is also cash-flow spending. A month's rows of one category link to that
 * month's cash-flow proof for the category only when it's the same figure: exactly the
 * same rows, each counted whole, coming to the same cents.
 */
function cashFlowLinks(ctx: Ctx, rowParts: RowPart[], periods: Period[], d: CarFigureDescriptor) {
  if (d.basis !== "accrued" || periods.length !== 1 || !periods[0]!.month) return [];
  const start = `${periods[0]!.month}-01`;
  const byCat = new Map<string, RowPart[]>();
  for (const p of rowParts) byCat.set(p.row.category, [...(byCat.get(p.row.category) ?? []), p]);
  const out: { label: string; value: { cents: number }; sub: string; link: ProofLink }[] = [];
  for (const [category, ps] of byCat) {
    if (ps.some((p) => Math.abs(p.share - 1) > 1e-9)) continue;
    const cf = buildCashFlowProof(ctx.book, { report: "cash-flow", metric: "spending", granularity: "month", start, end: endOfMonth(start), category });
    const cfRows = new Set(cf.sections[0]!.groups.flatMap((g) => g.rows.map((r) => r.id)));
    const mine = new Set(ps.map((p) => p.row.id));
    const cents = Math.round(ps.reduce((t, p) => t + p.cents, 0));
    if (cfRows.size !== mine.size || [...mine].some((id) => !cfRows.has(id)) || cf.figureCents !== cents) continue;
    out.push({ label: category, sub: `cash-flow spending, ${cf.periods[0]?.label ?? periods[0]!.month}`, value: { cents }, link: { label: `${category} in cash flow`, descriptor: cf.descriptor } });
  }
  return out;
}

/** How the span's depreciation is worked out: typed inputs (assumptions), the odometer (the log), the result (an estimate). */
function depreciationChain(car: Car, r: CarReport, d: CarFigureDescriptor, figureCents: number): ProofBlock {
  const a = r.acquisition.cents;
  const dep = r.depreciation;
  const miles = d.span === "toDate" ? r.odometer.driven : d.span === "last12" ? r.last12.miles : r.months.filter((m) => m.month.startsWith(d.span)).reduce((t, m) => t + m.miles, 0);
  const mi = (n: number) => ({ text: `${Math.round(n).toLocaleString("en-US")} mi` });
  const lines: ChainLine[] = [{ label: "All-in purchase (price, fees, warranty, registration, sales tax)", value: { cents: a }, source: "assumption", note: "typed in Car details" }];
  if (dep.method === "SOLD") {
    lines.push({ op: "−", label: "What it sold for", value: { cents: car.sale!.priceCents }, source: "assumption", note: "typed in Car details" });
    if (d.span === "toDate") lines.push({ op: "=", label: "Lost over the time you owned it", value: { cents: figureCents }, source: "derived" });
    else
      lines.push(
        { op: "÷", label: "Miles driven while you owned it", value: mi(r.odometer.driven), source: "assumption", note: "odometer readings in your log" },
        { op: "×", label: "Miles in this span", value: mi(miles), source: "assumption" },
        { op: "=", label: "This span's share", value: { cents: figureCents }, source: "estimate", note: "each month's miles × the rate, rounded month by month" },
      );
  } else if (dep.method === "MARKET") {
    if (d.span === "toDate") {
      lines.push({ op: "−", label: "What it's worth now", value: { cents: dep.marketValueNow ?? 0 }, source: "estimate", note: "your latest value check, moved along the trend in your checks" });
      lines.push({ op: "=", label: "Lost to date", value: { cents: figureCents }, source: "estimate" });
    } else lines.push({ op: "=", label: "Change in market value over the span", value: { cents: figureCents }, source: "estimate", note: "your value checks, a straight line between them, extended along their trend" });
  } else {
    const life = car.plan.sellAtMiles - (car.vehicle.purchaseOdometer ?? 0);
    lines.push(
      { op: "−", label: "Expected resale value", value: { cents: car.plan.residualCents }, source: "assumption", note: "typed plan" },
      { op: "÷", label: `Planned miles (sell at ${car.plan.sellAtMiles.toLocaleString("en-US")} less ${(car.vehicle.purchaseOdometer ?? 0).toLocaleString("en-US")} at purchase)`, value: mi(life), source: "assumption", note: "typed plan" },
      { op: "=", label: "Per mile", value: { cents: dep.plannedPerMile ?? 0 }, source: "derived" },
      { op: "×", label: d.span === "toDate" ? "Miles driven" : "Miles in this span", value: mi(miles), source: "assumption", note: "odometer readings in your log" },
      { op: "=", label: "Depreciation", value: { cents: figureCents }, source: "estimate", note: periodsOf(r, d.span, car.vehicle.purchaseDate).length > 1 ? "each month's miles × the rate, rounded month by month" : undefined },
    );
  }
  return { kind: "chain", title: "How depreciation is worked out", lines, note: "Nothing here is on a statement: it's the purchase you typed, spread over the car's miles or its market value." };
}

/** A rate the page shows: a figure per mile driven, or per month owned, in its span. */
function rateProof(ctx: Ctx, d: CarFigureDescriptor): Proof {
  const { r } = carOf(ctx, d.carId);
  const baseD: CarFigureDescriptor = { report: "car", carId: d.carId, basis: d.basis, span: d.span, ...(d.line ? { line: d.line } : {}) };
  const base = figureProof(ctx, baseD);
  const cents = "cents" in base.figure ? base.figure.cents : 0;
  const monthsOf = r.months.filter((m) => m.month.startsWith(d.span));
  const divisor =
    d.per === "mile"
      ? d.span === "toDate"
        ? r.odometer.driven
        : d.span === "last12"
          ? r.last12.miles
          : monthsOf.reduce((t, m) => t + m.miles, 0)
      : d.span === "toDate"
        ? r.odometer.daysOwned / DAYS_PER_MONTH
        : d.span === "last12"
          ? 12
          : monthsOf.length;
  const ok = d.per === "mile" ? divisor > 0 : divisor >= 1;
  const value = ok ? cents / divisor : null;
  const unit = d.per === "mile" ? "mile" : "month";
  const lines: ChainLine[] = [
    { label: base.describes.replace(`${r.name} · `, ""), value: { cents }, source: "derived", link: link("The total", baseD) },
    d.per === "mile"
      ? { op: "÷", label: d.span === "toDate" ? "Miles driven since purchase" : "Miles driven in the span", value: { text: `${Math.round(divisor).toLocaleString("en-US")} mi` }, source: "assumption", note: "odometer readings in your log" }
      : { op: "÷", label: d.span === "toDate" ? `Months owned (${r.odometer.daysOwned} days since the typed purchase date)` : "Months", value: { text: divisor.toLocaleString("en-US", { maximumFractionDigits: 2 }) }, source: d.span === "toDate" ? "assumption" : "derived" },
    { op: "=", label: `Per ${unit}`, value: value == null ? { text: "—" } : { cents: value }, source: "derived" },
  ];
  return {
    ...base,
    descriptor: d,
    describes: `${base.describes}, per ${unit}`,
    figure: value == null ? { text: "—" } : { cents: value },
    selfCheck: null,
    blocks: [{ kind: "chain", title: `Per ${unit}`, lines, note: ok ? undefined : `Not enough ${d.per === "mile" ? "miles" : "time"} yet for a rate.` }],
  };
}

/** One line of the garage log at its full amount: the rows that are it, or what it rests on instead. */
function itemProof(ctx: Ctx, d: CarItemDescriptor): Proof {
  const { book, settings, garage } = ctx;
  const it = garage.log.find((i) => i.id === d.itemId && i.counted) ?? garage.cars.flatMap((c) => c.items).find((i) => i.id === d.itemId);
  if (!it) throw new Error("No counted cost with that id in the car log.");
  const chargeById = new Map(garage.statements.charges.map((c) => [c.rowId, c]));
  const entryById = new Map(settings.entries.map((e) => [e.id, e]));
  const rowParts: RowPart[] = it.rowIds.flatMap((id) => {
    const row = book.rowById.get(id);
    const ch = chargeById.get(id);
    const ways = it.splitWays ?? 1;
    return row && ch ? [{ row, cents: ch.cents / ways, share: 1 / ways, item: it }] : [];
  });
  const blocks: ProofBlock[] = [];
  if (it.source === "STATEMENT") blocks.push({ kind: "rows", title: "Statement rows", figureCents: it.cents, groups: groupRows(book, rowParts) });
  else
    blocks.push({
      kind: "breakdown",
      title: it.source === "RENT" ? "Parking in the rent (typed)" : "Paid outside the statements (your word)",
      items: [{ label: it.item, sub: it.source === "RENT" ? "a monthly amount typed in Car details" : `${it.date} · you marked it paid outside your statements`, value: { cents: it.cents } }],
    });
  const es = it.entryIds.map((id) => entryById.get(id)).filter((e): e is CarEntry => !!e);
  if (es.length && it.source === "STATEMENT")
    blocks.push({
      kind: "breakdown",
      title: "From your log: hints, not money",
      items: es.map((e) => ({ label: e.item || KIND_INFO[e.kind].label, sub: `log: ${hintText(e)}${e.cents !== it.cents && es.length === 1 ? ` · you logged ${formatUsdFromCents(e.cents)}; the statement's amount is what counts` : ""}`, value: { text: "hint" } })),
    });
  const rowsCents = rowParts.reduce((t, p) => t + p.cents, 0);
  const { checks, withheld } = checksFor(book, { affects: "CASH_FLOW", from: it.date, to: it.date }, CASH_FLOW_CHECKS);
  const owner = settings.cars.find((c) => c.id === it.carId);
  const carLabel = it.carId === SHARED ? "Shared between the cars" : owner ? carName(owner) : "A car";
  return {
    report: "car",
    descriptor: d,
    describes: `${carLabel} · ${it.label ?? it.item}, ${it.date}`,
    figure: { cents: it.cents },
    selfCheck:
      it.source === "STATEMENT" ? sumCheck(Math.round(it.cents), Math.round(rowsCents), `The ${rowParts.length} statement row${rowParts.length === 1 ? "" : "s"} below add${rowParts.length === 1 ? "s" : ""} up to ${formatUsdFromCents(Math.round(rowsCents))}`) : null,
    withheld,
    blocks,
    checks,
    estimates: estimatesFor(book, { rowIds: new Set(it.rowIds), from: it.date, to: it.date }),
    through: book.horizon.cashFlow,
    today: book.today,
  };
}

export const carKind: ProofKind<CarDescriptor> = {
  report: "car",
  parse: parseCarDescriptor,
  build: async ({ book, db }, d) => buildCarProof(book, await loadJsonSetting(db, CAR_KEY, normalizeGarage), d),
};
