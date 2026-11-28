import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { Book } from "../book/load.ts";
import { buildInvestments } from "../book/reports/investments.ts";
import { buildNetWorth } from "../book/reports/netWorth.ts";
import { buildSpendingReport } from "../book/reports/spending.ts";
import { buildHomeSummary } from "../dashboard/homeSummary.ts";
import { loadBriefing } from "../dashboard/loadBriefing.ts";
import { isDemo } from "../dataDir.ts";
import { taxLink } from "../forecast/forecast.ts";
import { loadForecast } from "../forecast/load.ts";
import { segsText } from "../insights/feed.ts";
import { readFeedDecisions } from "../insights/feedDecisions.ts";
import { visibleFeed } from "../insights/feedVisible.ts";
import { INVESTMENT_SETTINGS_KEY, normalizeInvestmentSettings } from "../investments/settings.ts";
import { loadProfileSettings } from "../profile/settings.ts";
import { loadJsonSetting } from "../settingsStore.ts";
import { buildTaxReport } from "../tax/buildTaxReport.ts";
import { startedTaxYears } from "../tax/params.ts";
import { renderDigest, type DigestData } from "./render.ts";

/**
 * Builds and writes the phone digest (render.ts draws it). Used by `npm run digest` and,
 * after every backup (lib/backup/auto.ts and `npm run backup`), so the copy on the phone is
 * as current as the last backup.
 */

export const DIGEST_FILE_NAME = "raponiberg-digest.html";

const DUE = 12;
const MONTHS = 24;
const QUARTERS = 8;
const BILLS = 15;
const ONE_OFFS = 8;
const LEVER: Record<string, string> = { spend: "Spend $1k a month less", earn: "Earn $12k a year more", return: "1 point less return" };

