import { extractVanguard401kHoldings } from "../holdings/index.ts";
import type { ParsedAccountSection, ParsedDocument, ParsedTransaction } from "../types.ts";
import { collapseSpaces, lines, parseMoney, parseSlashDate } from "../text.ts";

export const VANGUARD_401K_PARSER_ID = "vanguard-401k";
/** Bump when a change would read already-imported documents differently: they are read again on the next folder scan or launch. */
export const VERSION = 1;

export function detectVanguard401k(text: string): boolean {
  return /ACCOUNT SUMMARY: \d{2}\/\d{2}\/\d{4} - \d{2}\/\d{2}\/\d{4}/.test(text) && /vanguard\.com/i.test(text) && /401\(K\) PLAN/i.test(text);
}

type Column = { opening: number; employee: number; employer: number; gain: number; fees: number; closing: number };

/**
 * Vanguard Retirement Plan quarterly statements ("Account Summary" page): beginning
 * balance, employee contributions, employer contributions, market gain/loss, fees,
 * ending balance — once for the quarter and, on every quarter after the first, again
 * for the year to date.
 *
 * The quarter becomes the statement. The year-to-date column becomes a recap section
 * (only used to fill quarters that have no statement of their own), because a single
 * later statement is then enough to reconstruct the whole year's contributions and
 * growth.
 */
export function parseVanguard401k(text: string): ParsedDocument {
  const ls = lines(text);
  const warnings: string[] = [];
  const m = /ACCOUNT SUMMARY: (\d{2}\/\d{2}\/\d{4}) - (\d{2}\/\d{2}\/\d{4})/.exec(text)!;
  const periodStart = parseSlashDate(m[1]!)!;
  const periodEnd = parseSlashDate(m[2]!)!;
  const planLine = ls.find((l) => /401\(K\) PLAN/i.test(l) && /––|--|—/.test(l)) ?? "";
  const plan = /(\d{4,})\s*$/.exec(planLine)?.[1];
  if (!plan) throw new Error("Vanguard 401(k): plan number not found");
  const planName = collapseSpaces(planLine.replace(/[–—-]+\s*\d+\s*$/, "").replace(/401\(K\) PLAN/i, "").trim()) || "Vanguard";
  const planTitle = planName.replace(/\b([A-Z])([A-Z]+)\b/g, (_, a: string, b: string) => a + b.toLowerCase());
  // The participant's name follows the plan line (after an optional division line).
  const participant = ls
    .slice(ls.indexOf(planLine) + 1, ls.indexOf(planLine) + 3)
    .find((l) => !/^DIVISION NAME:/i.test(l) && /^[A-Z][A-Z .'-]+$/.test(l.trim()));
  const firstName = participant?.trim().split(/\s+/)[0];
  const holder = firstName ? ` — ${firstName[0] + firstName.slice(1).toLowerCase()}` : "";

  const read = (label: string): number[] | null => {
    const line = ls.find((l) => l.startsWith(label) && /\$/.test(l));
    if (!line) return null;
    const values = [...line.slice(label.length).matchAll(/-?\$[\d,]+\.\d{2}|\$-[\d,]+\.\d{2}/g)].map((x) => parseMoney(x[0].replace(/^\$-/, "-$"))!);
    return values.length ? values : null;
  };
  const rows = {
    opening: read("Beginning balance"),
    employee: read("Your contributions"),
    employer: read("Employer contributions"),
    gain: read("Market gain/loss"),
    fees: read("Fees*") ?? read("Fees"),
    closing: read("Ending balance"),
  };
  if (!rows.opening || !rows.closing || !rows.employee || !rows.employer || !rows.gain || !rows.fees) {
    throw new Error("Vanguard 401(k): account summary rows not found");
  }
  const column = (i: number): Column => ({
    opening: rows.opening![i]!,
    employee: rows.employee![i]!,
    employer: rows.employer![i]!,
    gain: rows.gain![i]!,
    fees: rows.fees![i]!,
    closing: rows.closing![i]!,
  });
  const hasYtd = rows.opening.length >= 2;

  const section = (c: Column, start: string, isSummary: boolean): ParsedAccountSection => {
    const tx: ParsedTransaction[] = [];
    if (c.employee !== 0) {
      tx.push({ date: periodEnd, datePrecision: "PERIOD", description: "Employee contributions", amountCents: c.employee, section: "Employee contributions" });
    }
    if (c.employer !== 0) {
      tx.push({ date: periodEnd, datePrecision: "PERIOD", description: "Employer contributions", amountCents: c.employer, section: "Employer contributions" });
    }
    return {
      institution: "Vanguard",
      accountNumber: plan,
      accountName: `401(k) — ${planTitle}${holder}`,
      kind: "INVESTMENT",
      subtype: "401K",
      periodStart: start,
      periodEnd,
      openingBalanceCents: c.opening,
      closingBalanceCents: c.closing,
      growthCents: c.gain,
      feesCents: c.fees,
      transactions: tx,
      isSummary: isSummary || undefined,
      checks: [],
    };
  };

  const quarter = section(column(0), periodStart, false);
  const sections = [quarter];
  // The fund table's "Total Invested" row is the statement's own tie-out of the quarter.
  const total = ls.find((l) => l.startsWith("Total Invested"));
  if (total) {
    const v = [...total.matchAll(/-?\s?\$[\d,]+\.\d{2}/g)].map((x) => parseMoney(x[0].replace(/\s+/g, ""))!);
    if (v.length === 5) {
      quarter.checks.push(
        { label: "Fund table opening = account summary opening", expectedCents: v[0]!, actualCents: quarter.openingBalanceCents },
        { label: "Fund table contributions = employee + employer", expectedCents: v[1]!, actualCents: column(0).employee + column(0).employer },
        { label: "Fund table market gain/loss = account summary", expectedCents: v[3]!, actualCents: quarter.growthCents },
        { label: "Fund table fees/other = account summary fees", expectedCents: v[2]!, actualCents: quarter.feesCents },
        { label: "Fund table ending = account summary ending", expectedCents: v[4]!, actualCents: quarter.closingBalanceCents },
      );
    } else {
      warnings.push("Fund table totals could not be read; quarter tied out on balances only");
    }
  }

  if (hasYtd) {
    const ytd = column(1);
    // Jan 1 of the statement's year. Only worth keeping when it reaches further back
    // than this quarter.
    const yearStart = `${periodEnd.slice(0, 4)}-01-01`;
    if (yearStart < periodStart) {
      const recap = section(ytd, yearStart, true);
      recap.checks.push({
        label: "Year to date: opening + contributions + gain + fees = ending",
        expectedCents: ytd.closing,
        actualCents: ytd.opening + ytd.employee + ytd.employer + ytd.gain + ytd.fees,
      });
      recap.checks.push({
        label: "Year-to-date ending = quarter ending",
        expectedCents: column(0).closing,
        actualCents: ytd.closing,
      });
      sections.push(recap);
    }
  }

  return {
    parserId: VANGUARD_401K_PARSER_ID,
    parserVersion: VERSION,
    institution: "Vanguard",
    kind: "STATEMENT",
    title: "Vanguard 401(k) quarterly statement",
    periodStart,
    periodEnd,
    sections,
    holdings: [extractVanguard401kHoldings(text, plan)].filter((h) => h != null),
    warnings,
  };
}
