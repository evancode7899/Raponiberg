import { EM_DASH, NA, usd0, usdCompact } from "../formatMoney.ts";

/**
 * The phone digest: one self-contained HTML page, no JavaScript, no network — inline CSS,
 * the chart as inline SVG — that the owner opens from a synced folder on their phone. It
 * draws only figures the app already proves (the Dashboard's own reports), as of the
 * proven-through date; a withheld figure draws "n.a.". Pure: scripts/digest.ts gathers the
 * data and writes the file.
 */

export type DigestData = {
  /** Net worth's proven-through date. */
  asOf: string;
  /** When the file was written (local time, for the footer). */
  written: string;
  netWorth: {
    total: number | null;
    month: number | null;
    ytd: number | null;
    ytdYear: string;
    /** Month-end net worth, oldest first (null: a month that isn't proven). */
    series: { end: string; cents: number | null }[];
  };
  cashFlow: { label: string; income: number; spending: number; net: number } | null;
  due: { date: string; title: string; cents: number | null }[];
  goals: { name: string; status: string; current: number | null; target: number | null; lands: string | null }[];
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
const month = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const signed = (c: number | null) => (c == null ? NA : Math.round(c / 100) === 0 ? EM_DASH : `${c > 0 ? "+" : "−"}${usdCompact(Math.abs(c))}`);
const tone = (c: number | null) => (c == null || Math.round(c / 100) === 0 ? "" : c > 0 ? "pos" : "neg");

const STATUS: Record<string, string> = { REACHED: "Reached", ON_TRACK: "On track", BEHIND: "Behind", IN_PROGRESS: "In progress", NO_PACE: "No pace", NO_TARGET: "No target" };

/** The net worth line: proven months only, gaps left as gaps. */
export function sparkline(series: DigestData["netWorth"]["series"], w = 340, h = 84): string {
  const pts = series.map((p, i) => ({ i, v: p.cents }));
  const vals = pts.filter((p) => p.v != null).map((p) => p.v!);
  if (vals.length < 2) return "";
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const x = (i: number) => (series.length > 1 ? (i / (series.length - 1)) * (w - 4) + 2 : w / 2);
  const y = (v: number) => (hi === lo ? h / 2 : h - 4 - ((v - lo) / (hi - lo)) * (h - 8));
  const runs: string[] = [];
  let run: string[] = [];
  for (const p of pts) {
    if (p.v == null) {
      if (run.length > 1) runs.push(run.join(" "));
      run = [];
    } else run.push(`${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`);
  }
  if (run.length > 1) runs.push(run.join(" "));
  if (!runs.length) return "";
  const first = series[0]!.end;
  const last = series.at(-1)!.end;
  return `<svg viewBox="0 0 ${w} ${h + 16}" width="100%" role="img" aria-label="Net worth, ${month(first)} to ${month(last)}">${runs
    .map((r) => `<polyline points="${r}" fill="none" class="line" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`)
    .join("")}<text x="2" y="${h + 13}" class="axis">${month(first)}</text><text x="${w - 2}" y="${h + 13}" text-anchor="end" class="axis">${month(last)}</text></svg>`;
}

export function renderDigest(d: DigestData): string {
  const nw = d.netWorth;
  const cf = d.cashFlow;
  const rows = (items: string[]) => (items.length ? `<table>${items.join("")}</table>` : `<p class="muted">Nothing coming up.</p>`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>Digest · Raponiberg</title>
<style>
:root{--bg:#fbfaf7;--fg:#1b1a17;--muted:#6b6a66;--line:#e2e0da;--card:#fff;--accent:#b4690e;--pos:#1a7f4b;--neg:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0b0a08;--fg:#f3c56b;--muted:#a08a5c;--line:#2b2518;--card:#14110b;--accent:#ffb000;--pos:#7bd88f;--neg:#ff7a6b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 ui-monospace,"SF Mono",Menlo,Consolas,monospace;-webkit-text-size-adjust:100%}
main{max-width:30rem;margin:0 auto;padding:16px 14px 32px}
header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px}
h1{font-size:15px;margin:0;color:var(--accent);letter-spacing:.04em}
h2{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 6px;font-weight:600}
section{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:10px}
.big{font-size:28px;font-weight:700;font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}.small{font-size:12px}
.pos{color:var(--pos)}.neg{color:var(--neg)}
.chg{display:flex;gap:16px;margin-top:2px;font-size:13px}
table{width:100%;border-collapse:collapse;font-size:14px}
td{padding:5px 0;border-top:1px solid var(--line);vertical-align:top}
tr:first-child td{border-top:0}
td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;padding-left:10px}
.line{stroke:var(--accent)}.axis{fill:var(--muted);font-size:10px;font-family:inherit}
.tag{font-size:11px;color:var(--muted)}
footer{font-size:11px;color:var(--muted);text-align:center;margin-top:14px}
</style>
</head>
<body>
<main>
<header><h1>RAPONIBERG</h1><span class="small muted">proven through ${esc(day(d.asOf))}</span></header>
<section>
<h2>Net worth</h2>
<div class="big">${esc(usd0(nw.total))}</div>
<div class="chg"><span>Month <b class="${tone(nw.month)}">${esc(signed(nw.month))}</b></span><span>${esc(nw.ytdYear)} so far <b class="${tone(nw.ytd)}">${esc(signed(nw.ytd))}</b></span></div>
${sparkline(nw.series)}
</section>
<section>
<h2>Cash flow${cf ? ` · ${esc(cf.label)}` : ""}</h2>
${
  cf
    ? `<table><tr><td>Income</td><td class="n">${esc(usd0(cf.income))}</td></tr><tr><td>Spending</td><td class="n">${esc(usd0(cf.spending))}</td></tr><tr><td><b>Net</b></td><td class="n ${tone(cf.net)}"><b>${esc(signed(cf.net))}</b></td></tr></table>`
    : `<p class="muted">${NA}: no proven month yet.</p>`
}
</section>
<section>
<h2>Coming up</h2>
${rows(d.due.map((x) => `<tr><td><span class="tag">${esc(day(x.date))}</span><br>${esc(x.title)}</td><td class="n">${x.cents == null ? "" : esc(usd0(x.cents))}</td></tr>`))}
</section>
<section>
<h2>Goals</h2>
${
  d.goals.length
    ? `<table>${d.goals
        .map(
          (g) =>
            `<tr><td>${esc(g.name)}<br><span class="tag">${esc(STATUS[g.status] ?? g.status)}${g.lands ? ` · ${esc(month(g.lands))}` : ""}</span></td><td class="n">${esc(usdCompact(g.current))}${g.target != null ? `<br><span class="tag">of ${esc(usdCompact(g.target))}</span>` : ""}</td></tr>`,
        )
        .join("")}</table>`
    : `<p class="muted">No goals set.</p>`
}
</section>
<footer>Read-only copy written ${esc(d.written)}. Open the app for proofs and details.</footer>
</main>
</body>
</html>
`;
}
