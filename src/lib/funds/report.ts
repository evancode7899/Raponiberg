import { addDays } from "../dates/isoDate.ts";
import type { FundCall, FundDoc, FundSource, FundStatement } from "./types.ts";

/** A bank row that moved money to or from a fund manager (an own-account transfer leg). */
export type FundWire = { id: string; date: string; amountCents: number; accountName: string; institution: string };

export type LpAccount = { id: string; name: string; institution: string | null; identifiers: string[] };

export type LpCheck = { label: string; expectedCents: number; actualCents: number; ok: boolean };

export type LpEvent = {
  date: string;
  kind: "CALL" | "EQUALISATION" | "STATEMENT";
  label: string;
  /** Called (gross), handed back (recallable) and interest on it: calls only. */
  calledCents: number;
  returnedCents: number;
  interestCents: number;
  /** What the notice asked to be wired. */
  netDueCents: number;
  /** The bank's wire for it, when the ledger has one. */
  wire: { date: string; amountCents: number; accountName: string } | null;
  /** Unfunded commitment after this event, from the notices on file. */
  unfundedCents: number | null;
  /** The figure the manager printed for the same thing, when it prints one. */
  printedUnfundedCents: number | null;
  /** Capital account (NAV) at a statement. */
  navCents: number | null;
  sources: FundSource[];
};

export type LpFund = {
  key: string;
  fund: string;
  /** The manager (the institution its statements are filed under). */
  manager: string;
  investorId: string | null;
  /** The ledger account its capital statements feed, when there is one. */
  accountId: string | null;
  accountName: string | null;
  commitmentCents: number | null;
  /** Every contribution called, before anything handed back. */
  calledCents: number;
  /** Contributions handed back at later closes: distributed, then added back to unfunded (recallable). */
  returnedCents: number;
  /** Contributions to date after what was handed back: the manager's "contributions inception to date". */
  netContributedCents: number;
  /** Interest the later investors paid on what was handed back. */
  interestCents: number;
  /** Distributions a capital statement reports beyond those on the notices. */
  otherDistributionsCents: number;
  /** Everything the manager has paid out, recycled or not: returned + interest + other. */
  distributedCents: number;
  /** What the manager's own figures print as distributions to date (they may net returns against contributions). */
  printedDistributionsCents: number | null;
  unfundedCents: number | null;
  /** Cash that actually had to be wired: Σ net amounts due. */
  netCashCents: number;
  /** Bank wires to the manager on file, net of any received. */
  wiredCents: number;
  latestNotice: string | null;
  /** The latest capital statement: value, and returns on the money in through its date. */
  statement: {
    asOf: string;
    navCents: number;
    incomeCents: number;
    managementFeeCents: number;
    carryCents: number;
    /** Contributions called through the statement date (gross). */
    paidInCents: number;
    distributedCents: number;
    /** NAV + distributions − paid in. */
    gainCents: number;
    dpi: number | null;
    rvpi: number | null;
    tvpi: number | null;
  } | null;
  /** Calls issued after the latest statement: in the totals, not in its multiples. */
  callsSinceStatement: number;
  events: LpEvent[];
  checks: LpCheck[];
};

/** Notices and statements may be a dollar apart: the manager rounds to whole dollars. */
const TOLERANCE = 100;

const fundKey = (d: FundDoc) => d.investorId ?? d.fund;

type Read = { source: FundSource; doc: FundDoc };

/**
 * One call per fund and issue date: the manager's letter and its ILPA template are two
 * copies of the same notice. The letter's figures win (it prints the commitment summary);
 * the template fills in a breakdown the letter leaves out.
 */
function mergeCalls(xs: { source: FundSource; doc: FundCall }[]): { call: FundCall; sources: FundSource[] }[] {
  const by = new Map<string, { call: FundCall; sources: FundSource[] }>();
  for (const x of [...xs].sort((a, b) => (a.doc.format === b.doc.format ? 0 : a.doc.format === "letter" ? -1 : 1))) {
    const k = x.doc.issued;
    const cur = by.get(k);
    if (!cur) {
      by.set(k, { call: x.doc, sources: [x.source] });
      continue;
    }
    cur.sources.push(x.source);
    if (!cur.call.returnedCents && !cur.call.interestCents && (x.doc.returnedCents || x.doc.interestCents)) {
      cur.call = { ...cur.call, contributionCents: x.doc.contributionCents, returnedCents: x.doc.returnedCents, interestCents: x.doc.interestCents, equalisation: true };
    }
  }
  return [...by.values()];
}

