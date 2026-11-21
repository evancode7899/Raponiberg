import { careKind, codeCounts, type CareKind } from "./codes.ts";
import { planOn, ROLLING_MONTHS, type HealthPlan, type PlanAmounts, type ServiceLimit } from "./plans.ts";
import type { BalanceKind, Coverage, EobBalance, EobClaim, EobLine, EobStatement, PendingEob, PlanDocument } from "./types.ts";

/**
 * The Medical page's report, pure: every EOB's claims joined into one list (an adjusted
 * claim replaces its earlier version), what each cost and who paid it, the year's
 * deductible and out-of-pocket balances as the insurer last printed them, how much of each
 * capped service is used, and the checks that hold the statements to themselves and to
 * the plan's documents.
 *
 * What a claim cost you is what the EOB says you owe the provider: the claim's "your share"
 * column, or the coordination-of-benefits figure when another plan paid first. What's
 * billed beyond what anyone pays is the network discount and amounts the provider can't
 * charge ("you don't owe this"): billed − plan − other plan − you.
 */

export type ClaimView = Omit<EobClaim, "totals"> & {
  coverage: Coverage;
  file: string;
  statementDate: string;
  /** First and last day of service. */
  firstDate: string;
  lastDate: string;
  /** The calendar year of its first day of service: the year the plan's balances count it in. */
  year: number;
  billedCents: number;
  planCents: number;
  otherPlanCents: number;
  yourShareCents: number;
  writeOffCents: number;
  deductibleCents: number;
  coinsuranceCents: number;
  copayCents: number;
  /** The kind of care most of its billed amount is. */
  kind: CareKind;
  /** Earlier versions this one replaced. */
  earlier: { id: string; file: string; statementDate: string; yourShareCents: number; planCents: number }[];
};

export type Totals = { claims: number; billedCents: number; planCents: number; otherPlanCents: number; yourShareCents: number; writeOffCents: number; deductibleCents: number; coinsuranceCents: number; copayCents: number };

/** A year's claims for one person, provider or kind of care. */
export type Slice = Totals & { key: string; visits: number };

/** The year's balances: each row as the latest statement that prints it (a dental EOB prints only its own patient's). */
export type BalanceSet = { asOf: string; file: string; from: string; to: string; rows: (EobBalance & { asOf: string; file: string })[] };

export type LimitUse = {
  limit: ServiceLimit;
  /** False when the limit names no codes: the claims can't say how much is used. */
  tracked: boolean;
  /** The window counted (a calendar year, the plan year, the last 12 months, all time). */
  from: string;
  to: string;
  /** Each person's uses in the window; a rolling limit that's used up says when the next is covered. */
  people: { person: string; used: number; dates: string[]; nextOn: string | null }[];
};

export type YearView = {
  coverage: Coverage;
  year: number;
  totals: Totals;
  people: Slice[];
  providers: Slice[];
  kinds: Slice[];
  months: { month: string; planCents: number; yourShareCents: number }[];
  balances: BalanceSet | null;
  /** The plan in force at the end of the year (or today, for this year). */
  plan: HealthPlan | null;
  limits: LimitUse[];
};

export type MedicalCheck = { id: string; ok: boolean; subject: string; detail: string; file?: string };

export type StatementView = { file: string; coverage: Coverage; insurer: string; statementDate: string; claims: number; planCents: number; yourShareCents: number };

export type MedicalReport = {
  today: string;
  /** Each coverage the household has documents for, or is waiting on. */
  coverages: { coverage: Coverage; statements: number; pending: number; plans: number; planDocs: number }[];
  years: YearView[];
  claims: ClaimView[];
  statements: StatementView[];
  pending: (PendingEob & { file: string })[];
  plans: HealthPlan[];
  /** Plan documents found in the folder; `read` when a plan on file names it as a source. */
  planDocs: (PlanDocument & { file: string; read: boolean })[];
  /** Each plan's limits as used today (this calendar year, rolling windows to today), by plan id. */
  planLimits: Record<string, LimitUse[]>;
  checks: MedicalCheck[];
};

