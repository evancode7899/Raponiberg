import { lines, parseMonthNameDate } from "../ingest/text.ts";
import type { FundCall, FundDoc, FundStatement, PrintedCommitment } from "./types.ts";

/** Bump when a change would read stored fund documents differently: they are read again. */
export const FUND_READER_VERSION = 1;

const LETTER = /(?:EQUALISATION AND )?CAPITAL CALL NOTICE/;
const ILPA = /ILPA Capital Call & Distribution Template/;
const STATEMENT = /Statement of Partner's Capital Activity/;

/** Which fund document the text is, or null for one this reader doesn't use. */
export function fundDocKind(text: string): "letter" | "ilpa" | "statement" | null {
  if (ILPA.test(text)) return "ilpa";
  if (LETTER.test(text) && /Drawdown Notice/.test(text)) return "letter";
  if (STATEMENT.test(text) && /Partner's Capital Statement\s*\|/.test(text)) return "statement";
  return null;
}

/** "2,000", "$ 2,000.00", "(800)", "$ (0)", "-" → cents (parentheses negative). */
export function wholeDollars(token: string | undefined): number | null {
  if (token == null) return null;
  const t = token.replace(/[$\s]/g, "");
  if (/^[-–—]$/.test(t)) return 0;
  const m = /^(\()?(-)?([\d,]+)(\.\d+)?\)?$/.exec(t);
  if (!m) return null;
  const v = Math.round(Number(m[3]!.replace(/,/g, "") + (m[4] ?? "")) * 100);
  return m[1] || m[2] ? -v : v;
}

const AMOUNT = /(\$\s*)?(\(?-?[\d,]+(?:\.\d+)?\)?|[-–—])/g;

/** Every amount on a line after its label. */
function amountsAfter(line: string, label: RegExp): number[] {
  const rest = line.replace(label, "");
  return [...rest.matchAll(AMOUNT)].map((m) => wholeDollars(m[2])).filter((v): v is number => v != null);
}

/** The first line matching `label` and its amounts (none when the label isn't printed). */
function row(ls: string[], label: RegExp): number[] | null {
  const line = ls.find((l) => label.test(l));
  return line == null ? null : amountsAfter(line, label);
}

const last = (xs: number[] | null) => (xs?.length ? xs[xs.length - 1]! : null);
const first = (xs: number[] | null) => (xs?.length ? xs[0]! : null);

const investorIdOf = (text: string) => /Start(TNR\d+)End/.exec(text)?.[1] ?? null;

/** The fund the document names: one of `knownFunds` when it prints one, else its first "… LP" line. */
function fundOf(text: string, ls: string[], knownFunds: string[]): string {
  return knownFunds.find((f) => text.includes(f)) ?? ls.find((l) => /\bL\.?P\.?$/.test(l) && !/general partner/i.test(l)) ?? "Private fund";
}

/**
 * The manager's call letter. A plain call prints only the total due; an equalisation call
 * (a later close admitted new investors) itemises the contribution called, the part of
 * earlier contributions handed back, and interest on it, netting to what is due. Both end
 * with the manager's commitment summary.
 */
function parseLetter(text: string, knownFunds: string[]): FundCall {
  const ls = lines(text);
  // The notice's date follows the investor number; the agreement's date comes later.
  const head = text.slice(text.search(/Start(TNR\d+)End|NOTICE/));
  const issued = parseMonthNameDate(head);
  if (!issued) throw new Error("Capital call notice: date not found");
  const dueLine = ls.find((l) => /^Total Amount Due by/.test(l));
  const due = dueLine ? parseMonthNameDate(dueLine) : null;
  const netDue = last(dueLine ? amountsAfter(dueLine, /^Total Amount Due by [A-Za-z]+\.? \d{1,2}, \d{4}/) : null);
  if (netDue == null) throw new Error("Capital call notice: amount due not found");

  const returned = Math.abs(last(row(ls, /^Return of Contribution\b.*?(?=\$|\t|$)/)) ?? 0);
  const interest = Math.abs(last(row(ls, /^Interest on Return of Contribution\b.*?(?=\$|\t|$)/)) ?? 0);
  const called = last(row(ls, /^Contribution in accordance with clause [\d.()a-z]+/));
  const printed: PrintedCommitment = {
    commitmentCents: last(row(ls, /^Total Capital Commitment/)),
    priorContributionsCents: last(row(ls, /^Prior Contributions\s*[–-]\s*Inception to Date/)),
    priorDistributionsCents: ((v) => (v == null ? null : Math.abs(v)))(last(row(ls, /^Distributions\s*[–-]\s*Inception to Date/))),
    currentContributionCents: last(row(ls, /^Current Contribution/)),
    unfundedCents: last(row(ls, /^Remaining Unfunded Commitment/)),
  };
  return {
    kind: "CALL",
    format: "letter",
    fund: fundOf(text, ls, knownFunds),
    investorId: investorIdOf(text),
    issued,
    due,
    equalisation: /EQUALISATION/.test(text) || returned > 0,
    contributionCents: called ?? netDue,
    returnedCents: returned,
    interestCents: interest,
    netDueCents: Math.max(0, netDue),
    printed: Object.values(printed).some((v) => v != null) ? printed : null,
  };
}

const mdy = (s: string) => {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s)!;
  return `${m[3]}-${m[1]}-${m[2]}`;
};

