import { formatUsdFromCents } from "../../formatMoney.ts";
import { CASH_EARNING_KINDS, WITHHELD_KINDS, type StubLineKind } from "../../ingest/payroll/types.ts";
import { stubRef } from "../findingKeys.ts";
import type { Book, BookRow, BookStub } from "../load.ts";
import { netYtd, stubGroups, UNKNOWN_PERSON } from "../pay.ts";
import type { CheckId, Inference } from "../types.ts";
import { checksFor, isIsoDate, sumCheck } from "./common.ts";
import type { ChainLine, Proof, ProofBlock, ProofEstimate, ProofGroup, ProofKind } from "./types.ts";

/**
 * The proof behind a pay figure: the pay stubs it is read from, line by line, the bank
 * deposit each stub was matched to, and every check over that person's pay. Two ways a
 * page reads pay off the stubs, and the proof re-derives each the same way:
 *
 *  - "ytd": a calendar year's pay is the year-to-date figures on each employer's latest
 *    stub of the year (through a cutoff). The proof lists every stub's own check amount
 *    and where the year-to-date figures jump by more than a check (pay before the first
 *    stub on file, paychecks with no stub): those parts are estimates, and a year whose
 *    first stub carries earlier pay is partial.
 *  - "paid": what the stubs paid in a date range, check by check (a bonus paid in a year).
 *
 * Lines name which part of pay: base (regular pay), bonus, gross (cash earnings), net, or
 * deferrals (401(k) and HSA from pay), or one account's part: k401, hsa and the employer's
 * money beside them (employer-k401, employer-hsa); several add up (base + bonus).
 */

export type PayLine = "base" | "bonus" | "gross" | "net" | "deferrals" | "k401" | "hsa" | "employer-k401" | "employer-hsa";

export type PayDescriptor = {
  report: "pay";
  basis: "ytd" | "paid";
  /** A household member's id; "?" for stubs no one is matched to; omitted: everyone. */
  personId?: string;
  /** Employers, as stub employer keys; a key without " #CODE" takes every payroll code under it. Omitted: every employer. */
  employerKeys?: string[];
  lines: PayLine[];
  /** ytd: the calendar year, and the last pay date counted (default: year end). */
  year?: number;
  through?: string;
  /** paid: first and last pay date counted (inclusive). */
  start?: string;
  end?: string;
};

const LINES: Record<PayLine, { label: string; plus: ReadonlySet<StubLineKind>; minus?: ReadonlySet<StubLineKind> }> = {
  base: { label: "Base pay", plus: new Set(["REGULAR", "OTHER_EARNING"]) },
  bonus: { label: "Bonus", plus: new Set(["BONUS"]) },
  gross: { label: "Gross pay", plus: CASH_EARNING_KINDS },
  net: { label: "Net pay", plus: CASH_EARNING_KINDS, minus: WITHHELD_KINDS },
  deferrals: { label: "401(k) and HSA deferrals", plus: new Set(["RETIREMENT_PRETAX", "RETIREMENT_ROTH", "HSA"]) },
  // One account's part of the deferrals, and the employer's money beside it (the Account limits page).
  k401: { label: "401(k) deferrals", plus: new Set(["RETIREMENT_PRETAX", "RETIREMENT_ROTH"]) },
  hsa: { label: "HSA from pay", plus: new Set(["HSA"]) },
  "employer-k401": { label: "Employer 401(k) money", plus: new Set(["EMPLOYER_RETIREMENT"]) },
  "employer-hsa": { label: "Employer HSA money", plus: new Set(["EMPLOYER_HSA"]) },
};

/** The checks that can withhold a pay figure, in the order the drawer lists them. */
export const PAY_CHECKS: CheckId[] = [
  "paystub.arithmetic",
  "paystub.person",
  "paystub.deposit",
  "pay.continuity",
  "pay.after-last-stub",
  "pay.deposits-tie",
  "pay.unexplained-deposits",
  "pay.year-gap",
  "retirement.contributions",
  "ledger.freshness",
];

const kindsOf = (l: PayLine) => [...LINES[l].plus, ...(LINES[l].minus ?? [])];

