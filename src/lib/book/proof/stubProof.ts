import { formatUsdFromCents } from "../../formatMoney.ts";
import { stubChecks } from "../../ingest/payroll/checks.ts";
import { CASH_EARNING_KINDS, WITHHELD_KINDS, type StubLine } from "../../ingest/payroll/types.ts";
import { stubRef } from "../findingKeys.ts";
import type { Book } from "../load.ts";
import type { CheckId } from "../types.ts";
import { checksFor } from "./common.ts";
import type { ChainLine, Proof, ProofBlock, ProofFact, ProofKind } from "./types.ts";

/**
 * The proof behind one pay stub, exactly as it was read: every earning, tax and deduction
 * line this paycheck and year to date, the totals the stub prints and its own arithmetic
 * (lines = printed totals, gross − withheld = net, deposits = net), the bank deposit it
 * was matched to, and the document. Pay figures (pay, bonuses, HSA, taxes) list stubs; a
 * stub opens here, and its deposit opens the bank row.
 *
 * Its figure is the net pay the stub prints; the earning lines less the tax and deduction
 * lines are re-added on their own.
 */

export type StubDescriptor = { report: "stub"; stubId: string };

/** The checks over the stub's person, employer and pay date, in the order the drawer lists them. */
export const STUB_CHECKS: CheckId[] = ["paystub.arithmetic", "paystub.person", "paystub.deposit", "pay.continuity", "pay.deposits-tie", "ledger.freshness"];

export function parseStubDescriptor(d: Record<string, unknown>): StubDescriptor | { error: string } {
  if (typeof d.stubId !== "string" || !d.stubId) return { error: "stubId must name a pay stub." };
  return { report: "stub", stubId: d.stubId };
}

const money = (c: number) => (c === 0 ? "$0.00" : formatUsdFromCents(c));
const EMPLOYER_KINDS = new Set(["EMPLOYER_RETIREMENT", "EMPLOYER_HSA", "EMPLOYER_HEALTH", "EMPLOYER_OTHER"]);

