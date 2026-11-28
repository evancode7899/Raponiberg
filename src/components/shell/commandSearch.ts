import { CATEGORIES } from "@/lib/classifier/taxonomy";
import { addDays } from "@/lib/dates/isoDate";
import { filterCommands, TERMINAL_COMMANDS, type TerminalCommand } from "./terminalCommands";

/**
 * What the command line offers for what's typed: a page ("NW"), a tab of one ("CF TRENDS",
 * "stress test"), a category's spending ("dining"), every statement row that says it
 * ("find whole foods", or any words no page answers to), an account or a merchant by name, a
 * figure by name (it opens the figure's proof), and the owner's saved views and pinned
 * figures. A period narrows the rows: "CF 24M DINING", "FIND 2025 PHARMACY", "ACCT 90D CHECKING".
 */
export type Suggestion = {
  id: string;
  code: string;
  label: string;
  hint: string;
  href: string;
  action?: TerminalCommand["action"] | "save-view" | "split";
  /** For SAVE: the name to save the view under. */
  arg?: string;
  /** A figure: picking it opens its proof rather than a page. */
  proof?: { descriptor: object; shownCents: number | null };
};

/** What the command line knows besides the pages: read once from the app (api/command/index, api/pins) and the Dashboard's figures. */
export type CommandContext = {
  accounts?: readonly { id: string; name: string; institution: string | null; archived: boolean }[];
  merchants?: readonly { key: string; name: string; rows: number }[];
  views?: readonly { name: string; href: string }[];
  pinned?: readonly { name: string; descriptor: object }[];
  figures?: readonly { name: string; descriptor: object; shownCents: number | null }[];
  /** Today, for periods (YYYY-MM-DD). */
  today?: string;
};

/** Each page's tabs, by the address the tab opens. The page's own list (its TABS) decides what exists; commandSearch.test.ts holds the two together. */
export const PAGE_TABS: Record<string, [id: string, label: string][]> = {
  "/net-worth": [["changes", "What changed"], ["built", "How it was built"], ["returns", "Investment returns"], ["accounts", "Account roll-forwards"]],
  "/investments": [["overview", "Allocation"], ["holdings", "Holdings"], ["dividends", "Dividends"], ["fees", "Fees"], ["gains", "Unrealized gains"], ["growth", "Money in vs growth"], ["funds", "Private funds"]],
  "/fire": [["plan", "Plan"], ["walk-away", "Walk-away income"], ["levers", "Levers"], ["stress", "Stress test"], ["playbook", "Playbook"]],
  "/home-budget": [["price", "Test a price"], ["rent", "Rent vs buy"], ["sensitivity", "Sensitivity"], ["mortgage", "Prepay vs invest"]],
  "/tax-accounts": [["inputs", "Inputs"]],
  "/cash-flow": [["spending", "Spending"], ["trends", "Trends"], ["patterns", "Patterns"], ["yoy", "Year over year"], ["merchants", "Merchants"], ["recurring", "Recurring bills"], ["unusual", "Unusual: duplicates, missing bills"], ["budget", "Budget"], ["income", "Income & savings"]],
  "/annual": [["one-offs", "One-off expenses"]],
  "/bonuses": [["schedule", "Vesting schedule"], ["payouts", "Bonus paychecks"]],
  "/taxes": [["worksheet", "Worksheet"], ["compare", "Joint vs separate"], ["income", "Income & W-2"], ["payments", "Payments"], ["w4", "W-4"], ["filed", "Filed return"], ["inputs", "Inputs"]],
  "/card-perks": [["credits", "Credits"], ["rewards", "Rewards"], ["best-card", "Best card"], ["setup", "Setup"]],
  "/car": [["log", "Log"], ["costs", "Costs"], ["fuel", "Fuel & driving"], ["value", "Value"], ["service", "Service & warranty"], ["statements", "From statements"], ["setup", "Car details"]],
  "/insurance": [["life", "Life"], ["home", "Home"], ["auto", "Auto"]],
  "/medical": [["claims", "Claims"], ["providers", "Providers & care"], ["plan", "Plan & coverage"], ["documents", "Documents"]],
  "/hsa": [["found", "Found in statements"], ["reimburse", "Reimburse"], ["growth", "Growth & strategy"], ["settings", "Settings"]],
  "/statements": [["plan", "To download"], ["transactions", "Transactions"], ["categorize", "Categorize"], ["transfers", "Transfers"], ["issues", "Issues"], ["coverage", "Coverage"], ["checks", "Checks"], ["documents", "Documents"], ["accounts", "Accounts"]],
  "/settings": [["household", "Household"], ["data", "Data & backups"], ["audit", "Audit log"]],
};

const pageOf = (href: string) => TERMINAL_COMMANDS.find((c) => c.href === href)!;

const TABS: (Suggestion & { page: TerminalCommand; words: string })[] = Object.entries(PAGE_TABS).flatMap(([href, tabs]) => {
  const page = pageOf(href);
  return tabs.map(([id, label]) => ({ id: `${href}#${id}`, code: page.mnemonic, label, hint: page.label, href: `${href}?tab=${id}`, page, words: label.toLowerCase() }));
});

