import { addDays, daysBetween } from "../../dates/isoDate.ts";
import { sameRow, type RowFingerprint } from "../../review/rowFingerprint.ts";
import type { Book, BookRow } from "../load.ts";
import { compositeOf, sumOf, type ProofRef } from "../proof/compose.ts";
import { rowFingerprint } from "../reimbursements.ts";
import { merchantKeyOf, merchantName, spendingRows, type Cadence, type SpendingReport } from "./spending.ts";

/**
 * What looks unusual in the proven months: a charge that may have gone through twice, a
 * merchant charged for the first time, a bill whose price has crept up, and a bill or a
 * recurring credit that should have come by now and hasn't. Every rule reads only the
 * proven period (a month waiting on a statement is Statements' business, never a missing
 * bill here), leaves alone anything the owner has explained (a review answer, a paid-back
 * link), and changes no figure: each amount it names is a row as its statement prints it,
 * or a figure Cash flow already proves.
 *
 * Each rule says how it decides (RULES), so the page can say why something is listed.
 */

export type AnomalyKind = "duplicate" | "new-merchant" | "price-creep" | "missing-bill" | "missing-credit";

export const RULES: Record<AnomalyKind, { title: string; how: string }> = {
  duplicate: {
    title: "Possible duplicate charges",
    how: "Two charges for the same amount ($10 or more) at the same merchant, on the same card or account, one to two days apart, neither refunded. A merchant where that happens three times or more (fares, tolls) is a pattern, not a slip, and isn't listed.",
  },
  "new-merchant": {
    title: "New merchants",
    how: "Merchants charged for the first time in the latest proven month, $100 or more in all, after at least six proven months with none.",
  },
  "price-creep": {
    title: "Price creep",
    how: "A bill charged at least six times over six months or more whose last two charges are both 3% or more (and $1 or more) above its first.",
  },
  "missing-bill": {
    title: "Expected bills that haven't come",
    how: "A bill on a steady cadence whose next charge was due, with a few days' grace, inside the proven period, and didn't come; only bills still charging within two of their cycles.",
  },
  "missing-credit": {
    title: "Expected credits that haven't come",
    how: "A credit (a card's monthly credit, a refund that recurs) seen in four of the six months before the latest, absent from the latest proven month.",
  },
};

export type Anomaly = {
  kind: AnomalyKind;
  /** Stable across rebuilds: the kind, the merchant and the day(s). */
  id: string;
  merchant: string;
  merchantKey: string;
  date: string;
  /** In words, beyond the amounts. */
  detail: string;
  /** The rows it names (oldest first), each its own proof: the amount as the statement prints it (a charge negative). */
  rows: { id: string; date: string; cents: number }[];
  /** The amount at stake: a positive number of cents. */
  cents: number;
  /** For a bill: the next charge's due day. */
  dueOn?: string;
};

export type AnomaliesReport = { through: string | null; from: string | null; items: Anomaly[]; counts: Record<AnomalyKind, number>; explained: number };

/** A row as an anomaly names it. */
const ref = (r: BookRow) => ({ id: r.id, date: r.date, cents: r.amountCents });

const GRACE: Record<Cadence, number> = { weekly: 3, biweekly: 5, monthly: 8, quarterly: 15, annual: 25 };
const DAYS: Record<Cadence, number> = { weekly: 7, biweekly: 14, monthly: 30, quarterly: 91, annual: 365 };

const DUP_MIN = 10_00;
const DUP_DAYS = 2;
const DUP_PATTERN = 3;
const NEW_MIN = 100_00;
const NEW_HISTORY = 6;
const CREEP = 0.03;
const CREEP_MIN = 1_00;

/**
 * The anomalies in the proven months of `rep` (the spending report the page reads), from
 * the Book's rows. `reviewed`: rows the owner answered on Statements › Categorize.
 */