const sum = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);
const COLUMNS = ["billedCents", "pendingCents", "deductibleCents", "copayCents", "remainingCents", "planCents", "coinsuranceCents", "yourShareCents"] as const;

const totalsOf = (cs: readonly ClaimView[]): Totals => ({
  claims: cs.length,
  billedCents: sum(cs, (c) => c.billedCents),
  planCents: sum(cs, (c) => c.planCents),
  otherPlanCents: sum(cs, (c) => c.otherPlanCents),
  yourShareCents: sum(cs, (c) => c.yourShareCents),
  writeOffCents: sum(cs, (c) => c.writeOffCents),
  deductibleCents: sum(cs, (c) => c.deductibleCents),
  coinsuranceCents: sum(cs, (c) => c.coinsuranceCents),
  copayCents: sum(cs, (c) => c.copayCents),
});

/** Visits: the distinct days a person had care from a provider. */
const visitsOf = (cs: readonly ClaimView[]) => new Set(cs.flatMap((c) => c.lines.map((l) => `${c.patient}|${c.provider}|${l.date}`))).size;

function slices(cs: readonly ClaimView[], key: (c: ClaimView) => string): Slice[] {
  const by = new Map<string, ClaimView[]>();
  for (const c of cs) by.set(key(c), [...(by.get(key(c)) ?? []), c]);
  return [...by].map(([k, xs]) => ({ key: k, ...totalsOf(xs), visits: visitsOf(xs) })).sort((a, b) => b.yourShareCents - a.yourShareCents || b.billedCents - a.billedCents || a.key.localeCompare(b.key));
}

function claimView(c: EobClaim, s: EobStatement, file: string): ClaimView {
  const dates = c.lines.flatMap((l) => [l.date, l.dateTo ?? l.date]).sort();
  const you = c.cob ? c.cob.yourShareCents : c.totals.yourShareCents;
  const plan = c.cob ? c.cob.planAfterCobCents : c.totals.planCents;
  const other = c.cob?.otherPlanCents ?? 0;
  const byKind = new Map<CareKind, number>();
  for (const l of c.lines) byKind.set(careKind(l.code), (byKind.get(careKind(l.code)) ?? 0) + l.billedCents);
  const { totals, ...rest } = c;
  return {
    ...rest,
    coverage: s.coverage,
    file,
    statementDate: s.statementDate,
    firstDate: dates[0]!,
    lastDate: dates.at(-1)!,
    year: Number(dates[0]!.slice(0, 4)),
    billedCents: totals.billedCents,
    planCents: plan,
    otherPlanCents: other,
    yourShareCents: you,
    writeOffCents: totals.billedCents - plan - other - you,
    deductibleCents: totals.deductibleCents,
    coinsuranceCents: totals.coinsuranceCents,
    copayCents: totals.copayCents,
    kind: [...byKind].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Other",
    earlier: [],
  };
}

/** A line the plan covered (it has an allowed amount, or cost sharing against one): a service it refused uses up no covered visits. */
const allowed = (l: EobLine) => l.memberRateCents + l.deductibleCents + l.copayCents + l.planCents + l.coinsuranceCents > 0;

/** The window a limit counts over, for a year's view: a rolling window ends today. */
function limitWindow(l: ServiceLimit, year: number, plan: HealthPlan, today: string): { from: string; to: string } {
  if (l.per === "CALENDAR_YEAR") return { from: `${year}-01-01`, to: `${year}-12-31` };
  if (l.per === "PLAN_YEAR") return { from: plan.coverageFrom, to: plan.coverageTo };
  const months = ROLLING_MONTHS[l.per];
  if (months) return { from: addMonths(today, -months), to: today };
  return { from: "0000-01-01", to: "9999-12-31" };
}

/** A date some months on (or back), its day kept and clamped to the month's end. */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