const SPENDING = CATEGORIES.filter((c) => c.kind === "EXPENSE").map((c) => c.name);

/** A span of days the rows are narrowed to, and how it reads. */
export type Period = { from: string; to: string; says: string };
/** "CARD whole foods": the card to reach for (Card perks › Best card's next purchase). */
const nextCard = (words: string): Suggestion => ({ id: `card:${words}`, code: "CARD", label: `Which card for “${words}”`, hint: "Card perks › Best card", href: `/card-perks?tab=best-card&q=${encodeURIComponent(words)}` });

/**
 * A period typed among the words: 30D, 24M, 2Y (the days, months or years to today), YTD,
 * or a year (2025). Null when the token is none of these.
 */
export function periodOf(token: string, today: string): Period | null {
  const t = token.toLowerCase();
  const span = /^(\d{1,3})([dmy])$/.exec(t);
  if (span) {
    const n = Number(span[1]);
    if (!n) return null;
    const unit = span[2] as "d" | "m" | "y";
    const from = unit === "d" ? addDays(today, -n) : shiftMonths(today, unit === "m" ? -n : -12 * n);
    return { from, to: "", says: `last ${n} ${unit === "d" ? "day" : unit === "m" ? "month" : "year"}${n === 1 ? "" : "s"}` };
  }
  if (t === "ytd") return { from: `${today.slice(0, 4)}-01-01`, to: "", says: "this year" };
  if (/^(19|20)\d{2}$/.test(t)) return { from: `${t}-01-01`, to: `${t}-12-31`, says: t };
  return null;
}

function shiftMonths(iso: string, by: number): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7)) - 1 + by;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return `${yy}-${String(mm + 1).padStart(2, "0")}-${String(Math.min(Number(iso.slice(8, 10)), last)).padStart(2, "0")}`;
}

const span = (p: Period | null) => (p ? `${p.from ? `&from=${p.from}` : ""}${p.to ? `&to=${p.to}` : ""}` : "");
const over = (p: Period | null) => (p ? `, ${p.says}` : "");

const toSuggestion = (c: TerminalCommand): Suggestion => ({ id: c.mnemonic, code: c.mnemonic, label: c.label, hint: c.description ?? "", href: c.href, ...(c.action ? { action: c.action } : {}) });
const search = (words: string, p: Period | null = null): Suggestion => ({
  id: `find:${words}${span(p)}`,
  code: "FIND",
  label: `Search transactions for “${words}”`,
  hint: `every statement row${over(p)}`,
  href: `/statements?tab=transactions&q=${encodeURIComponent(words)}${span(p)}`,
});
const category = (name: string, p: Period | null = null): Suggestion => ({
  id: `cat:${name}${span(p)}`,
  code: "CAT",
  label: `${name} transactions`,
  hint: `spending in this category${over(p)}`,
  href: `/statements?tab=transactions&category=${encodeURIComponent(name)}&lane=EXPENSE${span(p)}`,
});
const strip = ({ id, code, label, hint, href }: Suggestion): Suggestion => ({ id, code, label, hint, href });

/** Codes that search one kind of thing: ACCT checking, MERCH grocer, FIG net worth, VIEW, PIN. */
const KIND_CODES = new Set(["acct", "merch", "fig", "view", "pin"]);

