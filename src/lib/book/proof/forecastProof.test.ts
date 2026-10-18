import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Lane } from "../../classifier/taxonomy";
import { NO_HOUSEHOLD } from "../../household/patterns";
import { employerKey, type StubLine } from "../../ingest/payroll/types";
import { groupFor, refreshLedgerStatus, type LedgerAccount } from "../../ledger/loadLedger";
import { buildTimeline, type SegmentInput } from "../../ledger/timeline";
import { buildForecast } from "../../forecast/forecast";
import { forecastInputs, loadForecastData, type ForecastData } from "../../forecast/load";
import { expenseFingerprint } from "../../profile/annualMath";
import { resolveBasePay } from "../../profile/basePay";
import { DEFAULT_SETTINGS, PROFILE_SETTINGS_KEY, type FinancialProfileSettings } from "../../profile/settings";
import { TAX_YEARS } from "../../tax/params";
import type { Book, BookRow, BookStatement, BookStub } from "../load";
import { buildForecastProof, LEDGER_LINES, ledgerValue, parseForecastDescriptor, type ForecastDescriptor, type LedgerLine } from "./forecastProof";
import { monthPeriods, yearPeriods, type Period } from "../../forecast/periods";
import { buildProof, parseDescriptor, type Proof, type ProofLink } from "./index";
import type { ChainLine } from "./types";

// An invented household: Pat Example, paid every other Friday by Example Partners LP into
// checking ••1234 at Springfield Bank, with a card ••5678, a brokerage ••2468 and a 401(k),
// Jan 2025 – Mar 2026. Every name and amount is made up.

process.env.BONUS_AWARDS_FILE = path.join(__dirname, "no-such-bonus-awards.json");