export function parsePayDescriptor(d: Record<string, unknown>): PayDescriptor | { error: string } {
  if (d.basis !== "ytd" && d.basis !== "paid") return { error: "basis must be ytd or paid." };
  if (!Array.isArray(d.lines) || !d.lines.length || d.lines.some((l) => !Object.hasOwn(LINES, l as string))) return { error: `lines must list some of: ${Object.keys(LINES).join(", ")}.` };
  const lines = [...new Set(d.lines as PayLine[])];
  const seen = new Set<StubLineKind>();
  for (const l of lines)
    for (const k of kindsOf(l)) {
      if (seen.has(k)) return { error: "lines overlap (net and gross already include base and bonus)." };
      seen.add(k);
    }
  if (d.personId != null && (typeof d.personId !== "string" || !d.personId)) return { error: "personId must be an id." };
  if (d.employerKeys != null && (!Array.isArray(d.employerKeys) || d.employerKeys.some((x) => typeof x !== "string" || !x))) return { error: "employerKeys must be a list of keys." };
  const who = {
    ...(d.personId ? { personId: d.personId as string } : {}),
    ...((d.employerKeys as string[] | undefined)?.length ? { employerKeys: d.employerKeys as string[] } : {}),
  };
  if (d.basis === "ytd") {
    if (typeof d.year !== "number" || !Number.isInteger(d.year) || d.year < 1900 || d.year > 2999) return { error: "year must be a calendar year." };
    if (d.through != null && (!isIsoDate(d.through) || !d.through.startsWith(`${d.year}-`))) return { error: "through must be a YYYY-MM-DD date in the year." };
    return { report: "pay", basis: "ytd", ...who, lines, year: d.year, ...(d.through ? { through: d.through as string } : {}) };
  }
  if (!isIsoDate(d.start) || !isIsoDate(d.end)) return { error: "start and end must be YYYY-MM-DD." };
  if (d.start > d.end) return { error: "start is after end." };
  return { report: "pay", basis: "paid", ...who, lines, start: d.start, end: d.end };
}

/** A stub's amount for the descriptor's lines, this check or year to date (cents). */
export function payAmount(s: BookStub, lines: PayLine[], pick: "current" | "ytd"): number {
  let t = 0;
  for (const l of lines) {
    const { plus, minus } = LINES[l];
    for (const x of s.lines) {
      const v = x[pick] ?? 0;
      if (plus.has(x.kind)) t += v;
      else if (minus?.has(x.kind)) t -= v;
    }
  }
  return t;
}

const sameEmployer = (stubKey: string, key: string) => stubKey === key || stubKey.startsWith(`${key} #`);

/** One pay date of an employer's chain: the stubs paid that day, and what they add. */
type PayDay = {
  date: string;
  stubs: BookStub[];
  /** The descriptor's lines, this check (all the day's stubs). */
  paidCents: number;
  /** ytd: how far the year-to-date figures move beyond the day's checks; 0 for "paid". */
  jumpCents: number;
  /** ytd: the year-to-date figure on the day's top stub. */
  ytdCents: number;
  /** What explains a jump: the integrity check's inference, or its open finding. */
  jump: { kind: "before-first" | "inferred" | "unexplained"; title: string; partial: boolean } | null;
};

type Chain = { employer: string; employerKey: string; personId: string; days: PayDay[]; figureCents: number };