function limitUse(l: ServiceLimit, claims: readonly ClaimView[], year: number, plan: HealthPlan, today: string): LimitUse {
  const w = limitWindow(l, year, plan, today);
  if (!l.codes?.length) return { limit: l, tracked: false, ...w, people: [] };
  const days = new Map<string, Set<string>>();
  for (const c of claims) {
    if (c.coverage !== plan.coverage) continue;
    for (const ln of c.lines) {
      if (ln.date < w.from || ln.date > w.to || !codeCounts(ln.code, l.codes, l.exceptCodes) || !allowed(ln)) continue;
      const who = l.perPerson === false ? "Family" : c.patient;
      days.set(who, (days.get(who) ?? new Set()).add(ln.date));
    }
  }
  const months = ROLLING_MONTHS[l.per];
  return {
    limit: l,
    tracked: true,
    ...w,
    people: [...days]
      .map(([person, ds]) => {
        const dates = [...ds].sort();
        // A rolling limit that's used up frees a use when the oldest counted one leaves the window.
        const nextOn = months && dates.length >= l.limit ? addMonths(dates[dates.length - l.limit]!, months) : null;
        return { person, used: dates.length, dates, nextOn };
      })
      .sort((a, b) => b.used - a.used || a.person.localeCompare(b.person)),
  };
}

