import { readAwards } from "../../bonuses/awardStore.ts";
import { readReviews } from "../../bonuses/reviewStore.ts";
import { buildGarage } from "../../car/report.ts";
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
import { buildBonuses } from "../reports/bonuses.ts";
import { buildGoals, goalForecastOf } from "../reports/goals.ts";
import { buildInvestments } from "../reports/investments.ts";
import { buildNetWorth } from "../reports/netWorth.ts";
import { buildSpendingReport } from "../reports/spending.ts";
import { buildTaxAccounts } from "../reports/taxAccounts.ts";
import { chainReAdds } from "./common.ts";
import {
  accountLimitsFigures,
  annualFigures,
  bonusesFigures,
  carFigures,
  cashFlowFigures,
  forecastFigures,
  goalsFigures,
  homeFigures,
  hsaFigures,
  investmentsFigures,
  netWorthFigures,
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
 */

export type SweepProblemKind = "DIFFERS" | "SELF_CHECK" | "CHAIN" | "WITHHELD" | "LINK" | "ERROR";
export type SweepProblem = { kind: SweepProblemKind; page: string; descriptor: ProofDescriptor | null; detail: string };
export type SweepReport = {
  /** The Book the sweep ran on (book.today). */
  today: string;
  /** Figures held to their proofs, by page. */
  pages: { page: string; figures: number; problems: number; ms: number }[];
  figures: number;
  /** Distinct links followed out of those proofs, and the time they took. */
  links: number;
  linkMs: number;
  problems: SweepProblem[];
  ms: number;
};

export { descriptorKey };

const MAX_PROBLEMS = 500;

function differs(shown: ProofValue, figure: ProofValue): boolean {
  if ("cents" in shown) return !("cents" in figure) || Math.round(shown.cents) !== Math.round(figure.cents);
  if ("ratio" in shown) return !("ratio" in figure) || Math.abs(shown.ratio - figure.ratio) > 1e-9;
  return !("text" in figure) || shown.text !== figure.text;
}
const show = (v: ProofValue) => ("cents" in v ? `${(v.cents / 100).toFixed(2)}` : "ratio" in v ? `${v.ratio}` : v.text);

const linksOf = (p: Proof): ProofLink[] =>
  p.blocks.flatMap((b) => (b.kind === "breakdown" ? b.items.flatMap((i) => (i.link ? [i.link] : [])) : b.kind === "chain" ? b.lines.flatMap((l) => (l.link ? [l.link] : [])) : []));

/** Every page's figures, built from the reports the pages' routes build, on the given Book. */
export async function pageFigures(ctx: ProofContext): Promise<{ figures: PageFigure[]; errors: SweepProblem[] }> {
  const { book, db } = ctx;
  const figures: PageFigure[] = [];
  const errors: SweepProblem[] = [];
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
  await page("Cash flow", () => cashFlowFigures(buildSpendingReport(book, profileSettings).months));
  await page("Investments", async () => investmentsFigures(buildInvestments(book, await loadJsonSetting(db, INVESTMENT_SETTINGS_KEY, normalizeInvestmentSettings))));
  await page("Annual", () => annualFigures(buildAnnualProfile(book, profileSettings, book.taxProfile.dependents), buildAccountRollforwards(book)));
  await page("Bonuses", () => bonusesFigures(buildBonuses(book, readAwards(), book.today, readReviews().reviews)));
  await page("HSA", async () => hsaFigures(await loadHsaReport(db)));
  await page("Car", async () => carFigures(buildGarage(await loadJsonSetting(db, CAR_KEY, normalizeGarage), book.rows, book.today, { statementsThrough: book.horizon.cashFlow })));
  await page("Goals", async () => goalsFigures(buildGoals(book, await loadJsonSetting(db, GOALS_KEY, normalizeGoals), forecast ? goalForecastOf(forecast) : null, data.profile.settings)));
  if (forecast) await page("Forecast", () => forecastFigures(forecast, data.profile));
  const retirement = await loadJsonSetting(db, RETIREMENT_SETTINGS_KEY, normalizeRetirementSettings);
  for (const y of Object.keys(TAX_YEARS).map(Number).filter((y) => y <= year)) {
    await page(`Taxes ${y}`, () => {
      const r = buildTaxReport(book, y, { forecast: link });
      return r.blocked ? [] : taxEstimateFigures(r);
    });
    await page(`Account limits ${y}`, () => accountLimitsFigures(buildTaxAccounts(book, y, retirement, link)));
  }
  return { figures, errors };
}

/** Holds every page's figures to their proofs, and every link those proofs offer to its own. */
export async function sweepProofs(ctx: ProofContext, opts: { followLinks?: boolean } = {}): Promise<SweepReport> {
  const started = performance.now();
  const { figures, errors } = await pageFigures(ctx);
  const problems: SweepProblem[] = [...errors];
  const byPage = new Map<string, { figures: number; problems: number; ms: number }>();
  const note = (p: SweepProblem) => {
    const row = byPage.get(p.page) ?? { figures: 0, problems: 0, ms: 0 };
    row.problems++;
    byPage.set(p.page, row);
    if (problems.length < MAX_PROBLEMS) problems.push(p);
  };
  const built = new Map<string, Proof | Error>();
  let sinceYield = performance.now();
  const build = async (d: ProofDescriptor): Promise<Proof | Error> => {
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
    if (f.shown && differs(f.shown, p.figure)) note({ kind: "DIFFERS", page: f.page, descriptor: f.descriptor, detail: `${p.describes}: the page shows ${show(f.shown)}, the proof works out ${show(p.figure)}.` });
    if (p.selfCheck && !p.selfCheck.ok) note({ kind: "SELF_CHECK", page: f.page, descriptor: f.descriptor, detail: `${p.describes}: ${p.selfCheck.explain}, ${(p.selfCheck.deltaCents / 100).toFixed(2)} off the figure.` });
    for (const b of p.blocks)
      if (b.kind === "chain") for (const bad of chainReAdds(b.lines)) note({ kind: "CHAIN", page: f.page, descriptor: f.descriptor, detail: `${p.describes} · ${b.title}: ${bad}` });
    if (p.withheld && f.shown) note({ kind: "WITHHELD", page: f.page, descriptor: f.descriptor, detail: `${p.describes}: the page shows it, but an open finding withholds it.` });
    if (opts.followLinks !== false) for (const l of linksOf(p)) links.set(descriptorKey(l.descriptor), { from: p.describes, page: f.page, link: l });
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
    today: ctx.book.today,
    pages: [...byPage].map(([page, x]) => ({ page, ...x, ms: Math.round(x.ms) })),
    figures: figures.length,
    links: links.size,
    linkMs: Math.round(linkMs),
    problems,
    ms: Math.round(performance.now() - started),
  };
}