/**
 * The LP view of every private fund on file, from the manager's own documents: the
 * commitment, what has been called (gross, and net of contributions handed back at later
 * closes), everything paid out (recycled or not), interest received, the unfunded
 * commitment, and the latest statement's value and multiples. Each figure is tied back to
 * what the manager printed and to the bank's wires, so a missing notice shows.
 */
export function buildLpFunds(input: { docs: Read[]; accounts: LpAccount[]; wires: FundWire[]; managers?: { statementName: string; institution: string }[] }): LpFund[] {
  const groups = new Map<string, Read[]>();
  for (const r of input.docs) {
    const k = fundKey(r.doc);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const usedWires = new Set<string>();
  const out: LpFund[] = [];
  for (const [key, reads] of groups) {
    const fund = reads.find((r) => r.doc.kind === "STATEMENT")?.doc.fund ?? reads[0]!.doc.fund;
    const investorId = reads.find((r) => r.doc.investorId)?.doc.investorId ?? null;
    const account = investorId ? (input.accounts.find((a) => a.identifiers.includes(investorId)) ?? null) : null;
    const manager = account?.institution ?? input.managers?.find((m) => m.statementName === fund)?.institution ?? fund;

    const calls = mergeCalls(reads.flatMap((r) => (r.doc.kind === "CALL" ? [{ source: r.source, doc: r.doc }] : [])));
    const statements = reads
      .flatMap((r) => (r.doc.kind === "STATEMENT" ? [{ source: r.source, doc: r.doc }] : []))
      .sort((a, b) => a.doc.asOf.localeCompare(b.doc.asOf))
      // A statement saved twice is one quarter.
      .filter((s, i, xs) => i === 0 || xs[i - 1]!.doc.asOf !== s.doc.asOf);

    // The commitment the latest document prints.
    const commitments = [
      ...calls.flatMap((c) => (c.call.printed?.commitmentCents != null ? [{ date: c.call.issued, cents: c.call.printed.commitmentCents }] : [])),
      ...statements.flatMap((s) => (s.doc.commitmentCents != null ? [{ date: s.doc.asOf, cents: s.doc.commitmentCents }] : [])),
    ].sort((a, b) => a.date.localeCompare(b.date));
    const commitment = commitments.at(-1)?.cents ?? null;

    type Item = { date: string; call?: { call: FundCall; sources: FundSource[] }; statement?: { source: FundSource; doc: FundStatement } };
    const items: Item[] = [...calls.map((c): Item => ({ date: c.call.issued, call: c })), ...statements.map((s): Item => ({ date: s.doc.asOf, statement: s }))].sort(
      // A statement closes its day: a call issued that day is in it.
      (a, b) => a.date.localeCompare(b.date) || (a.call ? -1 : 1) - (b.call ? -1 : 1),
    );

    const managerWires = input.wires.filter((w) => w.institution === manager);
    const events: LpEvent[] = [];
    const checks: LpCheck[] = [];
    let called = 0;
    let returned = 0;
    let interest = 0;
    let netCash = 0;
    for (const it of items) {
      if (it.call) {
        const c = it.call.call;
        called += c.contributionCents;
        returned += c.returnedCents;
        interest += c.interestCents;
        netCash += c.netDueCents;
        const unfunded = commitment == null ? null : commitment - (called - returned);
        const wire =
          c.netDueCents > 0
            ? managerWires.find((w) => !usedWires.has(w.id) && w.amountCents === -c.netDueCents && w.date >= c.issued && w.date <= addDays(c.due ?? c.issued, 21))
            : undefined;
        if (wire) usedWires.add(wire.id);
        events.push({
          date: c.issued,
          kind: c.equalisation ? "EQUALISATION" : "CALL",
          label: c.equalisation ? "Equalisation and capital call" : "Capital call",
          calledCents: c.contributionCents,
          returnedCents: c.returnedCents,
          interestCents: c.interestCents,
          netDueCents: c.netDueCents,
          wire: wire ? { date: wire.date, amountCents: -wire.amountCents, accountName: wire.accountName } : null,
          unfundedCents: unfunded,
          printedUnfundedCents: c.printed?.unfundedCents ?? null,
          navCents: null,
          sources: it.call.sources,
        });
        const p = c.printed;
        if (p?.priorContributionsCents != null && p.currentContributionCents != null) {
          checks.push({ label: `${c.issued} notice: contributions to date the manager prints`, expectedCents: p.priorContributionsCents + p.currentContributionCents, actualCents: called - returned, ok: false });
        }
        if (p?.unfundedCents != null && unfunded != null) {
          checks.push({ label: `${c.issued} notice: unfunded commitment the manager prints`, expectedCents: p.unfundedCents, actualCents: unfunded, ok: false });
        }
        if (c.returnedCents || c.interestCents) {
          checks.push({ label: `${c.issued} notice: called − returned − interest = amount due`, expectedCents: c.netDueCents, actualCents: Math.max(0, c.contributionCents - c.returnedCents - c.interestCents), ok: false });
        }
      } else if (it.statement) {
        const s = it.statement.doc;
        const net = called - returned;
        events.push({
          date: s.asOf,
          kind: "STATEMENT",
          label: "Capital statement",
          calledCents: 0,
          returnedCents: 0,
          interestCents: 0,
          netDueCents: 0,
          wire: null,
          unfundedCents: commitment == null ? null : commitment - net,
          printedUnfundedCents: s.remainingCommitmentCents,
          navCents: s.endingCapitalCents,
          sources: [it.statement.source],
        });
        // The statement may count contributions gross or net of what was handed back.
        checks.push({
          label: `${s.asOf} statement: contributions inception to date`,
          expectedCents: s.itd.contributionsCents,
          actualCents: Math.abs(s.itd.contributionsCents - called) <= TOLERANCE ? called : net,
          ok: false,
        });
      }
    }

    const latest = statements.at(-1)?.doc ?? null;
    const throughLatest = (f: (c: FundCall) => number) => calls.filter((c) => latest && c.call.issued <= latest.asOf).reduce((a, c) => a + f(c.call), 0);
    const noticeDistributions = returned + interest;
    const latestNoticeDist = latest ? throughLatest((c) => c.returnedCents + c.interestCents) : 0;
    const other = latest ? Math.max(0, latest.itd.distributionsCents - latestNoticeDist) : 0;
    const lastPrintedCall = [...calls].reverse().find((c) => c.call.printed?.priorDistributionsCents != null);
    const printedDistributions =
      lastPrintedCall && (!latest || lastPrintedCall.call.issued > latest.asOf) ? lastPrintedCall.call.printed!.priorDistributionsCents : (latest?.itd.distributionsCents ?? null);

    let statement: LpFund["statement"] = null;
    if (latest) {
      const paidIn = throughLatest((c) => c.contributionCents);
      const distributed = latestNoticeDist + other;
      const ratio = (n: number) => (paidIn > 0 ? n / paidIn : null);
      statement = {
        asOf: latest.asOf,
        navCents: latest.endingCapitalCents,
        incomeCents: latest.itd.incomeCents,
        managementFeeCents: latest.itd.managementFeeCents,
        carryCents: latest.itd.carryCents,
        paidInCents: paidIn,
        distributedCents: distributed,
        gainCents: latest.endingCapitalCents + distributed - paidIn,
        dpi: ratio(distributed),
        rvpi: ratio(latest.endingCapitalCents),
        tvpi: ratio(latest.endingCapitalCents + distributed),
      };
    }

    const wired = managerWires.reduce((a, w) => a - w.amountCents, 0);
    if (managerWires.length || netCash) checks.push({ label: "Bank wires to the manager = amounts due on the notices", expectedCents: netCash, actualCents: wired, ok: false });

    out.push({
      key,
      fund,
      manager,
      investorId,
      accountId: account?.id ?? null,
      accountName: account?.name ?? null,
      commitmentCents: commitment,
      calledCents: called,
      returnedCents: returned,
      netContributedCents: called - returned,
      interestCents: interest,
      otherDistributionsCents: other,
      distributedCents: noticeDistributions + other,
      printedDistributionsCents: printedDistributions,
      unfundedCents: commitment == null ? null : commitment - (called - returned),
      netCashCents: netCash,
      wiredCents: wired,
      latestNotice: calls.length ? calls.map((c) => c.call.issued).sort().at(-1)! : null,
      statement,
      callsSinceStatement: calls.filter((c) => !latest || c.call.issued > latest.asOf).length,
      events: events.reverse(),
      checks: checks.map((c) => ({ ...c, ok: Math.abs(c.expectedCents - c.actualCents) <= TOLERANCE })),
    });
  }
  return out.sort((a, b) => a.manager.localeCompare(b.manager) || a.fund.localeCompare(b.fund));
}
