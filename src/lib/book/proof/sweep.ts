import { garagePage } from "../../car/page.ts";
import { CAR_KEY, normalizeGarage } from "../../car/settings.ts";
import { buildHomeSummary } from "../../dashboard/homeSummary.ts";
import { taxLink } from "../../forecast/forecast.ts";
import { loadForecast } from "../../forecast/load.ts";
import { GOALS_KEY, normalizeGoals } from "../../goals/settings.ts";
import { loadHsaReport } from "../../hsa/loadReport.ts";
import { INVESTMENT_SETTINGS_KEY, normalizeInvestmentSettings } from "../../investments/settings.ts";
import { buildAnnualProfile } from "../../profile/buildAnnualProfile.ts";
import { buildAccountRollforwards } from "../../profile/rollforwards.ts";
import { loadProfileSettings } from "../../profile/settings.ts";
import { loadJsonSetting } from "../../settingsStore.ts";
import { buildTaxReport } from "../../tax/buildTaxReport.ts";
import { TAX_YEARS } from "../../tax/params.ts";
import { normalizeRetirementSettings, RETIREMENT_SETTINGS_KEY } from "../../taxAccounts/settings.ts";
import { bonusesOf } from "../reports/bonuses.ts";
import { buildGoals, goalForecastOf } from "../reports/goals.ts";
import { buildInvestments } from "../reports/investments.ts";
import { buildMoneyCalendar, calendarYears, type CalendarYear } from "../reports/moneyCalendar.ts";
import { buildNetWorth } from "../reports/netWorth.ts";
import { buildNetWorthChanges } from "../reports/netWorthChanges.ts";
import { buildSpendingReport } from "../reports/spending.ts";
import { buildTaxAccounts } from "../reports/taxAccounts.ts";
import { BLOCKING_KINDS, differs, showValue, type ClearedBasis, type SweepProblem } from "./clearance.ts";
import { chainReAdds } from "./common.ts";
import {
  accountLimitsFigures,
  annualFigures,
  bonusesFigures,
  calendarFigures,
  carFigures,
  cashFlowFigures,
  forecastFigures,
  goalsFigures,
  homeFigures,
  hsaFigures,
  investmentsFigures,
  netWorthChangeFigures,
  netWorthFigures,
  sourceFigures,
  taxEstimateFigures,
  type PageFigure,
} from "./figures.ts";
import { buildProof, parseDescriptor, type ProofDescriptor } from "./index.ts";
import { descriptorKey } from "./key.ts";
import type { Proof, ProofContext, ProofLink, ProofValue } from "./types.ts";

/**
 * The proof sweep: every figure every page shows (figures.ts), held to its proof on the
 * owner's own Book. The proof drawer compares a figure with its proof only when someone
 * opens it; the sweep does it for all of them, each time the data changes, so a page and
 * its proof can't drift apart unseen.
 *
 * What it holds each figure to:
 *  - DIFFERS: the proof works the figure out to a different value than the page shows;
 *  - SELF_CHECK: the proof's own parts don't re-add to its figure;
 *  - CHAIN: a step of a worked chain doesn't re-add to its "=" line;
 *  - WITHHELD: the page shows a figure an open finding withholds;
 *  - LINK: a link the proof offers doesn't parse or build, or its proof fails its own self-check;
 *  - ERROR: the page's report or the proof couldn't be built at all.
 * Every one is a bug in the app, never in the owner's documents: both sides read the same Book.
 *
 * Its answer clears figures (clearance.ts): pages show a number only when the sweep of the
 * same data (`stamp`) lists it in `cleared` with the value they show. So no verdict is ever
 * dropped: `cleared` and `problems` are whole, only `listing` (for people) is cut short.
 * What the sweep doesn't sweep at all (a blocked tax year, no forecast) is `skipped`, each
 * with why: those figures show nowhere, and the listing says so.
 */

export type { SweepProblem, SweepProblemKind } from "./clearance.ts";