/**
 * The ILPA template's version of a notice. Its labels and values are laid out in separate
 * columns, so only the parts that keep their row are read: the issue and due dates (the
 * only two MM-DD-YYYY dates), the Section C worksheet (one line per transaction, the LP
 * amount first) and line 2.21, the net amount of this notice.
 */
function parseIlpa(text: string, knownFunds: string[]): FundCall {
  const ls = lines(text);
  const dates = [...new Set([...text.matchAll(/(?<![\d-])(\d{2}-\d{2}-\d{4})(?![\d-])/g)].map((m) => mdy(m[1]!)))].sort();
  if (!dates.length) throw new Error("ILPA notice: issue date not found");
  const worksheet = (label: RegExp) => Math.abs(first(row(ls, label)) ?? 0);
  const called = worksheet(/^Contribution(?=\s+[\d(])/);
  const returned = worksheet(/^Return of Contribution(?=\s+[\d(])/);
  const interest = worksheet(/^Interest on Return of Contribution(?=\s+[\d(])/);
  const net = first(row(ls, /^2\.21 LP Amount \(Current Notice\):/));
  return {
    kind: "CALL",
    format: "ilpa",
    fund: fundOf(text, ls, knownFunds),
    investorId: investorIdOf(text),
    issued: dates[0]!,
    due: dates.length > 1 ? dates[dates.length - 1]! : null,
    equalisation: returned > 0 || /equalisation/i.test(text),
    contributionCents: called || (net ?? 0),
    returnedCents: returned,
    interestCents: interest,
    netDueCents: Math.max(0, net ?? called - returned - interest),
    printed: null,
  };
}

/** The quarterly capital statement: its inception-to-date column and commitment summary. */
function parseStatement(text: string, knownFunds: string[]): FundStatement {
  const ls = lines(text);
  const asOf = parseMonthNameDate(/Partner's Capital Statement\s*\|\s*(.+)$/m.exec(text)?.[1] ?? "");
  if (!asOf) throw new Error("Capital statement: statement date not found");
  // Quarter-to-date first, inception-to-date second.
  const itd = (label: RegExp) => (row(ls, label) ?? [])[1] ?? null;
  const ending = itd(/^Ending Capital/);
  if (ending == null) throw new Error("Capital statement: ending capital not found");
  return {
    kind: "STATEMENT",
    fund: fundOf(text, ls, knownFunds),
    investorId: investorIdOf(text),
    asOf,
    endingCapitalCents: ending,
    itd: {
      contributionsCents: itd(/^Contributions(?=\s)/) ?? 0,
      distributionsCents: Math.abs(itd(/^Distributions(?=\s)/) ?? 0),
      incomeCents: itd(/^Total Income\/\(Loss\)/) ?? 0,
      managementFeeCents: Math.abs(itd(/^Management fee expense/) ?? 0),
      carryCents: Math.abs(itd(/^Carried Interest/) ?? 0),
    },
    // Not the "Commitment Summary" heading above it.
    commitmentCents: last(row(ls, /^Commitment(?=\s+[$\d(])/)),
    remainingCommitmentCents: last(row(ls, /^Remaining Capital Commitment/)),
  };
}

/** Reads a fund document; null for one this reader doesn't use. `knownFunds`: the household's fund names as statements print them. */
export function parseFundDoc(text: string, knownFunds: string[] = []): FundDoc | null {
  const kind = fundDocKind(text);
  if (kind === "letter") return parseLetter(text, knownFunds);
  if (kind === "ilpa") return parseIlpa(text, knownFunds);
  if (kind === "statement") return parseStatement(text, knownFunds);
  return null;
}
