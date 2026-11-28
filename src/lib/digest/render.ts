import { axisUsd, EM_DASH, NA, pct, usd0, usdCompact } from "../formatMoney.ts";

/**
 * The phone digest: one self-contained HTML page, no JavaScript, no network: inline CSS,
 * charts as inline SVG. The owner opens it in iOS Quick Look from a synced folder. It
 * draws only figures the app already proves (the same reports the pages draw), as of the
 * proven-through date; a withheld figure reads "n.a.". Nothing is worked out here but
 * layout: no figure is added, divided or compared that a report didn't already give.
 *
 * What Quick Look can do without JavaScript (tested on the owner's iPhone): radio-button
 * tabs (CSS :checked) and <details> expanders work, but #anchor links don't. So the page
 * is five tabs, each with tap-to-expand breakdowns, and has no links. A black screen until
 * the page is zoomed (worst when reopened) is Quick Look failing to paint, so the page
 * avoids what makes it size or layer things itself: every SVG has a fixed width and height
 * that no CSS overrides (width:100% undid it), and no card has a shadow. Nothing can be
 * frozen on scroll: Quick Look makes its view as tall as the whole page and scrolls that, so
 * position:sticky and a one-screen page with its own scrolling area both scroll away
 * (tested on the owner's iPhone).
 *
 * Pure: scripts/digest.ts gathers the data and writes the file.
 */

type Cents = number | null;