export type SweepReport = {
  /** The data the sweep ran on (cache.ts stampTag), taken before it started. */
  stamp: string;
  /** The Book the sweep ran on (book.today). */
  today: string;
  /** Figures held to their proofs, by page. */
  pages: { page: string; figures: number; problems: number; ms: number }[];
  figures: number;
  /** Distinct links followed out of those proofs, and the time they took. */
  links: number;
  linkMs: number;
  /** Every figure that tied, by descriptor key: the value its proof works out. */
  cleared: Record<string, ProofValue>;
  /** Cleared figures resting on an estimate or an accepted exception, by key. */
  basis: Record<string, ClearedBasis>;
  /** Every problem, by descriptor key (a page that couldn't be built at all: `page:<name>`). */
  problems: Record<string, SweepProblem[]>;
  /** How many problems in all. */
  problemCount: number;
  /** The problems for people to read, the first LISTED of them. */
  listing: SweepProblem[];
  /** What wasn't swept, and why. */
  skipped: SweepProblem[];
  ms: number;
};

export { descriptorKey };

/** How many problems the human-readable listing shows; the verdicts themselves are never cut. */
export const LISTED = 500;

/** The key a problem files under: its figure's, or its page's when it has none. */
export const problemKey = (p: SweepProblem) => (p.descriptor ? descriptorKey(p.descriptor) : `page:${p.page}`);

const linksOf = (p: Proof): ProofLink[] =>
  p.blocks.flatMap((b) => (b.kind === "breakdown" ? b.items.flatMap((i) => (i.link ? [i.link] : [])) : b.kind === "chain" ? b.lines.flatMap((l) => (l.link ? [l.link] : [])) : []));

const skip = (page: string, detail: string): SweepProblem => ({ kind: "SKIPPED", page, descriptor: null, detail });

/** No forecast: none of its figures can be swept. */
export const noForecastSkip = (): SweepProblem =>
  skip("Forecast", "No forecast could be built (no pay to forecast from), so none of its figures were swept; Goals was swept without one.");

/** A Taxes year the report blocks: its estimate isn't swept. */
export const blockedTaxYearSkip = (year: number, blockers: { title: string }[]): SweepProblem =>
  skip(`Taxes ${year}`, `The year is blocked (${blockers.length} finding${blockers.length === 1 ? "" : "s"}${blockers.length ? `: ${blockers.slice(0, 3).map((b) => b.title).join("; ")}` : ""}), so its estimate wasn't swept.`);

/** Calendar years left off the calendar because a report they need couldn't be built. */
export const droppedCalendarYears = (calendar: Partial<CalendarYear>[]): SweepProblem[] =>
  calendar.filter((c) => !c.tax || !c.accounts).map((c) => skip("Calendar", `${c.year} is left off the calendar: its ${!c.tax ? "tax report" : "account limits"} couldn't be built (see that page's error).`));