export function buildPayProof(book: Book, d: PayDescriptor): Proof {
  const ytd = d.basis === "ytd";
  const from = ytd ? `${d.year}-01-01` : d.start!;
  const to = ytd ? (d.through ?? `${d.year}-12-31`) : d.end!;
  const wantPerson = (s: BookStub) => d.personId == null || (s.personId ?? UNKNOWN_PERSON) === d.personId;
  const wantEmployer = (key: string) => !d.employerKeys?.length || d.employerKeys.some((k) => sameEmployer(key, k));
  const nameOf = (id: string) => book.persons.find((p) => p.id === id)?.name ?? "Unassigned";
  const accountName = new Map(book.accounts.map((a) => [a.id, a.name]));
  const inferenceById = new Map(book.integrity.inferences.map((i) => [i.id, i]));
  const findingById = new Map(book.integrity.findings.map((f) => [f.id, f]));

  const chains: Chain[] = [];
  for (const [key, all] of stubGroups(book)) {
    const [personId, employerKey, y] = key.split("|") as [string, string, string];
    if (!wantEmployer(employerKey) || !wantPerson(all[0]!)) continue;
    if (ytd ? Number(y) !== d.year : y! < from.slice(0, 4) || y! > to.slice(0, 4)) continue;
    const stubs = all.filter((s) => (ytd || s.payDate >= from) && s.payDate <= to);
    if (!stubs.length) continue;
    const byDate = new Map<string, BookStub[]>();
    for (const s of stubs) byDate.set(s.payDate, [...(byDate.get(s.payDate) ?? []), s]);
    const days: PayDay[] = [];
    let prev = 0;
    for (const [date, same] of byDate) {
      // Checks paid the same day print one combined year to date: read it off the day's
      // latest stub in pay order (as personPayYear does); pay.continuity names its finding
      // after the first stub with the largest net year to date.
      const top = same.at(-1)!;
      const named = same.reduce((a, b) => (netYtd(b) > netYtd(a) ? b : a));
      const paidCents = same.reduce((t, s) => t + payAmount(s, d.lines, "current"), 0);
      const ytdCents = ytd ? payAmount(top, d.lines, "ytd") : 0;
      const jumpCents = ytd ? ytdCents - paidCents - prev : 0;
      prev = ytdCents;
      days.push({ date, stubs: same, paidCents, jumpCents, ytdCents, jump: ytd && jumpCents !== 0 ? explainJump(named, days.length === 0) : null });
    }
    // The figure as pages read it: ytd from the latest stub (pay.ts personPayYear), paid check by check.
    const figureCents = ytd ? payAmount(stubs.at(-1)!, d.lines, "ytd") : days.reduce((t, x) => t + x.paidCents, 0);
    chains.push({ employer: stubs.at(-1)!.employer, employerKey, personId, days, figureCents });
  }
  chains.sort((a, b) => a.personId.localeCompare(b.personId) || a.days[0]!.date.localeCompare(b.days[0]!.date));

  function explainJump(top: BookStub, first: boolean): PayDay["jump"] {
    const id = `pay.continuity:${stubRef(top)}`;
    const inf = inferenceById.get(id);
    if (inf) return { kind: first ? "before-first" : "inferred", title: inf.title, partial: !!inf.partial };
    const f = findingById.get(id);
    if (f) return { kind: "unexplained", title: f.title, partial: false };
    // Net pay carries; only these lines' year-to-date figures move (a line printed without its year to date, a correction).
    return { kind: first ? "before-first" : "unexplained", title: first ? `Year-to-date figures on the ${top.payDate} stub include earlier pay` : `Year-to-date figures on the ${top.payDate} stub move by more than its check`, partial: first };
  }

  const figureCents = chains.reduce((t, c) => t + c.figureCents, 0);
  const partsCents = chains.reduce((t, c) => t + c.days.reduce((u, x) => u + x.paidCents + x.jumpCents, 0), 0);
  // A pay date that adds nothing to the figure (no bonus that check) is folded into a note, not listed.
  const listed = (x: PayDay) => x.paidCents !== 0;
  const stubCount = chains.reduce((t, c) => t + c.days.filter(listed).reduce((u, x) => u + x.stubs.length, 0), 0);
  const jumpCents = chains.reduce((t, c) => t + c.days.reduce((u, x) => u + x.jumpCents, 0), 0);
  const partial = chains.some((c) => c.days.some((x) => x.jump?.partial));

  const deposits = new Map<string, BookRow>();
  for (const c of chains) for (const x of c.days) for (const s of x.stubs) if (payAmount(s, d.lines, "current") !== 0 && s.depositTransactionId && book.rowById.has(s.depositTransactionId)) deposits.set(s.id, book.rowById.get(s.depositTransactionId)!);

  const blocks: ProofBlock[] = [];
  const many = new Set(chains.map((c) => `${c.personId}|${c.employerKey}`)).size > 1;
  if (many)
    blocks.push({
      kind: "breakdown",
      title: "By employer",
      items: chains.map((c) => ({
        label: `${d.personId == null ? `${nameOf(c.personId)} · ` : ""}${employerName(c.employer)}`,
        sub: `${c.days.length} pay date${c.days.length === 1 ? "" : "s"}`,
        value: { cents: c.figureCents },
        link: { label: employerName(c.employer), descriptor: { ...d, personId: c.personId, employerKeys: [c.employerKey] } },
      })),
    });
  if (d.lines.length > 1)
    blocks.push({
      kind: "breakdown",
      title: "By part",
      items: d.lines.map((l) => {
        const one = { ...d, lines: [l] };
        return { label: LINES[l].label, value: { cents: chains.reduce((t, c) => t + chainFigure(c, one), 0) }, link: { label: LINES[l].label, descriptor: one } };
      }),
    });
  for (const c of chains) {
    const lines: ChainLine[] = [];
    const quiet = c.days.filter((x) => !listed(x));
    for (const x of c.days) {
      if (x.jumpCents !== 0)
        lines.push({
          op: "+",
          label: x.jump!.kind === "before-first" ? `Before ${x.date}: pay with no stub on file` : `Before ${x.date}: ${x.jump!.kind === "inferred" ? "paychecks with no stub" : "year to date moves without a check"}`,
          value: { cents: x.jumpCents },
          source: "estimate",
          note: `${x.jump!.title}. Taken from the ${x.date} stub's year-to-date figures${x.jump!.partial ? " (partial)" : ""}.`,
        });
      if (!listed(x)) continue;
      const paying = x.stubs.filter((s) => x.stubs.length === 1 || payAmount(s, d.lines, "current") !== 0);
      const stubNote = paying.map((s) => lineItems(s, d.lines)).join(" · ");
      const dep = x.stubs.map((s) => deposits.get(s.id)).filter((r): r is BookRow => !!r);
      const depNote = dep.length
        ? `deposited ${dep.map((r) => `${r.date} ${money(r.amountCents)} to ${accountName.get(r.accountId) ?? "an account"}`).join(", ")}`
        : x.stubs.some((s) => s.depositTransactionId == null)
          ? "no bank deposit matched"
          : "";
      lines.push({
        op: lines.length ? "+" : undefined,
        label: `${x.date} stub${x.stubs.length > 1 ? `s (${x.stubs.length})` : ""}`,
        value: { cents: x.paidCents },
        source: "proven",
        note: [stubNote, ytd ? `year to date ${money(x.ytdCents)}` : "", depNote].filter(Boolean).join(" · "),
        // The stub itself, line by line; it links on to the bank deposit it was matched to.
        link: { label: `${employerName(c.employer)} stub ${x.date}`, descriptor: { report: "stub", stubId: paying[0]!.id } },
      });
    }
    const last = c.days.at(-1)!;
    lines.push({
      op: "=",
      label: ytd ? `Year to date on the ${last.date} stub` : `Paid ${from} – ${to}`,
      value: { cents: c.figureCents },
      source: "proven",
    });
    blocks.push({
      kind: "chain",
      title: `${d.personId == null ? `${nameOf(c.personId)} · ` : ""}${employerName(c.employer)}${ytd ? `, ${d.year}` : ""}`,
      lines,
      note: [
        ytd ? "Each stub's own check, oldest first; the year's figure is the latest stub's year to date." : "Each stub paid in the range, by its pay date. Pay with no stub on file isn't counted.",
        quiet.length ? `${quiet.length} other pay date${quiet.length === 1 ? "" : "s"} (${quiet[0]!.date}${quiet.length > 1 ? ` – ${quiet.at(-1)!.date}` : ""}) paid none of it.` : "",
      ]
        .filter(Boolean)
        .join(" "),
    });
  }
  const depositRows = [...deposits.values()];
  if (depositRows.length)
    blocks.push({
      kind: "rows",
      title: "Bank deposits the stubs were matched to",
      figureCents: depositRows.reduce((t, r) => t + r.amountCents, 0),
      groups: groupRows(book, depositRows),
      note: "The net pay each stub deposited, as the bank statement prints it. Open a row for its statement; open a stub line above for the stub itself.",
    });

  // An employer filter scopes the checks to the stub chains it took (a base key takes every payroll code).
  const chainKeys = [...new Set(chains.map((c) => c.employerKey))];
  const employerKeys = d.employerKeys?.length ? (chainKeys.length ? chainKeys : d.employerKeys) : undefined;
  const q = { affects: "PAY" as const, from, to, ...(d.personId ? { personId: d.personId } : {}), ...(employerKeys ? { employerKeys } : {}) };
  const { checks, withheld } = checksFor(book, q, PAY_CHECKS);
  const estimates = payEstimates(book, chains, d, from, to, new Set(depositRows.map((r) => r.id)));

  const who = d.personId == null ? "Household" : nameOf(d.personId);
  const what = d.lines.map((l) => LINES[l].label).join(" + ");
  const employerPart = d.employerKeys?.length ? ` · ${[...new Set(chains.map((c) => employerName(c.employer)))].join(", ") || d.employerKeys.join(", ")}` : "";
  const span = ytd ? `${d.year}${d.through && d.through < `${d.year}-12-31` ? ` through ${d.through}` : ""}` : from.slice(0, 4) === to.slice(0, 4) && from.endsWith("-01-01") && to.endsWith("-12-31") ? `paid in ${from.slice(0, 4)}` : `paid ${from} – ${to}`;
  return {
    report: "pay",
    descriptor: d,
    describes: `${who} · ${what}, ${span}${employerPart}${partial ? " (partial)" : ""}`,
    figure: { cents: figureCents },
    selfCheck: sumCheck(
      figureCents,
      partsCents,
      `The ${stubCount} stub${stubCount === 1 ? "" : "s"} below add up to ${money(partsCents - jumpCents)}${jumpCents ? `, and ${money(jumpCents)} more is in their year-to-date figures only (estimates), ${money(partsCents)} in all` : ""}`,
    ),
    withheld,
    blocks,
    checks,
    estimates,
    through: chains.flatMap((c) => c.days.map((x) => x.date)).sort().at(-1) ?? to,
    today: book.today,
  };
}