export type DigestData = {
  /** Net worth's proven-through date. */
  asOf: string;
  /** When the file was written (local time, for the footer). */
  written: string;
  /** What's worth knowing (the Dashboard's feed), most important first, in words. */
  feed: { tone: "good" | "bad" | "warn" | "info"; text: string }[];
  /** Statement health: open findings, statements still on their way, checks passing. */
  health: { failing: number; missing: number; awaiting: number; checksPassing: number; checksTotal: number };
  netWorth: {
    total: Cents;
    assets: Cents;
    debts: Cents;
    liquid: Cents;
    month: Cents;
    year: Cents;
    ytd: Cents;
    ytdYear: string;
    /** Month-end net worth, oldest first (null: a month that isn't proven). */
    series: { end: string; cents: Cents }[];
    /** Every proven year-end (and the latest month-end), newest first. */
    yearEnds: { end: string; cents: number }[];
    /** Where the last twelve months' change came from (null: withheld). */
    drivers: { saving: number; markets: number; other: number } | null;
    /** Account groups at the proven-through date, each with its accounts. */
    groups: { group: string; cents: number; accounts: { name: string; institution: string | null; cents: number }[] }[];
    /** The latest month's change, step by step (Net worth › What changed), and its sentences. */
    change: { label: string; cents: number; steps: { label: string; cents: number; note: string }[]; notes: string[] } | null;
  };
  cashFlow: {
    lastMonth: { label: string; income: number; spending: number; net: number; rate: number | null } | null;
    /** The last twelve months, oldest first (null figures: a month that isn't proven). */
    months: { label: string; income: Cents; spending: Cents; net: Cents; rate: number | null }[];
    last12: { months: number; income: number; spending: number; net: number; rate: number | null } | null;
    /** Last month's spending by kind: recurring bills, big one-offs, everyday. */
    kinds: { bill: number; big: number; everyday: number } | null;
    /** Spending by category: last month and the twelve-month average, biggest first. */
    categories: { category: string; lastMonth: number; avg: number }[];
    /** Last month's merchants and income sources, biggest first. */
    merchants: { name: string; category: string; cents: number; count: number }[];
    payers: { name: string; cents: number }[];
    /** Recurring bills still charging, biggest a year first. */
    bills: { name: string; category: string; cadence: string | null; typical: number; annual: number; change: Cents }[];
    /** The latest one-off expenses, newest first. */
    oneOffs: { date: string; label: string; category: string; cents: number }[];
  };
  investments: {
    asOf: string;
    blocked: boolean;
    total: Cents;
    returns: { from: string; total: number; annualized: number | null; month: { label: string; ratio: number } | null } | null;
    classes: { label: string; cents: number; share: number; drift: Cents }[];
    byTreatment: { treatment: string; cents: number }[];
    /** Each account with its positions, biggest first. */
    accounts: { name: string; treatment: string; cents: number; positions: { name: string; cents: number; gain: Cents }[] }[];
    holdings: { name: string; cents: number; share: number | null; gain: Cents; accounts: string[] }[];
    gains: { unrealized: number; taxableUnrealized: number; harvest: { name: string; account: string; loss: number }[] } | null;
    /** Quarter by quarter, oldest first. */
    quarters: { label: string; portfolio: number | null; sp500: number | null }[];
    fees: { weightedRatio: number | null; annual: number; accountFees: number } | null;
  };
  taxes: {
    year: number;
    /** Why the year is withheld, when it is. */
    blocked: string | null;
    rows: { name: string; tax: number; paid: number; balance: number }[];
    installments: { date: string; label: string; cents: number }[];
  } | null;
  due: { date: string; title: string; cents: Cents }[];
  goals: { name: string; status: string; current: Cents; target: Cents; lands: string | null }[];
  fire: { fiYear: number | null; progress: number; number: number; levers: { label: string; fiYear: number | null }[] } | null;
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
const shortDay = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
const month = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const monthTick = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ’${iso.slice(2, 4)}`;
const signed = (c: Cents) => (c == null ? NA : Math.round(c / 100) === 0 ? EM_DASH : `${c > 0 ? "+" : "−"}${usdCompact(Math.abs(c))}`);
const signedFull = (c: Cents) => (c == null ? NA : Math.round(c / 100) === 0 ? EM_DASH : `${c > 0 ? "+" : "−"}${usd0(Math.abs(c))}`);
const tone = (r: number | null) => (r == null || Math.round(r * 1000) === 0 ? "" : r > 0 ? "pos" : "neg");
const ctone = (c: Cents) => (c == null || Math.round(c / 100) === 0 ? "" : c > 0 ? "pos" : "neg");
const signedPct = (r: number | null) => (r == null ? NA : `${r > 0 ? "+" : r < 0 ? "−" : ""}${pct(Math.abs(r))}`);
/** A month label ("Mar 2026") as a tick ("M"). */
const initial = (label: string) => label.trim().charAt(0);

const STATUS: Record<string, string> = { REACHED: "Reached", ON_TRACK: "On track", BEHIND: "Behind", IN_PROGRESS: "In progress", NO_PACE: "No pace", NO_TARGET: "No target" };
const CADENCE: Record<string, string> = { weekly: "weekly", biweekly: "every 2 weeks", monthly: "monthly", quarterly: "quarterly", annual: "yearly" };

/** A row: label left, figure right. */
const row = (label: string, value: string, cls = "") => `<tr><td>${label}</td><td class="n ${cls}">${value}</td></tr>`;
const table = (rows: string[]) => `<table>${rows.join("")}</table>`;
const head = (...cols: string[]) => `<tr class="hd">${cols.map((c, i) => `<td${i ? ' class="n"' : ""}>${c}</td>`).join("")}</tr>`;
/** A tap-to-expand line: the summary is a label and a figure; the body is anything. */
const drill = (label: string, value: string, body: string, cls = "") => `<details><summary><span>${label}</span><span class="n ${cls}">${value}</span></summary><div class="drill">${body}</div></details>`;
const card = (title: string, body: string, sub = "") => `<section><h2>${title}${sub ? `<span class="sub">${sub}</span>` : ""}</h2>${body}</section>`;
const stat = (label: string, value: string, cls = "") => `<div class="stat"><div class="sl">${label}</div><div class="v ${cls}">${value}</div></div>`;
const grid = (...stats: string[]) => `<div class="grid">${stats.join("")}</div>`;
const line1 = (left: string, right: string, cls = "") => `<div class="line1"><span>${left}</span><span class="n ${cls}">${right}</span></div>`;
const muted = (s: string) => `<p class="muted small">${s}</p>`;
/** A share bar (0–1), drawn as a div: no SVG to size. */
const bar = (share: number, cls = "") => `<div class="bar"><div class="${cls}" style="width:${Math.max(0, Math.min(100, share * 100)).toFixed(1)}%"></div></div>`;

/** Round-number ticks spanning lo..hi (about `n` of them). */
export function ticks(lo: number, hi: number, n = 4): number[] {
  if (hi === lo) return [lo];
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const out: number[] = [];
  // From the round number at or below lo to the one at or above hi, so every value is inside.
  for (let v = Math.floor(lo / step) * step; v < hi + step - step * 1e-9; v += step) out.push(Math.round(v) || 0);
  return out;
}

/** Chart width: fits the narrowest iPhone's card (375 pt screen less page and card padding). CSS never resizes a chart. */
export const W = 320;
const L = 46; // room for the y labels
const svgOpen = (h: number, label: string) => `<svg viewBox="0 0 ${W} ${h}" width="${W}" height="${h}" class="chart" role="img" aria-label="${esc(label)}">`;

/** Net worth by month-end: y gridlines with dollar labels, month ticks, the latest value marked. Unproven months are gaps. */
export function lineChart(series: { end: string; cents: Cents }[], h = 170): string {
  const vals = series.flatMap((p) => (p.cents == null ? [] : [p.cents]));
  if (vals.length < 2) return "";
  const top = 10;
  const bottom = h - 22;
  const ys = ticks(Math.min(...vals), Math.max(...vals));
  const lo = Math.min(ys[0]!, ...vals);
  const hi = Math.max(ys.at(-1)!, ...vals);
  const x = (i: number) => L + (i / (series.length - 1)) * (W - L - 8);
  const y = (v: number) => (hi === lo ? (top + bottom) / 2 : bottom - ((v - lo) / (hi - lo)) * (bottom - top));
  const runs: string[][] = [];
  let run: string[] = [];
  series.forEach((p, i) => {
    if (p.cents == null) {
      if (run.length) runs.push(run);
      run = [];
    } else run.push(`${x(i).toFixed(1)},${y(p.cents).toFixed(1)}`);
  });
  if (run.length) runs.push(run);
  const grid = ys.map((v) => `<line x1="${L}" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="gl"/><text x="${L - 6}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" class="axis">${esc(axisUsd(v / 100))}</text>`).join("");
  // Five month ticks spread evenly, first and last included.
  const n = series.length - 1;
  const xt = [...new Set([0, 1, 2, 3, 4].map((k) => Math.round((k * n) / 4)))]
    .map((i) => `<text x="${x(i).toFixed(1)}" y="${h - 6}" text-anchor="${i === 0 ? "start" : i === n ? "end" : "middle"}" class="axis">${monthTick(series[i]!.end)}</text>`)
    .join("");
  const lastI = series.map((p) => p.cents).lastIndexOf(vals.at(-1)!);
  const areas = runs.filter((r) => r.length > 1).map((r) => `<polygon points="${r[0]!.split(",")[0]},${bottom} ${r.join(" ")} ${r.at(-1)!.split(",")[0]},${bottom}" class="area"/>`);
  const lines = runs.filter((r) => r.length > 1).map((r) => `<polyline points="${r.join(" ")}" fill="none" class="line"/>`);
  return `${svgOpen(h, `Net worth by month, ${month(series[0]!.end)} to ${month(series.at(-1)!.end)}`)}${grid}${areas.join("")}${lines.join("")}<circle cx="${x(lastI).toFixed(1)}" cy="${y(vals.at(-1)!).toFixed(1)}" r="4" class="dot"/>${xt}</svg>`;
}

/** Bars by month around zero, one or two series side by side, with y labels and a month initial under each bar. */
export function barChart(rows: { label: string; a: Cents; b?: Cents }[], opts: { h?: number; twoTone?: boolean; title: string }): string {
  const vals = rows.flatMap((r) => [r.a, r.b ?? null]).flatMap((v) => (v == null ? [] : [v]));
  if (!vals.length) return "";
  const h = opts.h ?? 150;
  const top = 8;
  const bottom = h - 20;
  const ys = ticks(Math.min(0, ...vals), Math.max(0, ...vals), 3);
  const lo = Math.min(ys[0]!, 0, ...vals);
  const hi = Math.max(ys.at(-1)!, 0, ...vals);
  const y = (v: number) => bottom - ((v - lo) / (hi - lo || 1)) * (bottom - top);
  const slot = (W - L - 4) / rows.length;
  const two = rows.some((r) => r.b !== undefined);
  const bw = Math.max(2, (two ? slot / 2 : slot) - 3);
  const rect = (v: Cents, xx: number, cls: string) => {
    if (v == null) return "";
    const y0 = y(0);
    const y1 = y(v);
    return `<rect x="${xx.toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(y1 - y0)).toFixed(1)}" class="${cls}"/>`;
  };
  const bars = rows
    .map((r, i) => {
      const x0 = L + i * slot + 1.5;
      if (two) return rect(r.a, x0, "fa") + rect(r.b ?? null, x0 + bw + 1, "fb");
      return rect(r.a, x0, opts.twoTone && r.a != null && r.a < 0 ? "fneg" : opts.twoTone ? "fpos" : "fa");
    })
    .join("");
  const grid = ys.map((v) => `<line x1="${L}" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="${v === 0 ? "zero" : "gl"}"/><text x="${L - 6}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" class="axis">${esc(axisUsd(v / 100))}</text>`).join("");
  const xt = rows.map((r, i) => `<text x="${(L + i * slot + slot / 2).toFixed(1)}" y="${h - 5}" text-anchor="middle" class="axis">${esc(initial(r.label))}</text>`).join("");
  return `${svgOpen(h, opts.title)}${grid}${bars}${xt}</svg>`;
}

/** Quarterly returns, you vs the S&P 500, as percent bars. */
function returnBars(quarters: DigestData["investments"]["quarters"]): string {
  if (!quarters.some((q) => q.portfolio != null)) return "";
  const h = 140;
  const vals = quarters.flatMap((q) => [q.portfolio, q.sp500]).flatMap((v) => (v == null ? [] : [v]));
  const ys = ticks(Math.min(0, ...vals) * 1000, Math.max(0, ...vals) * 1000, 3).map((v) => v / 1000);
  const lo = Math.min(ys[0]!, 0, ...vals);
  const hi = Math.max(ys.at(-1)!, 0, ...vals);
  const top = 8;
  const bottom = h - 20;
  const y = (v: number) => bottom - ((v - lo) / (hi - lo || 1)) * (bottom - top);
  const slot = (W - L - 4) / quarters.length;
  const bw = Math.max(2, slot / 2 - 3);
  const rect = (v: number | null, xx: number, cls: string) =>
    v == null ? "" : `<rect x="${xx.toFixed(1)}" y="${Math.min(y(0), y(v)).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(y(v) - y(0))).toFixed(1)}" class="${cls}"/>`;
  const grid = ys.map((v) => `<line x1="${L}" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="${v === 0 ? "zero" : "gl"}"/><text x="${L - 6}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" class="axis">${v === 0 ? "0%" : esc(signedPct(v))}</text>`).join("");
  const bars = quarters.map((q, i) => rect(q.portfolio, L + i * slot + 1.5, "fa") + rect(q.sp500, L + i * slot + 2.5 + bw, "fb")).join("");
  const xt = quarters.map((q, i) => `<text x="${(L + i * slot + slot / 2).toFixed(1)}" y="${h - 5}" text-anchor="middle" class="axis">${esc(q.label.replace(/^Q(\d) (\d{2})(\d{2})$/, "Q$1 ’$3"))}</text>`).join("");
  return `${svgOpen(h, "Quarterly return, you vs the S&P 500")}${grid}${bars}${xt}</svg>`;
}

const key = (...items: [string, string][]) => `<div class="key">${items.map(([cls, label]) => `<span><i class="${cls}"></i>${label}</span>`).join("")}</div>`;

const TONE_MARK: Record<string, string> = { good: "▲", bad: "▼", warn: "!", info: "•" };

function home(d: DigestData): string {
  const nw = d.netWorth;
  const cf = d.cashFlow.lastMonth;
  const inv = d.investments;
  const t = d.taxes;
  const owed = t && !t.blocked ? t.rows.reduce((s, r) => s + r.balance, 0) : null;
  const h = d.health;
  return [
    card(
      "Net worth",
      `<div class="big">${esc(usd0(nw.total))}</div>${grid(stat("Month", esc(signed(nw.month)), ctone(nw.month)), stat(esc(nw.ytdYear), esc(signed(nw.ytd)), ctone(nw.ytd)), stat("12 months", esc(signed(nw.year)), ctone(nw.year)))}${lineChart(nw.series)}`,
    ),
    d.feed.length
      ? card(
          "Worth knowing",
          d.feed
            .slice(0, 5)
            .map((f) => `<div class="feed ${f.tone}"><b>${TONE_MARK[f.tone]}</b><span>${esc(f.text)}</span></div>`)
            .join("") + (d.feed.length > 5 ? drill(`${d.feed.length - 5} more`, "", d.feed.slice(5).map((f) => `<div class="feed ${f.tone}"><b>${TONE_MARK[f.tone]}</b><span>${esc(f.text)}</span></div>`).join("")) : ""),
        )
      : "",
    card(
      "Cash flow",
      cf ? grid(stat("Income", esc(usdCompact(cf.income))), stat("Spending", esc(usdCompact(cf.spending))), stat("Net", esc(signed(cf.net)), ctone(cf.net))) + muted(`${esc(cf.label)} · saved ${esc(pct(cf.rate, 0))} of income`) : muted(`${NA}: no proven month yet.`),
      cf ? esc(cf.label) : "",
    ),
    card(
      "Investments",
      grid(stat("Invested", esc(usdCompact(inv.total))), ...(inv.returns ? [stat("A year", esc(signedPct(inv.returns.annualized)), tone(inv.returns.annualized))] : []), ...(inv.returns?.month ? [stat(esc(inv.returns.month.label), esc(signedPct(inv.returns.month.ratio)), tone(inv.returns.month.ratio))] : [])),
    ),
    card("Coming up", d.due.length ? d.due.slice(0, 4).map((x) => line1(`<span class="date">${esc(shortDay(x.date))}</span>${esc(x.title)}`, x.cents == null ? "" : esc(usd0(x.cents)))).join("") : muted("Nothing coming up.")),
    t ? card(`Taxes ${t.year}`, t.blocked ? muted(`${NA}: ${esc(t.blocked)}`) : line1(owed! >= 0 ? "Owed at filing (forecast)" : "Refund at filing (forecast)", esc(usd0(Math.abs(owed!))), owed! > 0 ? "neg" : "pos")) : "",
    card(
      "Statements",
      line1("Checks passing", `${h.checksPassing} / ${h.checksTotal}`, h.checksPassing === h.checksTotal ? "pos" : "neg") +
        line1("Problems to fix", String(h.failing + h.missing), h.failing + h.missing ? "neg" : "pos") +
        line1("Statements on their way", String(h.awaiting)),
    ),
  ].join("");
}

function netWorthTab(d: DigestData): string {
  const nw = d.netWorth;
  const ch = nw.change;
  return [
    card("Net worth", `<div class="big">${esc(usd0(nw.total))}</div>${grid(stat("Assets", esc(usdCompact(nw.assets))), stat("Debts", esc(usdCompact(nw.debts)), "neg"), stat("Liquid", esc(usdCompact(nw.liquid))))}${lineChart(nw.series, 190)}`),
    card(
      "Change",
      line1("Last month", esc(signedFull(nw.month)), ctone(nw.month)) +
        line1(`${esc(nw.ytdYear)} so far`, esc(signedFull(nw.ytd)), ctone(nw.ytd)) +
        line1("Last 12 months", esc(signedFull(nw.year)), ctone(nw.year)) +
        (nw.drivers ? drill("Where the 12 months came from", "", table([row("Saving", esc(signedFull(nw.drivers.saving)), ctone(nw.drivers.saving)), row("Markets", esc(signedFull(nw.drivers.markets)), ctone(nw.drivers.markets)), row("Other", esc(signedFull(nw.drivers.other)), ctone(nw.drivers.other))])) : ""),
    ),
    ch
      ? card(
          "What changed",
          ch.steps.map((s) => (s.note ? drill(esc(s.label), esc(signedFull(s.cents)), `<p class="small">${esc(s.note)}</p>`, ctone(s.cents)) : line1(esc(s.label), esc(signedFull(s.cents)), ctone(s.cents)))).join("") +
            `<div class="line1 tot"><span>Total</span><span class="n ${ctone(ch.cents)}">${esc(signedFull(ch.cents))}</span></div>` +
            (ch.notes.length ? `<div class="notes">${ch.notes.map((n) => `<p class="small">${esc(n)}</p>`).join("")}</div>` : ""),
          esc(ch.label),
        )
      : "",
    card(
      "Accounts",
      nw.groups.length
        ? nw.groups
            .map((g) => drill(`${esc(g.group)} <span class="pill">${g.accounts.length}</span>`, esc(usd0(g.cents)), table(g.accounts.map((a) => row(`${esc(a.name)}${a.institution ? `<div class="tag">${esc(a.institution)}</div>` : ""}`, esc(usd0(a.cents)), a.cents < 0 ? "neg" : "")))))
            .join("")
        : muted(`${NA}: net worth is withheld.`),
      "tap a group",
    ),
    nw.yearEnds.length ? card("Year by year", table([head("Year-end", "Net worth"), ...nw.yearEnds.map((p) => row(esc(month(p.end)), esc(usd0(p.cents))))])) : "",
    card("Every month-end", drill("Show all months", "", table([...nw.series].reverse().map((p) => row(esc(month(p.end)), esc(usd0(p.cents)))))) ),
  ].join("");
}

function cashTab(d: DigestData): string {
  const cf = d.cashFlow;
  const lm = cf.lastMonth;
  const l12 = cf.last12;
  const k = cf.kinds;
  return [
    card(
      "Last month",
      lm
        ? grid(stat("Income", esc(usdCompact(lm.income))), stat("Spending", esc(usdCompact(lm.spending))), stat("Net", esc(signed(lm.net)), ctone(lm.net))) +
            (k && lm.spending > 0
              ? `<div class="stack">${(["bill", "big", "everyday"] as const).map((x) => `<div class="s-${x}" style="width:${((k[x] / lm.spending) * 100).toFixed(1)}%"></div>`).join("")}</div>` +
                key(["s-bill", `Bills ${esc(usdCompact(k.bill))}`], ["s-big", `Big ${esc(usdCompact(k.big))}`], ["s-everyday", `Everyday ${esc(usdCompact(k.everyday))}`])
              : "")
        : muted(`${NA}: no proven month yet.`),
      lm ? esc(lm.label) : "",
    ),
    card(
      "Income vs spending",
      barChart(cf.months.map((m) => ({ label: m.label, a: m.income, b: m.spending })), { title: "Income and spending by month" }) +
        key(["fa", "Income"], ["fb", "Spending"]) +
        (l12 ? grid(stat(`Net · ${l12.months} mo`, esc(signed(l12.net)), ctone(l12.net)), stat("Saved", esc(pct(l12.rate, 0))), stat("Spent", esc(usdCompact(l12.spending)))) : ""),
      "12 months",
    ),
    card("Net by month", barChart(cf.months.map((m) => ({ label: m.label, a: m.net })), { title: "Net cash flow by month", twoTone: true, h: 120 }) + drill("Each month", "", `<table>${head("Month", "In", "Out", "Net", "Saved")}${[...cf.months].reverse().map((m) => `<tr><td>${esc(m.label)}</td><td class="n">${esc(usdCompact(m.income))}</td><td class="n">${esc(usdCompact(m.spending))}</td><td class="n ${ctone(m.net)}">${esc(signed(m.net))}</td><td class="n">${esc(pct(m.rate, 0))}</td></tr>`).join("")}</table>`)),
    card(
      "Spending by category",
      cf.categories.length ? `<table>${head("Category", lm ? esc(lm.label.slice(0, 3)) : "Month", "12-mo avg")}${cf.categories.map((c) => `<tr><td>${esc(c.category)}</td><td class="n ${c.lastMonth > c.avg * 1.25 && c.lastMonth - c.avg > 10000 ? "neg" : ""}">${esc(usd0(c.lastMonth))}</td><td class="n muted">${esc(usd0(c.avg))}</td></tr>`).join("")}</table>` : muted(`${NA}: withheld.`),
      "red = well above average",
    ),
    cf.merchants.length
      ? card(
          "Where it went",
          table(cf.merchants.slice(0, 10).map((m) => row(`${esc(m.name)}<div class="tag">${esc(m.category)} · ${m.count}×</div>`, esc(usd0(m.cents))))) +
            (cf.merchants.length > 10 ? drill(`${cf.merchants.length - 10} more merchants`, "", table(cf.merchants.slice(10).map((m) => row(`${esc(m.name)}<div class="tag">${esc(m.category)} · ${m.count}×</div>`, esc(usd0(m.cents)))))) : ""),
          lm ? esc(lm.label) : "",
        )
      : "",
    cf.payers.length ? card("Where it came from", table(cf.payers.map((p) => row(esc(p.name), esc(usd0(p.cents)), "pos"))), lm ? esc(lm.label) : "") : "",
    cf.bills.length
      ? card(
          "Recurring bills",
          table([
            head("Bill", "Usual", "A year"),
            ...cf.bills.map(
              (b) =>
                `<tr><td>${esc(b.name)}<div class="tag">${esc(b.cadence ? CADENCE[b.cadence] ?? b.cadence : "recurring")} · ${esc(b.category)}${b.change ? ` · <span class="${b.change > 0 ? "neg" : "pos"}">${esc(signed(b.change))} lately</span>` : ""}</div></td><td class="n">${esc(usd0(b.typical))}</td><td class="n">${esc(usdCompact(b.annual))}</td></tr>`,
            ),
          ]),
          "still charging",
        )
      : "",
    cf.oneOffs.length ? card("Big one-offs", table(cf.oneOffs.map((o) => row(`${esc(o.label)}<div class="tag">${esc(day(o.date))} · ${esc(o.category)}</div>`, esc(usd0(o.cents))))), "latest") : "",
  ].join("");
}

function investTab(d: DigestData): string {
  const inv = d.investments;
  const r = inv.returns;
  if (inv.blocked && inv.total == null) return card("Investments", muted(`${NA}: withheld until the statements it needs are in.`));
  return [
    card(
      "Investments",
      `<div class="big">${esc(usd0(inv.total))}</div>` + (r ? grid(stat(`Since ${esc(month(r.from))}`, esc(signedPct(r.total)), tone(r.total)), stat("A year", esc(signedPct(r.annualized)), tone(r.annualized)), ...(r.month ? [stat(esc(r.month.label), esc(signedPct(r.month.ratio)), tone(r.month.ratio))] : [])) : ""),
      esc(shortDay(inv.asOf)),
    ),
    inv.quarters.length
      ? card(
          "Returns vs S&amp;P 500",
          returnBars(inv.quarters) +
            key(["fa", "You"], ["fb", "S&amp;P 500"]) +
            drill("Each quarter", "", `<table>${head("Quarter", "You", "S&amp;P", "Gap")}${[...inv.quarters].reverse().map((q) => `<tr><td>${esc(q.label)}</td><td class="n ${tone(q.portfolio)}">${esc(signedPct(q.portfolio))}</td><td class="n">${esc(signedPct(q.sp500))}</td><td class="n muted">${q.portfolio != null && q.sp500 != null ? esc(signedPct(q.portfolio - q.sp500)) : NA}</td></tr>`).join("")}</table>`),
        )
      : "",
    inv.classes.length
      ? card(
          "Allocation",
          inv.classes.map((c) => line1(`${esc(c.label)}${c.drift ? `<div class="tag">${esc(signed(c.drift))} vs target</div>` : ""}`, `${esc(usdCompact(c.cents))} <span class="pill">${esc(pct(c.share, 0))}</span>`) + bar(c.share)).join(""),
        )
      : "",
    inv.accounts.length
      ? card(
          "Accounts",
          inv.byTreatment
            .map((t) => {
              const accts = inv.accounts.filter((a) => a.treatment === t.treatment);
              return `<div class="group"><div class="gh"><span>${esc(t.treatment)}</span><span class="n">${esc(usd0(t.cents))}</span></div>${accts
                .map((a) =>
                  a.positions.length
                    ? drill(esc(a.name), esc(usd0(a.cents)), table(a.positions.map((p) => row(esc(p.name), `${esc(usd0(p.cents))}${p.gain != null ? `<div class="tag ${ctone(p.gain)}">${esc(signed(p.gain))}</div>` : ""}`))))
                    : line1(esc(a.name), esc(usd0(a.cents))),
                )
                .join("")}</div>`;
            })
            .join(""),
          "tap for holdings",
        )
      : "",
    inv.holdings.length
      ? card(
          "Biggest holdings",
          table(inv.holdings.map((h) => row(`${esc(h.name)}<div class="tag">${esc(h.accounts.join(", "))}</div>`, `${esc(usd0(h.cents))}<div class="tag">${h.share != null ? esc(pct(h.share, 1)) : ""}${h.gain != null ? ` · <span class="${ctone(h.gain)}">${esc(signed(h.gain))}</span>` : ""}</div>`))),
          "across accounts",
        )
      : "",
    inv.gains
      ? card(
          "Gains",
          line1("Unrealized, all accounts", esc(signedFull(inv.gains.unrealized)), ctone(inv.gains.unrealized)) +
            line1("Unrealized, taxable", esc(signedFull(inv.gains.taxableUnrealized)), ctone(inv.gains.taxableUnrealized)) +
            (inv.gains.harvest.length ? drill("Below cost (taxable)", String(inv.gains.harvest.length), table(inv.gains.harvest.map((x) => row(`${esc(x.name)}<div class="tag">${esc(x.account)}</div>`, esc(signedFull(x.loss)), "neg")))) : ""),
        )
      : "",
    inv.fees ? card("Fees", line1("Weighted expense ratio", esc(inv.fees.weightedRatio == null ? NA : pct(inv.fees.weightedRatio, 2))) + line1("Fund fees a year", esc(usd0(inv.fees.annual))) + line1("Account fees, last 12 mo", esc(usd0(Math.abs(inv.fees.accountFees))))) : "",
  ].join("");
}

function plansTab(d: DigestData): string {
  const t = d.taxes;
  const f = d.fire;
  return [
    t
      ? card(
          `Taxes ${t.year}`,
          t.blocked
            ? muted(`${NA}: ${esc(t.blocked)}`)
            : `<table>${head("Return", "Tax", "Paid", "Due")}${t.rows.map((x) => `<tr><td>${esc(x.name)}</td><td class="n">${esc(usdCompact(x.tax))}</td><td class="n">${esc(usdCompact(x.paid))}</td><td class="n ${x.balance > 0 ? "neg" : x.balance < 0 ? "pos" : ""}">${esc(x.balance < 0 ? `(${usdCompact(-x.balance)})` : usdCompact(x.balance))}</td></tr>`).join("")}</table>` +
              muted("Due in red is owed at filing; (in brackets) is a refund.") +
              (t.installments.length ? drill("Estimated payments to come", String(t.installments.length), table(t.installments.map((i) => row(`${esc(day(i.date))}<div class="tag">${esc(i.label)}</div>`, esc(usd0(i.cents)))))) : ""),
          "forecast",
        )
      : "",
    card("Coming up", d.due.length ? d.due.map((x) => line1(`<span class="date">${esc(day(x.date))}</span>${esc(x.title)}`, x.cents == null ? "" : esc(usd0(x.cents)))).join("") : muted("Nothing coming up.")),
    card(
      "Goals",
      d.goals.length
        ? d.goals
            .map((g) => line1(`${esc(g.name)}<div class="tag">${esc(STATUS[g.status] ?? g.status)}${g.lands ? ` · lands ${esc(month(g.lands))}` : ""}</div>`, `${esc(usdCompact(g.current))}${g.target != null ? `<div class="tag">of ${esc(usdCompact(g.target))}</div>` : ""}`) + (g.current != null && g.target ? bar(g.current / g.target, g.status === "BEHIND" ? "warn" : "") : ""))
            .join("")
        : muted("No goals set."),
    ),
    f
      ? card(
          "Financial independence",
          grid(stat("FI year", esc(f.fiYear == null ? NA : String(f.fiYear))), stat("Progress", esc(pct(f.progress, 0))), stat("FI number", esc(usdCompact(f.number)))) +
            bar(f.progress) +
            (f.levers.length ? `<div class="sh">What moves the FI year</div>${f.levers.map((l) => line1(esc(l.label), esc(l.fiYear == null ? NA : String(l.fiYear)))).join("")}` : ""),
        )
      : "",
  ].join("");
}

const TABS = [
  ["home", "Home", home],
  ["nw", "Net worth", netWorthTab],
  ["cash", "Cash", cashTab],
  ["inv", "Invest", investTab],
  ["plans", "Plans", plansTab],
] as const;

const CSS = `
:root{--bg:#e9e6de;--fg:#111;--muted:#4f4c45;--line:#d6d1c5;--edge:#b9b2a2;--card:#fff;--accent:#a65c00;--pos:#0f7a3f;--neg:#c0261b;--warn:#b26b00;--tab:#d9d4c8;--b2:#8b8578}
@media (prefers-color-scheme:dark){:root{--bg:#000;--fg:#fff6e2;--muted:#cdb68a;--line:#3a3222;--edge:#5a4c30;--card:#16120b;--accent:#ffb000;--pos:#6ee089;--neg:#ff7766;--warn:#ffc24d;--tab:#2a2216;--b2:#8f7d5b}}
*{box-sizing:border-box}
html,body{background:var(--bg)}
body{margin:0;color:var(--fg);font:16px/1.45 -apple-system,system-ui,"Segoe UI",sans-serif;-webkit-text-size-adjust:100%}
main{max-width:34rem;margin:0 auto;padding:10px 10px 36px}
.top{margin:6px 4px 12px}
h1{font-size:14px;margin:0;color:var(--accent);letter-spacing:.14em;font-weight:800}
.top .small{color:var(--muted)}
section{background:var(--card);border:1.5px solid var(--edge);border-radius:14px;padding:0 14px 12px;margin-bottom:18px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--fg);margin:0 -14px 10px;padding:11px 14px 9px;font-weight:800;border-bottom:1.5px solid var(--line);border-left:4px solid var(--accent);border-radius:12px 12px 0 0}
h2 .sub{float:right;text-transform:none;letter-spacing:0;font-weight:500;color:var(--muted)}
.big{font-size:34px;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:-.01em;margin:2px 0 4px}
.muted{color:var(--muted)}.small{font-size:14px}
p{margin:8px 0}
.pos{color:var(--pos)}.neg{color:var(--neg)}.warn{color:var(--warn)}
.grid{display:table;width:100%;table-layout:fixed;margin:4px 0 6px}
.stat{display:table-cell;padding:6px 8px 6px 0;vertical-align:top}
.stat+.stat{padding-left:10px;border-left:1.5px solid var(--line)}
.sl{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.stat .v{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;font-size:15px}
td{padding:9px 0;border-top:1px solid var(--line);vertical-align:top}
tr:first-child td{border-top:0}
tr.hd td{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;padding:4px 0 6px}
td.n,.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;padding-left:10px;font-weight:600}
.tag{font-size:13px;color:var(--muted);font-weight:400;margin-top:1px}
.pill{display:inline-block;font-size:12px;font-weight:700;color:var(--muted);background:var(--tab);border-radius:9px;padding:0 7px;margin-left:4px}
.date{display:block;font-size:12px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.03em}
.line1{display:table;width:100%;padding:10px 0;border-top:1px solid var(--line);font-size:15px}
.line1>span{display:table-cell;vertical-align:top}
h2+.line1,h2+details,h2+.feed,.gh+.line1,.gh+details{border-top:0}
.line1.tot{font-weight:800;border-top:2px solid var(--edge)}
details{border-top:1px solid var(--line)}
summary{display:table;width:100%;padding:10px 0;font-size:15px;list-style:none;cursor:pointer}
summary::-webkit-details-marker{display:none}
summary>span{display:table-cell;vertical-align:top}
summary>span:first-child{font-weight:600}
summary>span:first-child::before{content:"▸";display:inline-block;width:1.2em;color:var(--accent)}
details[open]>summary>span:first-child::before{content:"▾"}
details[open]>summary{border-bottom:1px dashed var(--line)}
.drill{padding:2px 0 8px 1.2em;border-left:3px solid var(--tab);margin-left:.3em}
.drill table{font-size:14px}
.group{margin-top:8px}.group:first-of-type{margin-top:0}
.gh{display:table;width:100%;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);padding:8px 0 4px;border-bottom:1.5px solid var(--edge)}
.gh>span{display:table-cell}
.sh{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:12px 0 0}
.notes{border-top:1.5px solid var(--line);margin-top:4px}
.feed{display:table;width:100%;padding:9px 0;border-top:1px solid var(--line);font-size:15px}
.feed>b{display:table-cell;width:1.4em;font-size:13px}.feed>span{display:table-cell}
.feed.good>b{color:var(--pos)}.feed.bad>b{color:var(--neg)}.feed.warn>b{color:var(--warn)}.feed.info>b{color:var(--muted)}
.bar{height:8px;background:var(--tab);border-radius:4px;margin:0 0 4px;overflow:hidden}
.bar>div{height:8px;background:var(--accent)}.bar>div.warn{background:var(--warn)}
.stack{display:table;width:100%;height:12px;border-radius:6px;overflow:hidden;margin:8px 0 4px;table-layout:auto}
.stack>div{display:table-cell;height:12px}
.s-bill{background:var(--accent)}.s-big{background:var(--neg)}.s-everyday{background:var(--b2)}
.key{font-size:13px;color:var(--muted);margin:4px 0 6px}.key span{margin-right:14px;white-space:nowrap}
.key i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.key i.fa{background:var(--accent)}.key i.fb{background:var(--b2)}
.chart{display:block;margin:8px auto 4px}
.line{stroke:var(--accent);stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round}
.area{fill:var(--accent);fill-opacity:.12}.dot{fill:var(--accent);stroke:var(--card);stroke-width:2}
.axis{fill:var(--muted);font-size:11px;font-family:-apple-system,system-ui,sans-serif}
.gl{stroke:var(--line);stroke-width:1}.zero{stroke:var(--edge);stroke-width:1.5}
.fa{fill:var(--accent)}.fb{fill:var(--b2)}.fpos{fill:var(--pos)}.fneg{fill:var(--neg)}
.tabr{position:absolute;opacity:0;pointer-events:none}
.tabs{display:table;width:100%;table-layout:fixed;background:var(--tab);border:1.5px solid var(--edge);border-radius:12px;padding:3px;margin-bottom:16px}
.tabs label{display:table-cell;text-align:center;padding:10px 1px;font-size:13px;font-weight:700;color:var(--muted);border-radius:9px;cursor:pointer;white-space:nowrap;letter-spacing:-.01em}
.panel{display:none}
footer{font-size:12px;color:var(--muted);text-align:center;margin-top:16px}
${TABS.map(([id]) => `#t-${id}:checked~main .p-${id}{display:block}#t-${id}:checked~main label[for=t-${id}]{background:var(--card);color:var(--accent);box-shadow:0 0 0 1.5px var(--accent)}`).join("\n")}
`;

export function renderDigest(d: DigestData): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>Digest · Raponiberg</title>
<style>${CSS}</style>
</head>
<body>
${TABS.map(([id], i) => `<input type="radio" name="tab" id="t-${id}" class="tabr"${i === 0 ? " checked" : ""}>`).join("")}
<main>
<div class="top"><h1>RAPONIBERG</h1><div class="small">Proven through ${esc(day(d.asOf))}</div></div>
<nav class="tabs">${TABS.map(([id, label]) => `<label for="t-${id}">${label}</label>`).join("")}</nav>
${TABS.map(([id, , draw]) => `<div class="panel p-${id}">${draw(d)}</div>`).join("\n")}
<footer>Read-only copy written ${esc(d.written)}. Tap a ▸ line to open it. Open the app for proofs.</footer>
</main>
</body>
</html>
`;
}