export function buildAnomalies(book: Book, rep: Pick<SpendingReport, "months" | "recurring">, reviewed: readonly RowFingerprint[] = []): AnomaliesReport {
  const { windowRows, dayOf } = spendingRows(book);
  // Owner-explained rows: answered by hand, or one side of a paid-back link.
  const linked = new Set((book.reimbursements?.links ?? []).flatMap((l) => [l.expense.rowId, l.source.rowId]).filter((x): x is string => Boolean(x)));
  const explainedRow = (r: BookRow) => r.classifiedBy === "USER" || linked.has(r.id) || (reviewed.length > 0 && reviewed.some((f) => sameRow(f, rowFingerprint(r, book.accounts))));
  return findAnomalies({ rows: windowRows, dayOf, months: rep.months, recurring: rep.recurring, explainedRow });
}

export type AnomalyInputs = {
  /** The proven window's rows, reversed charges left out (spendingRows). */
  rows: readonly BookRow[];
  dayOf: (r: BookRow) => string;
  months: readonly Pick<SpendingReport["months"][number], "start" | "end" | "label">[];
  recurring: SpendingReport["recurring"];
  explainedRow: (r: BookRow) => boolean;
};

/** The rules over rows already gathered: pure. */
export function findAnomalies({ rows: windowRows, dayOf, months, recurring, explainedRow }: AnomalyInputs): AnomaliesReport {
  const counts = { duplicate: 0, "new-merchant": 0, "price-creep": 0, "missing-bill": 0, "missing-credit": 0 } satisfies Record<AnomalyKind, number>;
  const rep = { months, recurring };
  const first = rep.months[0];
  const last = rep.months.at(-1);
  if (!first || !last) return { through: null, from: null, items: [], counts, explained: 0 };
  const through = last.end;
  let explained = 0;
  const items: Anomaly[] = [];
  const charges = windowRows.filter((r) => r.lane === "EXPENSE" && r.amountCents < 0 && dayOf(r) >= first.start && dayOf(r) <= through);
  const byMerchant = new Map<string, BookRow[]>();
  for (const r of charges) byMerchant.set(merchantKeyOf(r), [...(byMerchant.get(merchantKeyOf(r)) ?? []), r]);
  for (const list of byMerchant.values()) list.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  // Duplicates: pairs of the same amount, same account, a day or two apart.
  for (const [key, list] of byMerchant) {
    const pairs: [BookRow, BookRow][] = [];
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length && daysBetween(list[i]!.date, list[j]!.date) <= DUP_DAYS; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (a.accountId === b.accountId && a.amountCents === b.amountCents && -a.amountCents >= DUP_MIN && daysBetween(a.date, b.date) >= 1) pairs.push([a, b]);
      }
    if (pairs.length >= DUP_PATTERN) continue;
    for (const [a, b] of pairs) {
      if (explainedRow(a) || explainedRow(b)) {
        explained++;
        continue;
      }
      items.push({ kind: "duplicate", id: `duplicate:${key}:${a.date}:${b.date}:${-a.amountCents}`, merchant: merchantName(key), merchantKey: key, date: b.date, detail: `${a.date} and ${b.date}, the same amount on the same account`, rows: [ref(a), ref(b)], cents: -b.amountCents });
    }
  }

  // New merchants: first charged in the latest month, after half a year of proven months.
  if (rep.months.length > NEW_HISTORY) {
    for (const [key, list] of byMerchant) {
      if (dayOf(list[0]!) < last.start) continue;
      const total = list.reduce((s, r) => s - r.amountCents, 0);
      if (total < NEW_MIN) continue;
      if (list.every(explainedRow)) {
        explained++;
        continue;
      }
      items.push({ kind: "new-merchant", id: `new-merchant:${key}:${last.start}`, merchant: merchantName(key), merchantKey: key, date: list[0]!.date, detail: `${list.length} charge${list.length === 1 ? "" : "s"} in ${last.label}, none before`, rows: list.map(ref), cents: total });
    }
  }

  // Price creep and expected bills: the recurring bills Cash flow detects.
  for (const bill of rep.recurring.filter((x) => x.kind === "bill" && x.cadence)) {
    const list = byMerchant.get(bill.key) ?? [];
    if (list.length >= 6 && daysBetween(list[0]!.date, list.at(-1)!.date) >= 180) {
      const from = -list[0]!.amountCents;
      const tail = list.slice(-2).map((r) => -r.amountCents);
      if (tail.every((x) => x >= from * (1 + CREEP) && x - from >= CREEP_MIN)) {
        if (explainedRow(list.at(-1)!)) explained++;
        else items.push({ kind: "price-creep", id: `price-creep:${bill.key}:${list.at(-1)!.date}`, merchant: bill.name, merchantKey: bill.key, date: list.at(-1)!.date, detail: `from ${list[0]!.date} to ${list.at(-1)!.date}`, rows: [ref(list[0]!), ref(list.at(-1)!)], cents: tail.at(-1)! - from });
      }
    }
    const cadence = bill.cadence!;
    const due = addDays(bill.lastDate, DAYS[cadence]);
    // Due (with grace) inside the proven period, and still charging within two cycles of its end.
    if (addDays(due, GRACE[cadence]) <= through && daysBetween(bill.lastDate, through) <= 2 * DAYS[cadence] + GRACE[cadence]) {
      const lastRow = list.at(-1);
      if (lastRow && explainedRow(lastRow)) explained++;
      else if (lastRow) items.push({ kind: "missing-bill", id: `missing-bill:${bill.key}:${due}`, merchant: bill.name, merchantKey: bill.key, date: due, detail: `${cadence}, last charged ${bill.lastDate}`, rows: [ref(lastRow)], cents: bill.typicalCents, dueOn: due });
    }
  }

  // Expected credits: a merchant's credit most months, then none in the latest.
  const credits = windowRows.filter((r) => r.lane === "EXPENSE" && r.amountCents > 0 && dayOf(r) >= first.start && dayOf(r) <= through);
  const before = rep.months.slice(-7, -1);
  if (before.length === 6) {
    const byKey = new Map<string, BookRow[]>();
    for (const r of credits) byKey.set(merchantKeyOf(r), [...(byKey.get(merchantKeyOf(r)) ?? []), r]);
    for (const [key, list] of byKey) {
      const seen = before.filter((m) => list.some((r) => dayOf(r) >= m.start && dayOf(r) <= m.end)).length;
      const now = list.some((r) => dayOf(r) >= last.start && dayOf(r) <= last.end);
      if (seen < 4 || now) continue;
      const lastCredit = list.sort((a, b) => a.date.localeCompare(b.date)).at(-1)!;
      if (explainedRow(lastCredit)) {
        explained++;
        continue;
      }
      items.push({ kind: "missing-credit", id: `missing-credit:${key}:${last.start}`, merchant: merchantName(key), merchantKey: key, date: last.end, detail: `in ${seen} of the 6 months before ${last.label}, last on ${lastCredit.date}`, rows: [ref(lastCredit)], cents: lastCredit.amountCents });
    }
  }

  const order: AnomalyKind[] = ["duplicate", "missing-bill", "missing-credit", "price-creep", "new-merchant"];
  items.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.cents - a.cents || a.id.localeCompare(b.id));
  for (const i of items) counts[i.kind]++;
  return { through, from: first.start, items, counts, explained };
}

/** A row an anomaly names, as its statement prints it: its own proof. */
export const anomalyRowProof = (r: Anomaly["rows"][number]): ProofRef => ({ descriptor: { report: "row", rowId: r.id }, shownCents: r.cents });

/** The amount an anomaly is about, with the proof of the figure it is (`dp`: Cash flow's derived figures). */
export function anomalyProof(a: Anomaly, dp: (figure: string, key?: string) => ProofRef): ProofRef {
  switch (a.kind) {
    case "duplicate":
    case "missing-credit":
      return anomalyRowProof(a.rows.at(-1)!);
    case "new-merchant":
      return sumOf(a.rows.map(anomalyRowProof), a.rows.reduce((s, r) => s + r.cents, 0));
    case "price-creep":
      // Latest less first, as printed (charges are negative): its size is the rise.
      return compositeOf("diff", [anomalyRowProof(a.rows[1]!), anomalyRowProof(a.rows[0]!)], { cents: a.rows[1]!.cents - a.rows[0]!.cents });
    case "missing-bill":
      return dp("recurring-typical", a.merchantKey);
  }
}