const TODAY = "2026-04-20";
const EDGE = "2026-03-31";
const EMPLOYER = "Example Partners LP";
const MONTHS = Array.from({ length: 15 }, (_, i) => {
  const y = 2025 + Math.floor(i / 12);
  const m = (i % 12) + 1;
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  return { start, end: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
});

type Flow = { date: string; cents: number; lane: Lane; payee: string; category: string };

const flows: Record<string, Flow[]> = { chk: [], card: [], brk: [], ret: [] };
const add = (account: string, date: string, cents: number, lane: Lane, payee: string, category: string) => flows[account]!.push({ date, cents, lane, payee, category });

for (const { start } of MONTHS) {
  const ym = start.slice(0, 7);
  add("chk", `${ym}-01`, -210_000, "EXPENSE", "SPRINGFIELD PROPERTY MGMT", "Rent");
  add("chk", `${ym}-10`, -61_234, "EXPENSE", "SPRINGFIELD GROCER", "Groceries");
  add("card", `${ym}-15`, -34_567, "EXPENSE", "EXAMPLE DINER", "Restaurants");
  add("card", `${ym}-25`, 34_567, "TRANSFER", "PAYMENT THANK YOU", "Transfer");
  add("chk", `${ym}-25`, -34_567, "TRANSFER", "CARD PAYMENT", "Transfer");
}
// Tax payments, one-offs and a reimbursement.
add("chk", "2025-04-15", -123_400, "EXPENSE", "IRS USATAXPYMT", "Taxes");
add("chk", "2026-01-15", -98_700, "EXPENSE", "IRS USATAXPYMT", "Taxes");
add("chk", "2025-06-12", -180_000, "EXPENSE", "SPRINGFIELD FURNITURE", "Home");
add("chk", "2026-02-10", -95_000, "EXPENSE", "EXAMPLE TRAVEL CO", "Travel");
add("chk", "2025-08-05", 15_000, "INCOME", "ZELLE FROM SAM SAMPLE", "P2P & reimbursements");

// Pay: every other Friday from Jan 3, 2025; a raise in 2026, a bonus each March, one check after the edge.
type Check = { regular: number; bonus: number; reimb: number };
const PAY: [string, Check][] = [];
for (let d = Date.UTC(2025, 0, 3); d <= Date.UTC(2026, 3, 10); d += 14 * 86_400_000) {
  const date = new Date(d).toISOString().slice(0, 10);
  const regular = date >= "2026-03-27" ? 410_000 : date >= "2026-01-01" ? 400_000 : 384_615;
  const bonus = date === "2025-03-14" ? 500_000 : date === "2026-04-10" ? 250_000 : 0;
  PAY.push([date, { regular, bonus, reimb: date === "2025-05-09" ? 7_500 : 0 }]);
}

const statements: BookStatement[] = [];
const rows: BookRow[] = [];
const stubs: BookStub[] = [];

let n = 0;
{
  const ytd = { regular: 0, bonus: 0, reimb: 0, fed: 0, k401: 0, hsa: 0, s125: 0, er: 0 };
  let year = "2025";
  for (const [payDate, c] of PAY) {
    if (payDate.slice(0, 4) !== year) {
      year = payDate.slice(0, 4);
      for (const k of Object.keys(ytd) as (keyof typeof ytd)[]) ytd[k] = 0;
    }
    const cur = { ...c, fed: Math.round((c.regular + c.bonus) * 0.18), k401: Math.round(c.regular * 0.06), hsa: 15_000, s125: 21_000, er: Math.round(c.regular * 0.04) };
    for (const k of Object.keys(ytd) as (keyof typeof ytd)[]) ytd[k] += cur[k];
    const net = cur.regular + cur.bonus + cur.reimb - cur.fed - cur.k401 - cur.hsa - cur.s125;
    const line = (name: string, kind: StubLine["kind"], k: keyof typeof ytd): StubLine => ({ name, kind, current: cur[k] || null, ytd: ytd[k] });
    let depositId: string | null = null;
    if (payDate <= EDGE) {
      depositId = `pay-${payDate}`;
      flows.chk!.push({ date: payDate, cents: net, lane: "INCOME", payee: "EXAMPLE PARTNERS LP PAYROLL", category: "Paycheck" });
    }
    stubs.push({
      id: `s${++n}`,
      documentId: `d${n}`,
      documentTitle: `stub ${payDate}.pdf`,
      importedAt: "2026-04-15T00:00:00Z",
      source: "TRINET",
      employee: "PAT EXAMPLE",
      employer: EMPLOYER,
      employerKey: employerKey(EMPLOYER),
      personId: "pat",
      payDate,
      periodStart: new Date(Date.parse(payDate) - 18 * 86_400_000).toISOString().slice(0, 10),
      periodEnd: new Date(Date.parse(payDate) - 5 * 86_400_000).toISOString().slice(0, 10),
      federalFilingStatus: null,
      lines: [
        line("Regular Salary", "REGULAR", "regular"),
        line("Annual Bonus", "BONUS", "bonus"),
        line("Expense Reimbursement", "NONTAXABLE", "reimb"),
        line("Federal Income Tax", "FEDERAL_TAX", "fed"),
        line("401(k)", "RETIREMENT_PRETAX", "k401"),
        line("HSA", "HSA", "hsa"),
        line("Medical", "SECTION125", "s125"),
        line("401(k) Match", "EMPLOYER_RETIREMENT", "er"),
      ],
      printed: { grossCurrent: null, grossYtd: null, withheldCurrent: null, withheldYtd: null, netCurrent: net, netYtd: null },
      deposits: [{ last4: "1234", amount: net }],
      warnings: [],
      depositTransactionId: depositId,
    });
  }
}

const ACCOUNTS = [
  { id: "chk", name: "Pat's checking ••1234", type: "CHECKING", subtype: "CHECKING", open: 1_500_000 },
  { id: "card", name: "Pat's card ••5678", type: "CREDIT_CARD", subtype: "CREDIT_CARD", open: 0 },
  { id: "brk", name: "Example brokerage ••2468", type: "INVESTMENT", subtype: "BROKERAGE", open: 5_000_000 },
  { id: "ret", name: "Example 401(k)", type: "INVESTMENT", subtype: "401K", open: 3_000_000 },
];

const ledgerAccounts: LedgerAccount[] = ACCOUNTS.map((a) => {
  const segs: SegmentInput[] = [];
  let bal = a.open;
  for (const m of MONTHS) {
    const id = `st-${a.id}-${m.start}`;
    const mine = flows[a.id]!.filter((f) => f.date >= m.start && f.date <= m.end);
    const growth = a.type === "INVESTMENT" ? Math.round(bal * 0.005) : 0;
    const open = bal;
    bal += mine.reduce((t, f) => t + f.cents, 0) + growth;
    statements.push({ id, accountId: a.id, documentId: `doc-${id}`, documentTitle: `${a.id}-${m.start}.pdf`, importedAt: "2026-04-15T00:00:00.000Z", status: "COMMITTED", isSummary: false, periodStart: m.start, periodEnd: m.end, deltaCents: 0 });
    segs.push({
      accountId: a.id,
      importId: id,
      periodStart: m.start,
      periodEnd: m.end,
      openingCents: open,
      closingCents: bal,
      growthCents: growth,
      feesCents: 0,
      flows: mine.map((f, i) => {
        const rowId = f.category === "Paycheck" ? `pay-${f.date}` : `r-${a.id}-${f.date}-${i}`;
        rows.push({
          id: rowId,
          date: f.date,
          precision: "EXACT",
          statement: { start: m.start, end: m.end },
          bookedOn: f.date,
          amountCents: f.cents,
          lane: f.lane,
          accountId: a.id,
          payee: f.payee,
          merchantKey: null,
          category: f.category,
          categoryGroup: null,
          counterpartyKind: null,
          counterpartyInstitution: null,
          counterpartyAccountHint: null,
          classifiedBy: null,
          transferMatchId: null,
          statementImportId: id,
          documentId: `doc-${id}`,
        });
        return { id: rowId, date: f.date, precision: "EXACT" as const, amountCents: f.cents, lane: f.lane };
      }),
    });
  }
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    institution: "Springfield Bank",
    subtype: a.subtype as LedgerAccount["subtype"],
    group: groupFor(a.subtype, a.type),
    isInvestment: a.type === "INVESTMENT",
    timeline: buildTimeline(a.id, segs, []),
    statementCount: segs.length,
    closed: false,
  };
});

