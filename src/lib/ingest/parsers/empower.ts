import type { ParsedDocument, ParsedTransaction } from "../types.ts";
import { collapseSpaces, lines, parseMoney, parseSlashDate, trailingAmounts } from "../text.ts";

export const EMPOWER_PARSER_ID = "empower-401k";
/** Bump when a change would read already-imported documents differently: they are read again on the next folder scan or launch. */
export const VERSION = 3;

/** Employer money the sponsor deposits outside payroll (no pay stub line); the integrity checks key on this label. */
export const QNEC_LABEL = "Qualified Non-Elective contribution";

export function detectEmpower(text: string): boolean {
  return /Empower/.test(text) && /Statement Period: \d{2}\/\d{2}\/\d{4} - \d{2}\/\d{2}\/\d{4}/.test(text) && /How has my account changed\?/.test(text);
}

/**
 * Empower quarterly 401(k) statements. The "How has my account changed?" table splits
 * every line into Employee / Employer / Total columns, which is exactly the
 * employee-vs-employer contribution split the ledger wants. Quarterly rows have no
 * dates, so flows are PERIOD-precision (spread across the quarter when needed).
 */
export function parseEmpower(text: string): ParsedDocument {
  const ls = lines(text);
  const warnings: string[] = [];
  const periodMatch = /Statement Period: (\d{2}\/\d{2}\/\d{4}) - (\d{2}\/\d{2}\/\d{4})/.exec(text)!;
  const periodStart = parseSlashDate(periodMatch[1]!)!;
  const periodEnd = parseSlashDate(periodMatch[2]!)!;
  const plan = /Plan: ([\d-]+)/.exec(text)?.[1];
  if (!plan) throw new Error("Empower: plan number not found");
  const planName = ls.find((l) => /401\(K\) PLAN/i.test(l)) ?? "Empower 401(k)";

  const start = ls.findIndex((l) => /^How has my account changed\?/.test(l));
  const rows: { label: string; employee: number; employer: number; total: number }[] = [];
  for (let i = start + 1; i < ls.length; i++) {
    const l = ls[i]!;
    if (/^Employee Employer Total$/.test(l)) continue;
    const { values, rest } = trailingAmounts(l);
    if (values.length < 2) {
      if (rows.length > 0) break; // table ended
      continue;
    }
    const [employee, employer, total] =
      values.length >= 3 ? values.slice(-3) : [values[0]!, 0, values[1]!];
    rows.push({ label: collapseSpaces(rest), employee: employee!, employer: employer!, total: total! });
    if (/^Balance as of/.test(rest) && rows.length > 1) break;
  }
  const opening = rows.find((r) => /^Balance as of/.test(r.label));
  const closing = [...rows].reverse().find((r) => /^Balance as of/.test(r.label));
  if (!opening || !closing || opening === closing) throw new Error("Empower: balance rows not found");

  // "Payroll Contributions" lumps a QNEC in with the match; the funding table lists deposits
  // by money source (beginning, deposits, ...), so the QNEC is split out to keep the payroll
  // money comparable to the stubs.
  // Blank columns are omitted, so a row holding a balance but no new deposit puts its
  // earnings where the deposit would be: only a figure that also appears as a deposit in
  // the activity list ("Contribution <payroll date> <effective date> <amount>") counts.
  const deposited = new Set(
    ls.flatMap((l) => {
      const m = /^Contribution\s+[A-Za-z]{3} \d{1,2}, \d{4}\s+[A-Za-z]{3} \d{1,2}, \d{4}\s+(-?[\d,]+\.\d{2})$/.exec(l);
      return m ? [parseMoney(m[1]!)] : [];
    }),
  );
  const qnec = ls.reduce((sum, l) => {
    const m = /^Qualified Non-?Elective\s+-?[\d,]+\.\d{2}\s+(-?[\d,]+\.\d{2})/i.exec(l);
    const amount = m ? (parseMoney(m[1]!) ?? 0) : 0;
    return amount > 0 && deposited.has(amount) ? sum + amount : sum;
  }, 0);

  let growth = 0;
  let fees = 0;
  const transactions: ParsedTransaction[] = [];
  const checks = [];
  for (const r of rows) {
    if (r === opening || r === closing) continue;
    checks.push({ label: `${r.label}: employee + employer = total`, expectedCents: r.total, actualCents: r.employee + r.employer });
    if (/^(Change in Value|Dividends|Interest|Earnings)/i.test(r.label)) {
      growth += r.total;
    } else if (/^(Expenses|Fees)/i.test(r.label)) {
      fees += r.total;
    } else if (/Contributions/i.test(r.label)) {
      const splitOut = /^Payroll Contributions/i.test(r.label) && qnec !== 0 && r.employer >= qnec ? qnec : 0;
      if (splitOut) {
        transactions.push({ date: periodEnd, datePrecision: "PERIOD", description: `${QNEC_LABEL} (employer)`, amountCents: splitOut, section: "Employer contributions" });
      }
      for (const [who, amount] of [["Employee", r.employee], ["Employer", r.employer - splitOut]] as const) {
        if (amount !== 0) {
          transactions.push({
            date: periodEnd,
            datePrecision: "PERIOD",
            description: `${r.label} (${who.toLowerCase()})`,
            amountCents: amount,
            section: `${who} contributions`,
          });
        }
      }
    } else {
      // Withdrawals, transfers, rollovers in/out, loans: whole-account movements.
      if (!/Withdrawals|Transfers?|Rollover|Distributions?|Loan/i.test(r.label)) {
        warnings.push(`Unfamiliar activity line treated as a money movement: ${r.label}`);
      }
      transactions.push({
        date: periodEnd,
        datePrecision: "PERIOD",
        description: r.label,
        amountCents: r.total,
        section: r.label,
      });
    }
  }
  checks.push({
    label: "Opening + activity = closing (employee + employer columns)",
    expectedCents: closing.total,
    actualCents: opening.total + rows.filter((r) => r !== opening && r !== closing).reduce((a, r) => a + r.total, 0),
  });

  return {
    parserId: EMPOWER_PARSER_ID,
    parserVersion: VERSION,
    institution: "Empower",
    kind: "STATEMENT",
    title: "Empower 401(k) quarterly statement",
    periodStart,
    periodEnd,
    sections: [
      {
        institution: "Empower",
        accountNumber: plan,
        accountName: `401(k) — ${collapseSpaces(planName.replace(/401\(K\) PLAN/i, "").trim()) || "Empower"}`,
        kind: "INVESTMENT",
        subtype: "401K",
        periodStart,
        periodEnd,
        openingBalanceCents: opening.total,
        closingBalanceCents: closing.total,
        growthCents: growth,
        feesCents: fees,
        transactions,
        checks,
      },
    ],
    warnings,
  };
}
