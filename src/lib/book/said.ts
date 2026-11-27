import { usdText } from "../formatMoney.ts";
import type { ProofLink } from "./proof/types.ts";

/**
 * Amounts inside sentences: a check's finding ("12 paychecks, $4,210.00 net, went to ••1234"),
 * a tax note ("The return has $120 more interest than the app"). The code that writes the
 * sentence writes each amount through a sayer, which records it: its value, what it is,
 * and the lines it comes from (each linked to the row, stub or statement it was read from).
 * The page draws the sentence with <Said> (components/ui/proof/Said.tsx), each recorded
 * amount a figure; the derived list of the sentence's page (integrity, taxes) lists the same
 * amounts for the proof sweep. An amount written into a sentence any other way is still
 * money outside a figure, and the render audit fails on it.
 */

export type SaidLine = { label: string; cents: number; link?: ProofLink };

export type Amount = {
  /** Stable: the sentence's own key (a finding's id and field, a tax line) and the amount's place in it. */
  key: string;
  /** Which sentence of its owner it sits in ("title", "detail", "note"…). */
  field: string;
  /** Exactly as the sentence prints it. */
  text: string;
  value: { cents: number } | { ratio: number };
  /** Plain words: what the amount is. */
  describes: string;
  /** Where it comes from, line by line (a sum's parts, the document it was read from). */
  lines?: SaidLine[];
};

type Format = (cents: number) => string;
const cents2: Format = (c) => usdText(c);

export type Sayer = {
  /** An amount of money, recorded and written as the sentence prints it. */
  usd: (cents: number, describes: string, lines?: SaidLine[], format?: Format) => string;
  /** A share (0.45), written as a percentage. */
  pct: (ratio: number, describes: string, digits?: number) => string;
  readonly amounts: Amount[];
};

/** A sayer for one sentence: `scope` is the owner's stable key, `field` the sentence. */
export function sayer(scope: string, field: string, format: Format = cents2): Sayer {
  const amounts: Amount[] = [];
  const at = () => `${scope}|${field}|${amounts.length}`;
  return {
    usd(cents, describes, lines, f = format) {
      const text = f(cents);
      amounts.push({ key: at(), field, text, value: { cents }, describes, ...(lines?.length ? { lines } : {}) });
      return text;
    },
    pct(ratio, describes, digits = 0) {
      const text = `${(Math.round(ratio * 100 * 10 ** digits) / 10 ** digits).toFixed(digits)}%`;
      amounts.push({ key: at(), field, text, value: { ratio }, describes });
      return text;
    },
    get amounts() {
      return amounts;
    },
  };
}

/** A sentence split at its recorded amounts, in order: text, then an amount, and so on. */
export function splitSaid(text: string, amounts: readonly Amount[], field: string): (string | Amount)[] {
  const out: (string | Amount)[] = [];
  let at = 0;
  for (const a of amounts) {
    if (a.field !== field) continue;
    const i = text.indexOf(a.text, at);
    if (i < 0) continue;
    if (i > at) out.push(text.slice(at, i));
    out.push(a);
    at = i + a.text.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** A finding's or inference's three sentences, each with its own sayer; `amounts` is all of theirs. */
export function sentences(id: string) {
  const title = sayer(id, "title");
  const detail = sayer(id, "detail");
  const fix = sayer(id, "fix");
  return {
    title,
    detail,
    fix,
    get amounts(): Amount[] {
      return [...title.amounts, ...detail.amounts, ...fix.amounts];
    },
  };
}

/** A statement's printed balance as a sentence's line. */
export const statementLine = (label: string, cents: number, importId: string | null | undefined): SaidLine => ({ label, cents, ...(importId ? { link: { label: "The statement", descriptor: { report: "statement", statementId: importId } } } : {}) });
/** A ledger row as a sentence's line. */
export const rowLine = (label: string, cents: number, rowId: string | null | undefined): SaidLine => ({ label, cents, ...(rowId ? { link: { label: "The row", descriptor: { report: "row", rowId } } } : {}) });
/** A pay stub as a sentence's line. */
export const stubLine = (label: string, cents: number, stubId: string | null | undefined): SaidLine => ({ label, cents, ...(stubId ? { link: { label: "The stub", descriptor: { report: "stub", stubId } } } : {}) });