function makeBook(): Book {
  const ledger = { accounts: ledgerAccounts, mergeDate: "2024-12-01", completeThrough: null, firstDay: null };
  refreshLedgerStatus(ledger, TODAY);
  return {
    today: TODAY,
    horizon: { cashFlow: EDGE, netWorth: EDGE },
    ledger,
    accounts: ledgerAccounts.map((a) => ({ id: a.id, name: a.name, institution: a.institution, type: a.type, subtype: a.subtype, group: a.group, identifiers: [] })),
    statements,
    rows,
    rowById: new Map(rows.map((r) => [r.id, r])),
    stubs,
    brokerage: [],
    holdings: [],
    matches: [],
    documents: [],
    decisions: { version: 1, confirmed: [], rejected: [] },
    classifiedWith: null,
    household: NO_HOUSEHOLD,
    classifiedWithHousehold: null,
    taxProfile: {
      version: 1,
      persons: [{ id: "pat", name: "Pat Example", match: ["PAT EXAMPLE"] }],
      dependents: [],
      accountOwners: {},
      accountKinds: {},
      qualifiedDividendShare: 1,
      moneyMarketUsGovShare: 0,
      mfsDependentClaimant: "AUTO",
      years: {},
    },
    taxDocs: null,
    persons: [{ id: "pat", name: "Pat Example", match: ["PAT EXAMPLE"] }],
    idle: { proven: [], unproven: [] },
    integrity: { checks: [], findings: [], inferences: [], accepted: [], stale: [], retired: [] },
    passes: [],
  } as unknown as Book;
}

const furniture = rows.find((r) => r.payee === "SPRINGFIELD FURNITURE")!;
const travel = rows.find((r) => r.payee === "EXAMPLE TRAVEL CO")!;

/** The owner's saved settings: two tagged one-offs; `outlook` patched per test. */
function settings(outlook: Partial<FinancialProfileSettings["outlook"]> = {}): FinancialProfileSettings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    birthYears: { pat: 1990 },
    oneOffs: { [expenseFingerprint(furniture)]: "New sofa", [expenseFingerprint(travel)]: "" },
    outlook: { ...structuredClone(DEFAULT_SETTINGS.outlook), ...outlook },
  };
}