/** The digest's figures from a Book: the reports the pages draw, built as their routes build them. */
export async function buildDigestData(prisma: PrismaClient, book: Book): Promise<DigestData> {
  // The reports the pages draw, built as their routes build them.
  const summary = buildHomeSummary(book);
  const briefing = await loadBriefing(prisma, book);
  const [profile, invSettings, { forecast }] = await Promise.all([loadProfileSettings(prisma), loadJsonSetting(prisma, INVESTMENT_SETTINGS_KEY, normalizeInvestmentSettings), loadForecast(prisma, book)]);
  const netWorth = buildNetWorth(book, { granularity: "month" });
  const spending = buildSpendingReport(book, profile);
  const investments = buildInvestments(book, invSettings);
  const year = Number(book.today.slice(0, 4));
  const tax = startedTaxYears(book.today).includes(year) ? buildTaxReport(book, year, { forecast: forecast ? taxLink(forecast) : null }) : null;

  const nw = summary.netWorth;
  const cf = summary.cashFlow;
  const lm = cf.lastMonth;
  const known = nw.totalCents != null;
  // Each group's open accounts, as Net worth lists them at the proven-through date.
  const groups = nw.groups.map((g) => ({
    group: g.group,
    cents: g.cents,
    accounts: netWorth.accounts
      .filter((a) => a.group === g.group && !a.closed && a.currentCents !== 0)
      .sort((a, b) => Math.abs(b.currentCents) - Math.abs(a.currentCents))
      .map((a) => ({ name: a.name, institution: a.institution, cents: a.currentCents })),
  }));
  const spentMonth = lm ? spending.months.find((m) => m.end === lm.end) : undefined;
  const inv = briefing.portfolio;
  const quarters = investments.returns.quarters.filter((q) => !q.through).slice(-QUARTERS);
  const invKnown = investments.blockers.length === 0;
  // The feed as the Dashboard shows it: items the owner dismissed or put off stay hidden.
  const feed = visibleFeed(briefing.feed, readFeedDecisions(), book.today).shown;
  const share = new Map(investments.concentration.map((c) => [c.key, c.share]));
  const positionsOf = (accountId: string) => investments.positions.filter((x) => x.accountId === accountId).sort((a, b) => b.valueCents - a.valueCents);
  return {
    asOf: nw.asOf,
    written: new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }),
    feed: feed.map((f) => ({ tone: f.tone, text: segsText(f.segs) })),
    health: { failing: summary.integrity.failing, missing: summary.integrity.missing, awaiting: summary.integrity.awaiting, checksPassing: summary.integrity.checksPassing, checksTotal: summary.integrity.checksTotal },
    netWorth: {
      total: nw.totalCents,
      assets: nw.assetsCents,
      debts: nw.debtsCents,
      liquid: nw.liquidCents,
      month: nw.change.month.cents,
      year: nw.change.year.cents,
      ytd: nw.change.ytd.cents,
      ytdYear: nw.change.ytdYear,
      series: nw.series.slice(-MONTHS).map((p) => ({ end: p.end, cents: p.cents })),
      yearEnds: nw.series
        .filter((p, i, a) => p.cents != null && (p.end.endsWith("-12-31") || i === a.length - 1))
        .reverse()
        .map((p) => ({ end: p.end, cents: p.cents! })),
      drivers: nw.drivers ? { saving: nw.drivers.principalCents, markets: nw.drivers.growthCents, other: nw.drivers.otherCents } : null,
      groups: known ? groups : [],
      change: known && briefing.change ? { label: briefing.change.label, cents: briefing.change.changeCents, steps: briefing.change.steps.map((s) => ({ label: s.label, cents: s.cents, note: s.note })), notes: briefing.change.notes.map(segsText) } : null,
    },
    cashFlow: {
      lastMonth: lm ? { label: lm.label, income: lm.incomeCents, spending: lm.spendingCents, net: lm.netCents, rate: cf.months.find((m) => m.end === lm.end)?.savingsRate ?? null } : null,
      kinds: spentMonth ? { bill: spentMonth.kinds.billCents, big: spentMonth.kinds.bigCents, everyday: spentMonth.kinds.everydayCents } : null,
      months: cf.months.map((m) => ({ label: m.label, income: m.incomeCents, spending: m.spendingCents, net: m.netCents, rate: m.savingsRate })),
      last12: cf.last12 ? { months: cf.last12.months, income: cf.last12.incomeCents, spending: cf.last12.spendingCents, net: cf.last12.netCents, rate: cf.last12.savingsRate } : null,
      categories: cf.categories.map((c) => ({ category: c.category, lastMonth: c.lastMonthCents, avg: c.avgCents })),
      merchants: (spentMonth?.merchants ?? []).filter((m) => m.cents > 0).map((m) => ({ name: m.name, category: m.category, cents: m.cents, count: m.count })),
      payers: (spentMonth?.payers ?? []).filter((m) => m.cents !== 0).map((m) => ({ name: m.name, cents: Math.abs(m.cents) })),
      bills: spending.recurring
        .filter((r) => r.kind === "bill" && r.active)
        .sort((a, b) => b.annualCents - a.annualCents)
        .slice(0, BILLS)
        .map((r) => ({ name: r.name, category: r.category, cadence: r.cadence, typical: r.typicalCents, annual: r.annualCents, change: r.changeCents })),
      oneOffs: [...spending.oneOffs].sort((a, b) => b.date.localeCompare(a.date)).slice(0, ONE_OFFS).map((o) => ({ date: o.date, label: o.label, category: o.category, cents: o.cents })),
    },
    investments: {
      asOf: inv.asOf,
      blocked: inv.blocked,
      total: inv.blocked ? null : inv.totalCents,
      returns: inv.returns ? { from: inv.returns.from, total: inv.returns.total, annualized: inv.returns.annualized, month: inv.returns.month ? { label: inv.returns.month.label, ratio: inv.returns.month.ratio } : null } : null,
      classes: inv.blocked ? [] : inv.classes.map((c) => ({ label: c.label, cents: c.cents, share: c.share, drift: inv.hasTarget ? c.driftCents : null })),
      byTreatment: invKnown ? investments.byTreatment.filter((t) => t.cents !== 0).map((t) => ({ treatment: t.treatment, cents: t.cents })) : [],
      accounts: invKnown ? investments.accounts.filter((a) => a.valueCents !== 0).sort((a, b) => b.valueCents - a.valueCents).map((a) => ({ name: a.name, treatment: a.treatment, cents: a.valueCents, positions: positionsOf(a.accountId).map((x) => ({ name: x.symbol ? `${x.symbol} · ${x.name}` : x.name, cents: x.valueCents, gain: x.unrealizedCents })) })) : [],
      holdings: inv.blocked ? [] : inv.holdings.map((h) => ({ name: h.name, cents: h.cents, share: share.get(h.key) ?? null, gain: h.gainCents, accounts: h.accounts })),
      gains: invKnown ? { unrealized: investments.gains.all.unrealizedCents, taxableUnrealized: investments.gains.taxable.unrealizedCents, harvest: investments.gains.harvest.map((x) => ({ name: x.symbol ?? x.name, account: x.account, loss: x.unrealizedCents! })) } : null,
      quarters: quarters.map((q) => ({ label: q.label, portfolio: q.blocked ? null : q.portfolio, sp500: q.sp500?.ratio ?? null })),
      fees: invKnown ? { weightedRatio: investments.fees.weightedRatio, annual: investments.fees.annualCents, accountFees: investments.fees.accountFeesLast12Cents } : null,
    },
    taxes: !tax
      ? null
      : tax.blocked
        ? { year, blocked: "waiting on the statements and pay stubs it needs", rows: [], installments: [] }
        : {
            year,
            blocked: null,
            rows: [
              { name: "Federal", r: tax.scenarios.mfj.federal },
              { name: "Connecticut", r: tax.scenarios.mfj.ct },
              ...(tax.scenarios.mfj.ny ? [{ name: "New York", r: tax.scenarios.mfj.ny }] : []),
            ].map(({ name, r }) => ({ name, tax: r.totalTax, paid: r.totalPayments, balance: r.balanceDue })),
            installments: [
              ...tax.plan.federal.installments.map((i) => ({ ...i, who: "Federal" })),
              ...tax.plan.ct.installments.map((i) => ({ ...i, who: "Connecticut" })),
              ...(tax.plan.ny?.installments ?? []).map((i) => ({ ...i, who: "New York" })),
            ]
              .filter((i) => i.cents > 0)
              .sort((a, b) => a.date.localeCompare(b.date))
              .map((i) => ({ date: i.date, label: `${i.who} Q${i.quarter}`, cents: i.cents })),
          },
    due: briefing.due.filter((x) => !x.done).slice(0, DUE).map((x) => ({ date: x.date, title: x.title, cents: x.dateOnly ? null : x.cents })),
    goals: briefing.goals.map((g) => ({ name: g.name, status: g.status, current: g.blockers.length ? null : g.currentCents, target: g.targetCents, lands: g.blockers.length ? null : g.lands })),
    fire: briefing.fire ? { fiYear: briefing.fire.fiYear, progress: briefing.fire.progress, number: briefing.fire.numberCents, levers: briefing.fire.levers.map((l) => ({ label: LEVER[l.key] ?? l.key, fiYear: l.fiYear })) } : null,
  };
}