export function suggest(raw: string, limit = 14, ctx: CommandContext = {}): Suggestion[] {
  const typed = raw.trim();
  const q = typed.toLowerCase();
  const views = ctx.views ?? [];
  if (!q) return [...views.map(viewSuggestion), ...filterCommands("").map(toSuggestion)].slice(0, Math.max(limit, 40));
  const [first, ...more] = q.split(/\s+/);
  // SAVE name: keep this page, its tab and its filters as a view.
  if (first === "save") {
    const name = typed.slice(typed.indexOf(" ") + 1).trim();
    return more.length ? [{ id: "save", code: "SAVE", label: `Save this view as “${name}”`, hint: "this page, its tab and its filters, to come back to by name", href: "", action: "save-view", arg: name }] : [];
  }
  // SPLIT code: that page beside this one; SPLIT alone closes the split.
  if (first === "split") {
    if (!more.length) return [{ id: "split", code: "SPLIT", label: "Close the split view", hint: "back to one page", href: "", action: "split" }];
    const target = suggest(typed.slice(typed.indexOf(" ") + 1), 6, ctx).find((s) => s.href && !s.action && !s.proof);
    return target ? [{ id: `split:${target.href}`, code: "SPLIT", label: `${target.label} beside this page`, hint: target.hint, href: target.href, action: "split" }] : [];
  }
  // A period anywhere after the first word narrows the rows; the rest are the words.
  const today = ctx.today ?? new Date().toISOString().slice(0, 10);
  const at = more.findIndex((w) => periodOf(w, today));
  const period = at < 0 ? null : periodOf(more[at]!, today);
  const rest = more.filter((_, i) => i !== at).join(" ");
  const restTyped = typed.split(/\s+/).slice(1).filter((_, i) => i !== at).join(" ");
  const find = /^(find|search|f)$/.test(first!) && rest ? rest : null;
  if (find) return [search(restTyped || find, period)];
  if (find) return [search(find)];
  if (/^(card|which)$/.test(first!) && rest) return [nextCard(rest.replace(/^card\s+(for\s+)?/, ""))];

  const out: Suggestion[] = [];
  const add = (s: Suggestion) => {
    if (!out.some((x) => x.id === s.id || (x.href === s.href && x.action === s.action && !x.proof && !s.proof))) out.push(s);
  };
  // A kind and words: only that kind (ACCT checking, MERCH grocer, FIG net worth, VIEW, PIN).
  const kind = KIND_CODES.has(first!) ? first! : null;
  const look = kind ? rest : q;
  const has = (name: string) => look.length > 1 && name.toLowerCase().includes(look);
  if (kind) {
    if (kind === "view") for (const v of views) if (!rest || has(v.name)) add(viewSuggestion(v));
    if (kind === "pin") for (const f of ctx.pinned ?? []) if (!rest || has(f.name)) add(pinSuggestion(f));
    if (kind === "fig") for (const f of ctx.figures ?? []) if (!rest || has(f.name)) add(figureSuggestion(f));
    if (kind === "acct") for (const a of ctx.accounts ?? []) if (!rest || has(a.name) || has(a.institution ?? "")) add(accountSuggestion(a, period));
    if (kind === "merch") for (const m of ctx.merchants ?? []) if (rest && (has(m.name) || has(m.key))) add(merchantSuggestion(m, period));
    return out.slice(0, limit);
  }

  // The owner's own first: a saved view or a pinned figure by its name.
  for (const v of views) if (has(v.name)) add(viewSuggestion(v));
  for (const f of ctx.pinned ?? []) if (has(f.name)) add(pinSuggestion(f));
  // A code and words: a tab of that page ("CF TREND"), or a category's spending ("CF DINING", "CF 24M DINING").
  const page = more.length ? TERMINAL_COMMANDS.find((c) => c.mnemonic.toLowerCase() === first) : undefined;
  if (page) {
    if (rest) for (const t of TABS) if (t.page === page && (t.words.startsWith(rest) || t.words.includes(rest))) add(strip(t));
    if (page.href === "/cash-flow") for (const c of SPENDING) if (!rest || c.toLowerCase().includes(rest)) if (rest || period) add(category(c, period));
  }
  for (const c of filterCommands(q)) add(toSuggestion(c));
  for (const t of TABS) if (t.words.startsWith(q)) add(strip(t));
  for (const t of TABS) if (q.length > 2 && t.words.includes(q)) add(strip(t));
  if (q.length > 2) for (const c of SPENDING) if (c.toLowerCase().includes(q)) add(category(c, period));
  if (q.length > 2) {
    for (const f of ctx.figures ?? []) if (has(f.name)) add(figureSuggestion(f));
    for (const a of ctx.accounts ?? []) if (has(a.name)) add(accountSuggestion(a, period));
    // A few merchants at most: the rest are a FIND away.
    for (const m of (ctx.merchants ?? []).filter((m) => has(m.name) || has(m.key)).slice(0, 4)) add(merchantSuggestion(m, period));
  }
  // Words no page answers to are looked for in the rows; they're offered last otherwise.
  if (q.length > 2 && !TERMINAL_COMMANDS.some((c) => c.mnemonic.toLowerCase() === q)) add(search(typed));
  return out.slice(0, limit);
}

const viewSuggestion = (v: { name: string; href: string }): Suggestion => ({ id: `view:${v.name}`, code: "VIEW", label: v.name, hint: "your saved view", href: v.href });
const pinSuggestion = (f: { name: string; descriptor: object }): Suggestion => ({ id: `pin:${f.name}`, code: "PIN", label: f.name, hint: "your pinned figure: opens its proof", href: "", proof: { descriptor: f.descriptor, shownCents: null } });
const figureSuggestion = (f: { name: string; descriptor: object; shownCents: number | null }): Suggestion => ({ id: `fig:${f.name}`, code: "FIG", label: f.name, hint: "opens the figure's proof", href: "", proof: { descriptor: f.descriptor, shownCents: f.shownCents } });
const accountSuggestion = (a: { id: string; name: string; institution: string | null; archived: boolean }, p: Period | null): Suggestion => ({
  id: `acct:${a.id}${span(p)}`,
  code: "ACCT",
  label: a.name,
  hint: `${a.institution ? `${a.institution} · ` : ""}its statement rows${over(p)}${a.archived ? " (archived)" : ""}`,
  href: `/statements?tab=transactions&accountId=${encodeURIComponent(a.id)}${span(p)}`,
});
const merchantSuggestion = (m: { key: string; name: string; rows: number }, p: Period | null): Suggestion => ({
  id: `merch:${m.key}${span(p)}`,
  code: "MERCH",
  label: m.name,
  hint: `${m.rows.toLocaleString("en-US")} row${m.rows === 1 ? "" : "s"}${over(p)}`,
  href: `/statements?tab=transactions&q=${encodeURIComponent(m.key)}${span(p)}`,
});