/** A chain's figure for other lines (the "By part" items), read the same way as the figure. */
function chainFigure(c: Chain, d: PayDescriptor): number {
  if (d.basis === "ytd") return payAmount(c.days.at(-1)!.stubs.at(-1)!, d.lines, "ytd");
  return c.days.reduce((t, x) => t + x.stubs.reduce((u, s) => u + payAmount(s, d.lines, "current"), 0), 0);
}

/** Cents as the drawer prints them, zero included. */
const money = (c: number) => (c === 0 ? "$0.00" : formatUsdFromCents(c));

const employerName = (e: string) => e.replace(/ · payroll .*$/, "");

/** The stub lines behind a check's amount, as the stub names them. */
function lineItems(s: BookStub, lines: PayLine[]): string {
  if (lines.includes("net")) return `net pay ${money(payAmount(s, ["net"], "current"))}`;
  const kinds = new Set(lines.flatMap(kindsOf));
  const items = s.lines.filter((l) => kinds.has(l.kind) && (l.current ?? 0) !== 0).map((l) => `${l.name} ${money(l.current!)}`);
  return items.join(", ") || "nothing this check";
}

export function groupRows(book: Book, rows: BookRow[]): ProofGroup[] {
  const statementById = new Map(book.statements.map((s) => [s.id, s]));
  const groups = new Map<string, ProofGroup>();
  for (const r of rows) {
    const account = book.accounts.find((a) => a.id === r.accountId);
    let g = groups.get(r.statementImportId);
    if (!g) {
      const s = statementById.get(r.statementImportId);
      g = {
        statement: {
          id: r.statementImportId,
          account: account?.name ?? "Account",
          institution: account?.institution ?? null,
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
    g.subtotalCents += r.amountCents;
    g.rows.push({
      id: r.id,
      date: r.date,
      bookedOn: r.bookedOn,
      payee: r.payee,
      category: r.category,
      account: account?.name ?? "Account",
      amountCents: r.amountCents,
      countedCents: r.amountCents,
      share: 1,
      precision: r.precision,
    });
  }
  return [...groups.values()].map((g) => ({ ...g, rows: g.rows.sort((a, b) => a.bookedOn.localeCompare(b.bookedOn)) })).sort((a, b) => a.statement.periodStart.localeCompare(b.statement.periodStart));
}

/**
 * What the figure takes on inference: the pay.* inferences about its stubs (year-to-date
 * jumps), those scoped to its person, employer and dates (pay before the first stub on
 * file, paychecks to accounts with no statements), and any about its deposit rows.
 */
function payEstimates(book: Book, chains: Chain[], d: PayDescriptor, from: string, to: string, rowIds: Set<string>): ProofEstimate[] {
  const ids = new Set(chains.flatMap((c) => c.days.flatMap((x) => x.stubs.map((s) => `pay.continuity:${stubRef(s)}`))));
  const keys = new Set(chains.map((c) => c.employerKey));
  const inScope = (i: Inference) =>
    !!i.scope &&
    i.check.startsWith("pay.") &&
    i.scope.from <= to &&
    i.scope.to >= from &&
    (d.personId == null || i.scope.personId == null || i.scope.personId === d.personId) &&
    (!i.scope.employerKey || keys.has(i.scope.employerKey));
  return book.integrity.inferences
    .filter((i) => ids.has(i.id) || inScope(i) || i.rowIds?.some((id) => rowIds.has(id)))
    .map((i) => ({ id: i.id, title: i.title, detail: i.detail }));
}

export const payKind: ProofKind<PayDescriptor> = {
  report: "pay",
  parse: parsePayDescriptor,
  build: ({ book }, d) => buildPayProof(book, d),
};