/** Every page's figures, built from the reports the pages' routes build, on the given Book; and what it couldn't build or left out. */
export async function pageFigures(ctx: ProofContext): Promise<{ figures: PageFigure[]; errors: SweepProblem[]; skipped: SweepProblem[] }> {
  const { book, db } = ctx;
  const figures: PageFigure[] = [];
  const errors: SweepProblem[] = [];
  const skipped: SweepProblem[] = [];
  const page = async (name: string, f: () => PageFigure[] | Promise<PageFigure[]>) => {
    try {
      figures.push(...(await f()));
    } catch (e) {
      errors.push({ kind: "ERROR", page: name, descriptor: null, detail: `Couldn't build the page's figures: ${(e as Error).message}` });
    }
  };
  const [profileSettings, { forecast, data }] = await Promise.all([loadProfileSettings(db), loadForecast(db, book)]);
  const year = Number(book.today.slice(0, 4));
  const link = forecast ? taxLink(forecast) : null;

  await page("Home", () => homeFigures(buildHomeSummary(book)));
  await page("Net worth", () => netWorthFigures(buildNetWorth(book, { granularity: "month" })));
  for (const granularity of ["month", "quarter", "year"] as const) await page("Net worth › What changed", () => netWorthChangeFigures(buildNetWorthChanges(book, { granularity })));
  await page("Cash flow", () => cashFlowFigures(buildSpendingReport(book, profileSettings).months));
  await page("Investments", async () => investmentsFigures(buildInvestments(book, await loadJsonSetting(db, INVESTMENT_SETTINGS_KEY, normalizeInvestmentSettings))));
  await page("Annual", () => annualFigures(buildAnnualProfile(book, profileSettings, book.taxProfile.dependents), buildAccountRollforwards(book)));
  await page("Bonuses", () => bonusesFigures(bonusesOf(book)));
  await page("HSA", async () => hsaFigures(await loadHsaReport(db)));
  await page("Car", async () => carFigures(garagePage(book, await loadJsonSetting(db, CAR_KEY, normalizeGarage))));
  await page("Goals", async () => goalsFigures(buildGoals(book, await loadJsonSetting(db, GOALS_KEY, normalizeGoals), forecast ? goalForecastOf(forecast) : null, data.profile.settings)));
  if (forecast) await page("Forecast", () => forecastFigures(forecast, data.profile));
  else skipped.push(noForecastSkip());
  const retirement = await loadJsonSetting(db, RETIREMENT_SETTINGS_KEY, normalizeRetirementSettings);
  // The calendar reads the same two reports for its years: kept from here rather than built again.
  const supported = Object.keys(TAX_YEARS).map(Number);
  const onCalendar = calendarYears(book.today, supported);
  const calendar: Partial<CalendarYear>[] = onCalendar.map((y) => ({ year: y }));
  const keep = (y: number) => calendar.find((c) => c.year === y);
  for (const y of supported.filter((y) => y <= year)) {
    await page(`Taxes ${y}`, () => {
      const r = buildTaxReport(book, y, { forecast: link });
      const c = keep(y);
      if (c) c.tax = r;
      if (r.blocked) {
        skipped.push(blockedTaxYearSkip(y, r.blockers));
        return [];
      }
      return taxEstimateFigures(r);
    });
    await page(`Account limits ${y}`, () => {
      const r = buildTaxAccounts(book, y, retirement, link);
      const c = keep(y);
      if (c) c.accounts = r;
      return accountLimitsFigures(r);
    });
  }
  skipped.push(...droppedCalendarYears(calendar));
  await page("Calendar", () => buildMoneyCalendarFigures(book.today, calendar));
  // The sources under every figure: each statement, row and pay stub as it prints.
  await page("Sources", () => sourceFigures(book));
  return { figures, errors, skipped };
}

const buildMoneyCalendarFigures = (today: string, calendar: Partial<CalendarYear>[]) =>
  calendarFigures(buildMoneyCalendar(today, calendar.filter((c): c is CalendarYear => Boolean(c.tax && c.accounts))));

/** Builds a figure's proof (or the error it threw). */
export type ProofBuilder = (d: ProofDescriptor) => Promise<Proof | Error>;

/**
 * Holds figures to their proofs: every verdict, none dropped. `build` is the sweep's
 * proof builder (memoised per descriptor); `links` when the proofs' links are followed too.
 */