export function buildStubProof(book: Book, d: StubDescriptor): Proof {
  const s = book.stubs.find((x) => x.id === d.stubId);
  if (!s) throw new Error("No pay stub with that id is on file: it may have been re-imported since the page loaded. Reload the page.");
  const who = book.persons.find((p) => p.id === s.personId)?.name ?? s.employee;
  const cur = (kinds: ReadonlySet<string>) => s.lines.filter((l) => kinds.has(l.kind) && (l.current ?? 0) !== 0);
  const sum = (ls: StubLine[]) => ls.reduce((t, l) => t + (l.current ?? 0), 0);
  const earned = cur(CASH_EARNING_KINDS);
  const held = cur(WITHHELD_KINDS);
  const earnCents = sum(earned);
  const heldCents = sum(held);
  const imputed = s.lines.filter((l) => l.kind === "IMPUTED" && (l.current ?? 0) !== 0);
  const p = s.printed;

  const pay: ChainLine[] = [
    ...earned.map((l, i): ChainLine => ({
      op: i ? "+" : undefined,
      label: l.name,
      value: { cents: l.current! },
      source: "proven",
    })),
    {
      op: "=",
      label: p.grossCurrent != null ? "Gross pay, as printed" : "Gross pay (the stub prints no total: the lines added)",
      value: { cents: p.grossCurrent ?? earnCents },
      source: p.grossCurrent != null ? "proven" : "derived",
      note: imputed.length ? `Not counted: ${imputed.map((l) => `${l.name} ${money(l.current!)}`).join(", ")}, taxed as income but never paid.` : undefined,
    },
    ...held.map((l): ChainLine => ({
      op: "−",
      label: l.name,
      value: { cents: l.current! },
      source: "proven",
    })),
    {
      op: "=",
      label: "Net pay, as printed",
      value: { cents: p.netCurrent },
      source: "proven",
    },
  ];
  const blocks: ProofBlock[] = [{ kind: "chain", title: "This paycheck, line by line", lines: pay }];

  const employer = cur(EMPLOYER_KINDS);
  if (employer.length)
    blocks.push({
      kind: "chain",
      title: "Paid by the employer beside your pay",
      lines: employer.map((l): ChainLine => ({
        label: l.name,
        value: { cents: l.current! },
        source: "proven",
      })),
      note: "Not part of gross or net pay: the employer's own money (401(k) match, HSA, health premiums).",
    });

  const checks = stubChecks(s);
  if (checks.length)
    blocks.push({
      kind: "chain",
      title: "The stub checks itself",
      lines: checks.map((c): ChainLine => ({
        label: c.label,
        value: { cents: c.expected },
        source: "proven",
        note: c.ok ? `the lines give ${money(c.actual)}: they match` : `the lines give ${money(c.actual)}: ${money(c.actual - c.expected)} off`,
      })),
      note: "Printed totals against the lines read under them. A miss means the stub was read wrong, never “close enough”.",
    });

  const ytd = s.lines.filter((l) => l.ytd != null && l.ytd !== 0 && !EMPLOYER_KINDS.has(l.kind));
  if (ytd.length)
    blocks.push({
      kind: "chain",
      title: "Year to date, as printed",
      lines: [
        ...ytd.map((l): ChainLine => ({ label: l.name, value: { cents: l.ytd! }, source: "proven" })),
        ...(p.netYtd != null ? [{ label: "Net pay", value: { cents: p.netYtd }, source: "proven" as const }] : []),
      ],
      note: "Each stub's year to date must carry on from the one before (pay.continuity below).",
    });

  const account = (id: string) => book.accounts.find((a) => a.id === id)?.name ?? "an account";
  const deposit = s.depositTransactionId ? book.rowById.get(s.depositTransactionId) : undefined;
  const went: ProofFact[] = s.deposits.map((x) => ({
    label: `To ••${x.last4 ?? "?"}`,
    text: money(x.amount),
  }));
  went.push(
    deposit
      ? {
          label: "On the bank statement",
          text: `${money(deposit.amountCents)} on ${deposit.date} to ${account(deposit.accountId)}${deposit.amountCents === p.netCurrent ? ": the net pay to the cent" : ""}`,
          link: {
            label: `${account(deposit.accountId)} ${deposit.date}`,
            descriptor: { report: "row", rowId: deposit.id },
          },
          tone: "good",
        }
      : {
          label: "On the bank statement",
          text: "No bank deposit is matched to it (paystub.deposit below says why).",
          tone: "warn",
        },
  );
  blocks.push({ kind: "facts", title: "Where the net pay went", items: went });

  blocks.push({
    kind: "facts",
    title: "The document",
    items: [
      {
        label: "Employee, as printed",
        text: `${s.employee}${s.personId ? ` (${who})` : " (not matched to anyone in the household)"}`,
        tone: s.personId ? undefined : "warn",
      },
      { label: "Employer", text: s.employer },
      { label: "Pay date", text: s.payDate },
      ...(s.periodStart && s.periodEnd ? [{ label: "Pay period", text: `${s.periodStart} – ${s.periodEnd}` }] : []),
      ...(s.federalFilingStatus ? [{ label: "Federal filing status", text: s.federalFilingStatus }] : []),
      { label: "Payroll provider", text: s.source },
      { label: "File", text: s.documentTitle || "—" },
      { label: "Imported", text: s.importedAt.slice(0, 10) },
      ...(s.warnings.length
        ? [
            {
              label: "Reader's notes",
              text: s.warnings.join(" · "),
              tone: "warn" as const,
            },
          ]
        : []),
      {
        label: "Year to date",
        text: `Everything this employer paid ${who} in ${s.payDate.slice(0, 4)} through this stub`,
        link: {
          label: `${who}'s ${s.payDate.slice(0, 4)} pay`,
          descriptor: {
            report: "pay",
            basis: "ytd",
            ...(s.personId ? { personId: s.personId } : {}),
            employerKeys: [s.employerKey],
            lines: ["net"],
            year: Number(s.payDate.slice(0, 4)),
            through: s.payDate,
          },
        },
      },
    ],
  });

  const q = {
    affects: "PAY" as const,
    from: s.payDate,
    to: s.payDate,
    ...(s.personId ? { personId: s.personId } : {}),
    employerKeys: [s.employerKey],
  };
  const found = checksFor(book, q, STUB_CHECKS);
  const partsCents = earnCents - heldCents;
  const continuity = `pay.continuity:${stubRef(s)}`;
  return {
    report: "stub",
    descriptor: d,
    describes: `${who} · ${s.employer} pay stub, ${s.payDate}`,
    figure: { cents: p.netCurrent },
    selfCheck: {
      ok: partsCents === p.netCurrent,
      deltaCents: partsCents - p.netCurrent,
      explain: `The ${earned.length} earning line${earned.length === 1 ? "" : "s"} (${money(earnCents)}) less the ${held.length} tax and deduction line${held.length === 1 ? "" : "s"} (${money(heldCents)}) come to ${money(partsCents)}`,
    },
    withheld: found.withheld,
    blocks,
    checks: found.checks,
    estimates: book.integrity.inferences.filter((i) => i.id === continuity || (deposit && i.rowIds?.includes(deposit.id))).map((i) => ({ id: i.id, title: i.title, detail: i.detail })),
    through: s.payDate,
    today: book.today,
  };
}

export const stubKind: ProofKind<StubDescriptor> = {
  report: "stub",
  parse: parseStubDescriptor,
  build: ({ book }, d) => buildStubProof(book, d),
};