/** Builds the report from every EOB read (by file) and the plans on file. */
export function buildMedicalReport(input: { statements: { file: string; statement: EobStatement }[]; pending: { file: string; doc: PendingEob }[]; planDocs?: { file: string; doc: PlanDocument }[]; plans: HealthPlan[]; today: string }): MedicalReport {
  const { plans, today } = input;
  // The same statement saved twice is one statement: the first file wins.
  const seen = new Set<string>();
  const statements = [...input.statements]
    .sort((a, b) => a.statement.statementDate.localeCompare(b.statement.statementDate) || a.file.localeCompare(b.file))
    .filter(({ statement: s }) => {
      const key = `${s.coverage}|${s.statementDate}|${s.claims.map((c) => c.id).join(",")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  // Every claim version; the highest version of a claim (then the latest statement) stands.
  const versions = statements.flatMap(({ file, statement: s }) => s.claims.map((c) => claimView(c, s, file)));
  const byBase = new Map<string, ClaimView[]>();
  for (const v of versions) byBase.set(`${v.coverage}|${v.baseId}`, [...(byBase.get(`${v.coverage}|${v.baseId}`) ?? []), v]);
  const claims = [...byBase.values()]
    .map((vs) => {
      const sorted = [...vs].sort((a, b) => a.version - b.version || a.statementDate.localeCompare(b.statementDate));
      const last = sorted.at(-1)!;
      return { ...last, earlier: sorted.slice(0, -1).map((e) => ({ id: e.id, file: e.file, statementDate: e.statementDate, yourShareCents: e.yourShareCents, planCents: e.planCents })) };
    })
    .sort((a, b) => b.firstDate.localeCompare(a.firstDate) || b.id.localeCompare(a.id));

  const yearKeys = [...new Set(claims.map((c) => `${c.coverage}|${c.year}`))];
  for (const { statement: s } of statements) if (s.balancesFrom) yearKeys.push(`${s.coverage}|${s.balancesFrom.slice(0, 4)}`);
  const years: YearView[] = [...new Set(yearKeys)]
    .map((k) => {
      const [coverage, y] = k.split("|") as [Coverage, string];
      const year = Number(y);
      const cs = claims.filter((c) => c.coverage === coverage && c.year === year);
      const withBalances = statements.filter(({ statement: s }) => s.coverage === coverage && s.balancesFrom?.startsWith(y) && s.balances.length);
      const bal = withBalances.at(-1);
      const end = `${year}-12-31` < today ? `${year}-12-31` : today;
      const plan = planOn(plans, coverage, end) ?? [...plans].filter((p) => p.coverage === coverage && p.coverageFrom <= end && p.coverageTo >= `${year}-01-01`).sort((a, b) => b.coverageFrom.localeCompare(a.coverageFrom))[0] ?? null;
      const months = new Map<string, { planCents: number; yourShareCents: number }>();
      for (const c of cs) {
        const m = c.firstDate.slice(0, 7);
        const cur = months.get(m) ?? { planCents: 0, yourShareCents: 0 };
        months.set(m, { planCents: cur.planCents + c.planCents, yourShareCents: cur.yourShareCents + c.yourShareCents });
      }
      return {
        coverage,
        year,
        totals: totalsOf(cs),
        people: slices(cs, (c) => c.patient),
        providers: slices(cs, (c) => c.provider || "Provider not printed"),
        kinds: slices(cs, (c) => c.kind),
        months: [...months].map(([month, v]) => ({ month, ...v })).sort((a, b) => a.month.localeCompare(b.month)),
        balances: bal ? { asOf: bal.statement.statementDate, file: bal.file, from: bal.statement.balancesFrom!, to: bal.statement.balancesTo!, rows: latestBalances(withBalances) } : null,
        plan,
        limits: plan ? plan.limits.map((l) => limitUse(l, claims, year, plan, today)) : [],
      };
    })
    .sort((a, b) => b.year - a.year || a.coverage.localeCompare(b.coverage));

  return {
    today,
    coverages: (["MEDICAL", "DENTAL", "VISION"] as const).map((coverage) => ({
      coverage,
      statements: statements.filter((s) => s.statement.coverage === coverage).length,
      pending: input.pending.filter((p) => p.doc.coverage === coverage).length,
      plans: plans.filter((p) => p.coverage === coverage).length,
      planDocs: (input.planDocs ?? []).filter((d) => d.doc.coverage === coverage).length,
    })),
    years,
    claims,
    statements: statements
      .map(({ file, statement: s }) => {
        const vs = versions.filter((v) => v.file === file);
        return { file, coverage: s.coverage, insurer: s.insurer, statementDate: s.statementDate, claims: s.claims.length, planCents: sum(vs, (v) => v.planCents), yourShareCents: sum(vs, (v) => v.yourShareCents) };
      })
      .reverse(),
    pending: input.pending.map((p) => ({ ...p.doc, file: p.file })).sort((a, b) => (b.statementDate ?? "").localeCompare(a.statementDate ?? "")),
    plans,
    planDocs: (input.planDocs ?? []).map((d) => ({ ...d.doc, file: d.file, read: plans.some((p) => p.sources.some((s) => s.file === d.file)) })).sort((a, b) => a.coverage.localeCompare(b.coverage) || a.file.localeCompare(b.file)),
    planLimits: Object.fromEntries(plans.map((p) => [p.id, p.limits.map((l) => limitUse(l, claims, Number(today.slice(0, 4)), p, today))])),
    checks: [...statements.flatMap(({ file, statement }) => statementChecks(file, statement)), ...planChecks(statements, plans)],
  };
}

/** Each claim's lines add to its totals, and the payment summary is its claims, provider by provider. */
export function statementChecks(file: string, s: EobStatement): MedicalCheck[] {
  const subject = `${s.insurer} EOB of ${s.statementDate}`;
  const off: string[] = [];
  for (const c of s.claims)
    for (const k of COLUMNS) {
      if (k === "yourShareCents" && c.cob) continue; // COB lines print "See below": the claim's share is the COB figure
      const lines = sum(c.lines, (l: EobLine) => l[k]);
      if (lines !== c.totals[k]) off.push(`claim ${c.id}: its lines add to ${lines / 100} in ${k.replace("Cents", "")}, its totals say ${c.totals[k] / 100}`);
    }
  const owed = (c: EobClaim) => (c.cob ? c.cob.yourShareCents : c.totals.yourShareCents);
  const summary = new Map<string, number>();
  // Keyed by patient and provider; each key's words are kept beside it, so a name is never split back out of a key.
  const label = new Map<string, string>();
  const keyOf = (patient: string, provider: string) => {
    const k = JSON.stringify([patient, provider]);
    label.set(k, `${patient} at ${provider}`);
    return k;
  };
  for (const p of s.payments) {
    const k = keyOf(p.patient, p.provider);
    summary.set(k, (summary.get(k) ?? 0) + p.yourShareCents);
  }
  const fromClaims = new Map<string, number>();
  for (const c of s.claims) {
    const row = s.payments.find((p) => p.patient === c.patient && p.provider === c.provider) ?? s.payments.find((p) => p.patient === c.patient && !!c.provider && p.provider.startsWith(c.provider));
    const key = row ? keyOf(row.patient, row.provider) : keyOf(c.patient, c.provider);
    fromClaims.set(key, (fromClaims.get(key) ?? 0) + owed(c));
  }
  const tie: string[] = [];
  for (const k of new Set([...summary.keys(), ...fromClaims.keys()])) {
    const a = summary.get(k) ?? 0;
    const b = fromClaims.get(k) ?? 0;
    if (a !== b) tie.push(`${label.get(k)}: the summary says ${a / 100}, the claims ${b / 100}`);
  }
  return [
    { id: `medical.lines:${file}`, ok: !off.length, subject, file, detail: off.length ? off.join("; ") : `Each of its ${s.claims.length} claims' service lines add up to the claim's totals.` },
    { id: `medical.summary:${file}`, ok: !tie.length, subject, file, detail: tie.length ? tie.join("; ") : "What you owe in the payment summary is its claims, provider by provider." },
  ];
}

/** The plan's deductible, out-of-pocket limit and annual maximum are the ones its EOBs count against. */
export function planChecks(statements: { file: string; statement: EobStatement }[], plans: HealthPlan[]): MedicalCheck[] {
  return plans.flatMap((p) => {
    const within = statements.filter(({ statement: s }) => s.coverage === p.coverage && s.balances.length && p.coverageFrom <= s.statementDate && s.statementDate <= p.coverageTo);
    const last = within.at(-1);
    if (!last) return [];
    const rows = latestBalances(within);
    const sets: [string, BalanceKind, PlanAmounts | null | undefined, boolean][] = [
      ["deductible", "DEDUCTIBLE", p.deductible?.inNetwork, true],
      ["deductible", "DEDUCTIBLE", p.deductible?.outOfNetwork, false],
      ["out-of-pocket limit", "OUT_OF_POCKET", p.outOfPocket?.inNetwork, true],
      ["out-of-pocket limit", "OUT_OF_POCKET", p.outOfPocket?.outOfNetwork, false],
      ["annual maximum", "ANNUAL_MAXIMUM", p.annualMaximum, true],
    ];
    const off: string[] = [];
    const held: string[] = [];
    for (const [label, kind, amounts, inNetwork] of sets) {
      for (const b of rows.filter((r) => r.kind === kind && r.inNetwork === inNetwork)) {
        const want = b.person == null ? amounts?.familyCents : amounts?.individualCents;
        const what = `${inNetwork ? "" : "out-of-network "}${b.person == null ? "family " : ""}${label}`;
        if (want == null) off.push(`${what}: the EOB of ${b.asOf} prints ${b.limitCents / 100}${b.person ? ` (${b.person})` : ""}, the plan file has none`);
        else if (want !== b.limitCents) off.push(`${what}: the plan file says ${want / 100}, the EOB of ${b.asOf} ${b.limitCents / 100}${b.person ? ` (${b.person})` : ""}`);
        else held.push(label);
      }
    }
    const names = [...new Set(held)];
    return [{ id: `medical.plan:${p.id}`, ok: !off.length, subject: p.name, file: last.file, detail: off.length ? off.join("; ") : names.length ? `Its ${names.join(", ")} ${names.length === 1 ? "is" : "are"} the ones its EOBs count against (latest ${last.statement.statementDate}).` : "Its EOBs print no limits to hold it to." }];
  });
}

/** The latest printed row of each balance (person, benefit, network, kind) across statements, oldest first: a dental EOB prints only its own patient's. */
export function latestBalances(statements: readonly { file: string; statement: EobStatement }[]): (EobBalance & { asOf: string; file: string })[] {
  const by = new Map<string, EobBalance & { asOf: string; file: string }>();
  for (const { file, statement: s } of statements) for (const b of s.balances) by.set(`${b.person ?? ""}|${b.benefit}|${b.inNetwork}|${b.kind}`, { ...b, asOf: s.statementDate, file });
  return [...by.values()];
}