export async function judgeFigures(
  figures: PageFigure[],
  build: ProofBuilder,
  opts: { errors?: SweepProblem[]; skipped?: SweepProblem[]; followLinks?: boolean } = {},
): Promise<Omit<SweepReport, "stamp" | "today" | "ms">> {
  const all: SweepProblem[] = [...(opts.errors ?? [])];
  const problems: Record<string, SweepProblem[]> = {};
  const file = (p: SweepProblem) => (problems[problemKey(p)] ??= []).push(p);
  for (const p of all) file(p);
  const byPage = new Map<string, { figures: number; problems: number; ms: number }>();
  for (const p of all) {
    const row = byPage.get(p.page) ?? { figures: 0, problems: 0, ms: 0 };
    row.problems++;
    byPage.set(p.page, row);
  }
  const note = (p: SweepProblem) => {
    const row = byPage.get(p.page) ?? { figures: 0, problems: 0, ms: 0 };
    row.problems++;
    byPage.set(p.page, row);
    all.push(p);
    file(p);
  };
  const cleared: Record<string, ProofValue> = {};
  const basis: Record<string, ClearedBasis> = {};
  const links = new Map<string, { from: string; page: string; link: ProofLink }>();
  let linkMs = 0;
  for (const f of figures) {
    const row = byPage.get(f.page) ?? { figures: 0, problems: 0, ms: 0 };
    row.figures++;
    byPage.set(f.page, row);
    const t0 = performance.now();
    const p = await build(f.descriptor);
    row.ms += performance.now() - t0;
    if (p instanceof Error) {
      note({ kind: "ERROR", page: f.page, descriptor: f.descriptor, detail: `The proof couldn't be built: ${p.message}` });
      continue;
    }
    if (f.shown && differs(f.shown, p.figure)) note({ kind: "DIFFERS", page: f.page, descriptor: f.descriptor, detail: `${p.describes}: the page shows ${showValue(f.shown)}, the proof works out ${showValue(p.figure)}.` });
    if (p.selfCheck && !p.selfCheck.ok) note({ kind: "SELF_CHECK", page: f.page, descriptor: f.descriptor, detail: `${p.describes}: ${p.selfCheck.explain}, ${(p.selfCheck.deltaCents / 100).toFixed(2)} off the figure.` });
    for (const b of p.blocks)
      if (b.kind === "chain") for (const bad of chainReAdds(b.lines)) note({ kind: "CHAIN", page: f.page, descriptor: f.descriptor, detail: `${p.describes} · ${b.title}: ${bad}` });
    if (p.withheld && f.shown && !f.asPrinted) note({ kind: "WITHHELD", page: f.page, descriptor: f.descriptor, detail: `${p.describes}: the page shows it, but an open finding withholds it.` });
    // An open finding withholds the figure wherever it's shown, whether or not this page states a value for it.
    if (!(p.withheld && !f.asPrinted)) {
      cleared[descriptorKey(f.descriptor)] = p.figure;
      const how: ClearedBasis | null = p.estimates.length ? "estimate" : p.checks.some((c) => c.state === "accepted") ? "accepted" : null;
      if (how) basis[descriptorKey(f.descriptor)] = how;
    }
    if (opts.followLinks !== false) for (const l of linksOf(p)) links.set(descriptorKey(l.descriptor), { from: p.describes, page: f.page, link: l });
  }
  // A figure with any problem, on any page that shows it, isn't cleared.
  for (const k of Object.keys(cleared))
    if (problems[k]?.some((p) => BLOCKING_KINDS.includes(p.kind))) {
      delete cleared[k];
      delete basis[k];
    }
  for (const { from, page, link } of links.values()) {
    const parsed = parseDescriptor(JSON.parse(JSON.stringify(link.descriptor)));
    if ("error" in parsed) {
      note({ kind: "LINK", page, descriptor: link.descriptor, detail: `"${link.label}" from ${from} doesn't parse: ${parsed.error}` });
      continue;
    }
    const t0 = performance.now();
    const q = await build(parsed);
    linkMs += performance.now() - t0;
    if (q instanceof Error) note({ kind: "LINK", page, descriptor: parsed, detail: `"${link.label}" from ${from} doesn't build: ${q.message}` });
    else if (q.selfCheck && !q.selfCheck.ok) note({ kind: "LINK", page, descriptor: parsed, detail: `"${link.label}" from ${from}: ${q.selfCheck.explain}, ${(q.selfCheck.deltaCents / 100).toFixed(2)} off.` });
  }
  return {
    pages: [...byPage].map(([page, x]) => ({ page, ...x, ms: Math.round(x.ms) })),
    figures: figures.length,
    links: links.size,
    linkMs: Math.round(linkMs),
    cleared,
    basis,
    problems,
    problemCount: all.length,
    listing: all.slice(0, LISTED),
    skipped: opts.skipped ?? [],
  };
}

/**
 * Holds every page's figures to their proofs, and every link those proofs offer to its
 * own. `stamp` is the data the Book was built from (stampTag), taken before it was loaded:
 * data that changes mid-sweep then reads as a different stamp, never as this one.
 */
export async function sweepProofs(ctx: ProofContext, opts: { stamp: string; followLinks?: boolean }): Promise<SweepReport> {
  const started = performance.now();
  const { figures, errors, skipped } = await pageFigures(ctx);
  const built = new Map<string, Proof | Error>();
  let sinceYield = performance.now();
  const build: ProofBuilder = async (d) => {
    const k = descriptorKey(d);
    if (!built.has(k)) {
      // Give the server's other requests a turn every few dozen milliseconds: pages stay responsive while it runs.
      if (performance.now() - sinceYield > 30) {
        await new Promise((r) => setImmediate(r));
        sinceYield = performance.now();
      }
      try {
        built.set(k, await buildProof(ctx, d));
      } catch (e) {
        built.set(k, e as Error);
      }
    }
    return built.get(k)!;
  };
  const r = await judgeFigures(figures, build, { errors, skipped, followLinks: opts.followLinks });
  return { stamp: opts.stamp, today: ctx.book.today, ...r, ms: Math.round(performance.now() - started) };
}