const fakeDb = (s: FinancialProfileSettings) =>
  ({ appSetting: { findUnique: async ({ where }: { where: { key: string } }) => (where.key === PROFILE_SETTINGS_KEY ? { value: JSON.stringify(s) } : null) } }) as never;

type SeedDescriptor = Extract<ForecastDescriptor, { figure: "seed" }>;
const seed = (x: Record<string, unknown>) => ({ report: "forecast", figure: "seed", ...x }) as SeedDescriptor;

const DESCRIPTORS: SeedDescriptor[] = [
  seed({ which: "start" }),
  seed({ which: "pay", personId: "pat", paycheck: "LATEST" }),
  seed({ which: "pay", personId: "pat", paycheck: "TYPICAL" }),
  seed({ which: "deferrals" }),
  seed({ which: "employer", paycheck: { pat: "LATEST" } }),
  seed({ which: "take-home" }),
  seed({ which: "living", basis: "TRAILING_12" }),
  seed({ which: "living", basis: "LAST_YEAR" }),
  seed({ which: "living", basis: "THIS_YEAR" }),
  seed({ which: "return" }),
  seed({ which: "bonus" }),
];

const chains = (p: Proof) => p.blocks.flatMap((b) => (b.kind === "chain" ? [b] : []));
const links = (p: Proof): (ProofLink & { value?: ChainLine["value"]; source?: ChainLine["source"] })[] =>
  p.blocks.flatMap((b) =>
    b.kind === "breakdown"
      ? b.items.flatMap((i) => (i.link ? [{ ...i.link, value: i.value }] : []))
      : b.kind === "chain"
        ? b.lines.flatMap((l) => (l.link ? [{ ...l.link, value: l.value, source: l.source }] : []))
        : [],
  );

/** Every money step of a chain (lines up to each "=") re-adds to the "=" line. */
function reAdds(lines: ChainLine[]): string[] {
  const bad: string[] = [];
  let acc: number | null = null;
  let additive = true;
  for (const l of lines) {
    const cents = "cents" in l.value ? l.value.cents : null;
    if (l.op === "=") {
      if (additive && acc != null && cents != null && acc !== cents) bad.push(`${l.label}: parts ${acc} ≠ ${cents}`);
      acc = cents;
      additive = true;
    } else if (l.op === "×" || l.op === "÷" || cents == null) additive = false;
    else if (l.op === "−") acc = (acc ?? 0) - cents;
    else if (l.op === "+" || acc == null) acc = (acc ?? 0) + cents;
    else additive = false; // a second line without an op: a list, not a sum
  }
  return bad;
}