type Env = Record<string, string | undefined>;

/**
 * The folder the digest goes in: DIGEST_DIR. Null when it isn't set, for the demo (its
 * made-up figures must never reach the phone), or when it is inside the app folder
 * (`root`): the digest holds real figures and must never land in the repository.
 */
export function digestDir(root: string, env: Env = process.env): string | null {
  const dir = env.DIGEST_DIR?.trim();
  if (!dir || isDemo(env)) return null;
  const out = path.resolve(dir);
  const rel = path.relative(path.resolve(root), out);
  return !rel.startsWith("..") && !path.isAbsolute(rel) ? null : out;
}

/**
 * Whether a backup should rewrite the digest: when it saved something new, when there's no
 * digest yet, or when the one there was written on an earlier day (what's coming up moves
 * with the date even when no data does). A backup with nothing new on the same day leaves it.
 */
export function digestStale(file: string, created: boolean, now = new Date()): boolean {
  if (created || !existsSync(file)) return true;
  return statSync(file).mtime.toDateString() !== now.toDateString();
}

/**
 * Writes the digest to `dir`. Overwritten in place, never written to a temp file and renamed
 * over: a synced folder (iCloud Drive for Windows especially) treats a rename as delete + new
 * file, so the phone keeps a stale copy and a Shortcut's "Open File" stays pinned to it.
 */
export async function writeDigest(prisma: PrismaClient, book: Book, dir: string): Promise<{ file: string; bytes: number; asOf: string }> {
  const data = await buildDigestData(prisma, book);
  const html = renderDigest(data);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, DIGEST_FILE_NAME);
  writeFileSync(file, html);
  return { file, bytes: html.length, asOf: data.asOf };
}