describe("forecast seed proofs", () => {
  const book = makeBook();
  let data: ForecastData;
  const ctx = (s = settings()) => ({ book, db: fakeDb(s) });
  beforeAll(async () => {
    data = await loadForecastData(fakeDb(settings()), book);
  });

  it("starts from proven seeds on the invented household", () => {
    expect(data.profile.seedBlockers).toEqual([]);
    const s = data.profile.seeds!;
    expect(s.start.asOf).toBe(EDGE);
    expect(Object.keys(s.living).sort()).toEqual(["LAST_YEAR", "THIS_YEAR", "TRAILING_12"]);
    expect(s.people[0]!.latest?.payDate).not.toBe(s.people[0]!.typical?.payDate);
  });

  it("proves each seed: the figure is the page's, and every money step re-adds", async () => {
    const s = data.profile.seeds!;
    const a = data.profile.settings.outlook;
    const pay = resolveBasePay(s, a, TAX_YEARS[s.taxYear]!);
    const page: Record<string, Proof["figure"]> = {
      start: { cents: s.start.liquid + s.start.illiquid },
      deferrals: { cents: pay.people.reduce((t, p) => t + p.deferrals, 0) },
      "take-home": { ratio: pay.computedRate },
      return: { ratio: s.realizedReturn! },
    };
    for (const d of DESCRIPTORS) {
      const p = await buildProof(ctx(), d);
      const label = JSON.stringify(d);
      expect(p.report, label).toBe("forecast");
      if (p.selfCheck) expect(p.selfCheck, label).toMatchObject({ ok: true, deltaCents: 0 });
      for (const c of chains(p)) expect(reAdds(c.lines), `${label} ${c.title}`).toEqual([]);
      if (d.which in page) expect(p.figure, label).toEqual(page[d.which]);
      if (d.which === "living") expect(p.figure).toEqual({ cents: s.living[d.basis]!.cents });
      if (d.which === "pay") {
        const check = d.paycheck === "LATEST" ? s.people[0]!.latest! : s.people[0]!.typical!;
        expect(p.figure).toEqual({ cents: check.regular * s.people[0]!.perYear });
      }
    }
  });

  it("re-derives the starting net worth from each side's net-worth proof", async () => {
    const p = await buildProof(ctx(), seed({ which: "start" }));
    const sides = links(p);
    expect(sides.map((l) => l.descriptor.report)).toEqual(["net-worth", "net-worth"]);
    expect(p.selfCheck?.explain).toMatch(/^The accounts' balances on 2026-03-31/);
  });

  it("lists the living cost's tagged one-offs and tax payments, from Cash flow's spending", async () => {
    const p = await buildProof(ctx(), seed({ which: "living", basis: "LAST_YEAR" }));
    const lines = chains(p)[0]!.lines;
    expect(lines[0]!.link?.descriptor).toEqual({ report: "cash-flow", metric: "spending", granularity: "year", start: "2025-01-01", end: "2025-12-31" });
    expect(lines.find((l) => l.label === "2025-06-12 SPRINGFIELD FURNITURE")).toMatchObject({ op: "−", value: { cents: 180_000 }, source: "proven" });
    expect(lines.find((l) => l.label.startsWith("Tax payments"))).toMatchObject({ value: { cents: 123_400 } });
    expect(lines.find((l) => l.label.startsWith("Reimbursements received"))).toMatchObject({ value: { cents: 15_000 } });
    expect(lines.find((l) => l.label.startsWith("Reimbursements paid inside"))).toMatchObject({ value: { cents: 7_500 } });
    // The year in progress: annualized, with its own one-off.
    const t = await buildProof(ctx(), seed({ which: "living", basis: "THIS_YEAR" }));
    expect(chains(t)[0]!.lines.map((l) => l.label)).toEqual(expect.arrayContaining(["2026-02-10 EXAMPLE TRAVEL CO", "365 ÷ 90 days"]));
  });

  it("emits links that parse, build, and open the figure the line shows", async () => {
    const c = ctx();
    let followed = 0;
    for (const d of DESCRIPTORS) {
      const p = await buildProof(c, d);
      for (const l of links(p)) {
        const parsed = parseDescriptor(JSON.parse(JSON.stringify(l.descriptor)));
        expect(parsed, `${l.label} from ${JSON.stringify(d)}`).not.toHaveProperty("error");
        const q = await buildProof(c, parsed as never);
        if (q.selfCheck) expect(q.selfCheck.ok, l.label).toBe(true);
        if (l.value && "cents" in l.value && "cents" in q.figure && l.source !== "assumption" && l.descriptor.report !== "forecast") expect(q.figure.cents, `${l.label} from ${JSON.stringify(d)}`).toBe(l.value.cents);
        followed++;
      }
    }
    expect(followed).toBeGreaterThan(15);
  });

  it("links each paycheck to its pay proof and the deferrals to the stubs' year to date", async () => {
    const p = await buildProof(ctx(), seed({ which: "pay", personId: "pat", paycheck: "TYPICAL" }));
    const ls = links(p);
    expect(ls[0]!.descriptor).toMatchObject({ report: "pay", basis: "paid", personId: "pat", lines: ["base"] });
    expect(p.blocks.some((b) => b.kind === "breakdown" && b.title.startsWith("The last regular checks"))).toBe(true);
    const def = chains(p).find((b) => b.title.startsWith("Your 401(k)"))!;
    expect(def.lines[0]!.link?.descriptor).toMatchObject({ report: "pay", basis: "ytd", lines: ["deferrals"], year: 2026, through: "2026-04-10" });
    expect(def.lines.some((l) => l.source === "estimate")).toBe(true);
  });

  it("marks what the owner typed as an assumption, the seed beside it", async () => {
    const s = settings({ livingCost: 7_000_000, livingBasis: "LAST_YEAR", people: { pat: { paycheck: "LATEST", salary: 12_000_000, bonusPct: null } }, takeHomeRate: 0.6 });
    const living = await buildProof(ctx(s), seed({ which: "living", basis: "LAST_YEAR" }));
    const typed = chains(living).find((b) => b.title === "In the forecast")!.lines[0]!;
    expect(typed).toMatchObject({ label: "Living cost you typed", value: { cents: 7_000_000 }, source: "assumption" });
    expect(typed.note).toContain(`$`);
    const pay = await buildProof(ctx(s), seed({ which: "pay", personId: "pat", paycheck: "LATEST" }));
    expect(chains(pay).find((b) => b.title === "In the forecast")!.lines[0]).toMatchObject({ label: "Base salary you typed", value: { cents: 12_000_000 }, source: "assumption" });
    const th = await buildProof(ctx(s), seed({ which: "take-home" }));
    expect(chains(th)[0]!.lines[0]).toMatchObject({ value: { cents: 12_000_000 }, source: "assumption" });
    expect(chains(th).find((b) => b.title === "In the forecast")!.lines[0]).toMatchObject({ value: { ratio: 0.6 }, source: "assumption" });
    expect(chains(th).find((b) => b.title === "Law and settings")!.lines[0]).toMatchObject({ label: "Tax law year", source: "law" });
  });

  it("lists bonuses paid on stubs after the start and the estimates still to come", async () => {
    const p = await buildProof(ctx(), seed({ which: "bonus" }));
    const paid = p.blocks.find((b) => b.kind === "breakdown" && b.title.startsWith("Paid on stubs"));
    expect(paid?.kind === "breakdown" && paid.items.map((i) => [i.label, i.value])).toEqual([["2026-04-10", { cents: 250_000 }]]);
    const f = buildForecast(forecastInputs(data)!, data.profile.settings.outlook);
    expect(p.figure).toEqual({ text: expect.stringMatching(/^1 on stubs · 0 from letters · /) });
    expect(f.schedule.some((b) => b.source === "ESTIMATE")).toBe(true);
  });

  it("withholds every seed when the starting point isn't proven", () => {
    const blocked = { ...data, profile: { ...data.profile, seeds: null, seedBlockers: [{ id: "x", status: "MISSING" as const, title: "No complete year on file yet", fix: "" }] } };
    const p = buildForecastProof(book, blocked as ForecastData, seed({ which: "start" }));
    expect(p).toMatchObject({ withheld: true, selfCheck: null, figure: { text: "Withheld" } });
  });

  it("parses seeds and leaves room for a month's cell", () => {
    expect(parseForecastDescriptor({ report: "forecast", figure: "month", key: "2027-03" })).toHaveProperty("error");
    expect(parseForecastDescriptor({ report: "forecast", figure: "seed", which: "living", basis: "NEXT_YEAR" })).toHaveProperty("error");
    expect(parseForecastDescriptor({ report: "forecast", figure: "seed", which: "deferrals", paycheck: { pat: "SOMETIMES" } })).toHaveProperty("error");
    expect(parseDescriptor({ report: "forecast", figure: "seed", which: "pay", personId: "pat", paycheck: "TYPICAL" })).toEqual({ report: "forecast", figure: "seed", which: "pay", personId: "pat", paycheck: "TYPICAL" });
  });
});

describe("forecast ledger cells", () => {
  const book = makeBook();
  const ctx = (s = settings()) => ({ book, db: fakeDb(s) });
  const LINES = Object.keys(LEDGER_LINES) as LedgerLine[];
  const descOf = (p: Period, line: LedgerLine) => parseForecastDescriptor({ report: "forecast", figure: "month", month: p.from, through: p.through.slice(0, 7), line }) as ForecastDescriptor;
  /** Every link with the line (or item) it sits on. */
  const linked = (p: Proof) =>
    p.blocks.flatMap((b) =>
      b.kind === "breakdown"
        ? b.items.flatMap((i) => (i.link ? [{ on: i.label, value: i.value, link: i.link }] : []))
        : b.kind === "chain"
          ? b.lines.flatMap((l) => (l.link ? [{ on: l.label, value: l.value, link: l.link }] : []))
          : [],
    );

  /** Every column the page draws: the year view (5 years) and each year's months, 24 months out. */
  async function columns(s = settings()) {
    const data = await loadForecastData(fakeDb(s), book);
    const f = buildForecast(forecastInputs(data)!, data.profile.settings.outlook);
    const r = data.profile;
    const years = [...new Set(f.months.slice(0, 24).map((m) => m.year))];
    const cols = [...yearPeriods(f, r, { actualYears: 1, throughYear: r.currentYear + 5 }), ...years.flatMap((y) => monthPeriods(f, r, y))];
    return { f, r, cols };
  }

  it("proves every cell the ledger shows: the page's figure, re-adding chains, links that build", async () => {
    const c = ctx();
    const { cols } = await columns();
    expect(new Set(cols.map((p) => p.kind))).toEqual(new Set(["ACTUAL", "FORECAST", "TOTAL"]));
    let cells = 0;
    let followed = 0;
    const seen = new Map<string, Proof>();
    const build = async (d: unknown) => {
      const k = JSON.stringify(d);
      if (!seen.has(k)) seen.set(k, await buildProof(c, d as ForecastDescriptor));
      return seen.get(k)!;
    };
    for (const p of cols)
      for (const line of LINES) {
        const v = ledgerValue(p.flows, line);
        if (v == null) continue;
        const label = `${p.id} ${line}`;
        const q = await build(descOf(p, line));
        expect(q.figure, label).toEqual({ cents: v });
        expect(q.selfCheck, label).toMatchObject({ ok: true, deltaCents: 0 });
        for (const ch of chains(q)) expect(reAdds(ch.lines), `${label} ${ch.title}`).toEqual([]);
        expect(q.describes, label).toMatch(p.kind === "ACTUAL" ? /actual \(not projected\)$/ : /projected$|forecast$/);
        cells++;
        for (const l of linked(q)) {
          const parsed = parseDescriptor(JSON.parse(JSON.stringify(l.link.descriptor)));
          expect(parsed, `${l.link.label} from ${label}`).not.toHaveProperty("error");
          const t = await build(parsed);
          if (t.selfCheck) expect(t.selfCheck.ok, `${l.link.label} from ${label}`).toBe(true);
          // A link to another cell opens exactly the value its line shows (the half-flow and side-growth lines show a part of it).
          const d = l.link.descriptor;
          if (d.report === "forecast" && d.figure === "month" && "cents" in l.value && !/^Half |^Growth on /.test(l.on)) expect(t.figure, `${l.on} from ${label}`).toEqual(l.value);
          followed++;
        }
      }
    expect(cells).toBeGreaterThan(200);
    expect(followed).toBeGreaterThan(cells);
  }, 60_000);

  it("re-derives a projected month from the seed, the drivers and the law", async () => {
    const { f } = await columns();
    const m = f.months.find((x) => x.year === 2027 && x.month === 5)!;
    const p = await buildProof(ctx(), { report: "forecast", figure: "month", month: m.key, line: "salary" });
    expect(p.figure).toEqual({ cents: m.salary });
    const [grownBlock, share] = chains(p);
    expect(grownBlock!.lines[0]).toMatchObject({ label: "Pat Example's base salary", link: { descriptor: { report: "forecast", figure: "seed", which: "pay", personId: "pat" } } });
    expect(grownBlock!.lines.find((l) => l.op === "×")).toMatchObject({ source: "assumption" });
    expect(share!.title).toBe("May's twelfth");
    const tax = await buildProof(ctx(), { report: "forecast", figure: "month", month: m.key, line: "taxes" });
    expect(chains(tax).flatMap((b) => b.lines).some((l) => l.source === "law" && l.link?.descriptor.report === "forecast")).toBe(true);
    expect(tax.estimates[0]).toMatchObject({ id: "forecast.projected" });
  });

  it("opens each balance on the month before, and the first month on the proven start", async () => {
    const { f } = await columns();
    const [first, second] = f.months;
    const p1 = await buildProof(ctx(), { report: "forecast", figure: "month", month: first!.key, line: "netWorth" });
    expect(chains(p1)[0]!.lines[0]).toMatchObject({ source: "proven", link: { descriptor: { report: "forecast", figure: "seed", which: "start" } } });
    const p2 = await buildProof(ctx(), { report: "forecast", figure: "month", month: second!.key, line: "liquid" });
    expect(chains(p2)[0]!.lines[0]).toMatchObject({ value: { cents: first!.liquid }, link: { descriptor: { report: "forecast", figure: "month", month: first!.key, line: "liquid" } } });
  });

  it("pays the stub bonus after the start as proven, with its pay proof", async () => {
    const p = await buildProof(ctx(), { report: "forecast", figure: "month", month: "2026-04", line: "bonus" });
    expect(p.figure).toEqual({ cents: 250_000 });
    expect(chains(p)[0]!.lines[0]).toMatchObject({ source: "proven", link: { descriptor: { report: "pay", basis: "paid", lines: ["bonus"], start: "2026-04-10" } } });
  });

  it("says an actual column is actual, linking to Cash flow and the net-worth proofs", async () => {
    const living = await buildProof(ctx(), { report: "forecast", figure: "month", month: "2025-01", through: "2025-12", line: "living" });
    expect(living.describes).toBe("Living cost · 2025, actual (not projected)");
    expect(chains(living)[0]!.lines[0]!.link?.descriptor).toMatchObject({ report: "cash-flow", metric: "spending" });
    const liquid = await buildProof(ctx(), { report: "forecast", figure: "month", month: "2026-01", through: "2026-03", line: "liquid" });
    expect(chains(liquid)[0]!.lines[0]!.link?.descriptor).toMatchObject({ report: "net-worth", metric: "balance", date: EDGE });
    const total = await buildProof(ctx(), { report: "forecast", figure: "month", month: "2026-01", through: "2026-12", line: "saved" });
    expect(chains(total)[0]!.lines.map((l) => l.source)).toEqual(["proven", "derived", "derived"]);
  });

  it("lists a planned one-off as an assumption in its month", async () => {
    const s = settings({ plannedExpenses: [{ id: "x", year: 2027, month: 9, label: "New roof", amount: 1_200_000 }] });
    const p = await buildProof(ctx(s), { report: "forecast", figure: "month", month: "2027-09", line: "oneOffs" });
    expect(p.figure).toEqual({ cents: 1_200_000 });
    expect(chains(p)[0]!.lines[0]).toMatchObject({ label: "New roof", source: "assumption" });
    expect((await buildProof(ctx(s), { report: "forecast", figure: "month", month: "2027-09", line: "saved" })).selfCheck?.ok).toBe(true);
  });

  it("parses cells and refuses spans that aren't columns", async () => {
    expect(parseForecastDescriptor({ report: "forecast", figure: "month", month: "2027-13", line: "saved" })).toHaveProperty("error");
    expect(parseForecastDescriptor({ report: "forecast", figure: "month", month: "2027-03", through: "2027-01", line: "saved" })).toHaveProperty("error");
    expect(parseForecastDescriptor({ report: "forecast", figure: "month", month: "2027-03", line: "rent" })).toHaveProperty("error");
    expect(parseForecastDescriptor({ report: "forecast", figure: "month", month: "2027-03", through: "2027-03", line: "saved" })).toEqual({ report: "forecast", figure: "month", month: "2027-03", line: "saved" });
    const p = await buildProof(ctx(), { report: "forecast", figure: "month", month: "2027-02", through: "2027-05", line: "saved" });
    expect(p).toMatchObject({ withheld: true, figure: { text: "—" } });
  });
});
