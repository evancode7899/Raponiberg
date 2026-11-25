import { CATEGORIES } from "@/lib/classifier/taxonomy";
import { filterCommands, TERMINAL_COMMANDS, type TerminalCommand } from "./terminalCommands";

/**
 * What the command line offers for what's typed: a page ("NW"), a tab of one ("CF TRENDS",
 * "stress test"), a category's spending ("dining"), or every statement row that says it
 * ("find whole foods", or any words no page answers to).
 */
export type Suggestion = { id: string; code: string; label: string; hint: string; href: string; action?: TerminalCommand["action"] };

/** Each page's tabs, by the address the tab opens. The page's own list (its TABS) decides what exists; commandSearch.test.ts holds the two together. */
export const PAGE_TABS: Record<string, [id: string, label: string][]> = {
  "/net-worth": [["changes", "What changed"], ["built", "How it was built"], ["returns", "Investment returns"], ["accounts", "Account roll-forwards"]],
  "/investments": [["holdings", "Holdings"], ["fees", "Fees"], ["gains", "Unrealized gains"], ["growth", "Money in vs growth"], ["funds", "Private funds"]],
  "/fire": [["plan", "Plan"], ["walk-away", "Walk-away income"], ["levers", "Levers"], ["stress", "Stress test"], ["playbook", "Playbook"]],
  "/home-budget": [["price", "Test a price"], ["rent", "Rent vs buy"], ["sensitivity", "Sensitivity"], ["mortgage", "Prepay vs invest"]],
  "/tax-accounts": [["inputs", "Inputs"]],
  "/cash-flow": [["spending", "Spending"], ["trends", "Trends"], ["patterns", "Patterns"], ["yoy", "Year over year"], ["merchants", "Merchants"], ["recurring", "Recurring bills"], ["budget", "Budget"], ["income", "Income & savings"]],
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

const toSuggestion = (c: TerminalCommand): Suggestion => ({ id: c.mnemonic, code: c.mnemonic, label: c.label, hint: c.description ?? "", href: c.href, ...(c.action ? { action: c.action } : {}) });
const search = (words: string): Suggestion => ({ id: `find:${words}`, code: "FIND", label: `Search transactions for “${words}”`, hint: "every statement row", href: `/statements?tab=transactions&q=${encodeURIComponent(words)}` });

export function suggest(raw: string, limit = 14): Suggestion[] {
  const q = raw.trim().toLowerCase();
  if (!q) return filterCommands("").map(toSuggestion);
  const [first, ...more] = q.split(/\s+/);
  const rest = more.join(" ");
  const find = /^(find|search|f)$/.test(first!) && rest ? rest : null;
  if (find) return [search(find)];

  const out: Suggestion[] = [];
  const add = (s: Suggestion) => {
    if (!out.some((x) => x.href === s.href && x.action === s.action)) out.push(s);
  };
  // A code and words: a tab of that page ("CF TREND"), or a category's spending ("CF DINING").
  const page = rest ? TERMINAL_COMMANDS.find((c) => c.mnemonic.toLowerCase() === first) : undefined;
  if (page) {
    for (const t of TABS) if (t.page === page && (t.words.startsWith(rest) || t.words.includes(rest))) add(strip(t));
    if (page.href === "/cash-flow") for (const c of SPENDING) if (c.toLowerCase().includes(rest)) add(category(c));
  }
  for (const c of filterCommands(q)) add(toSuggestion(c));
  for (const t of TABS) if (t.words.startsWith(q)) add(strip(t));
  for (const t of TABS) if (q.length > 2 && t.words.includes(q)) add(strip(t));
  if (q.length > 2) for (const c of SPENDING) if (c.toLowerCase().includes(q)) add(category(c));
  // Words no page answers to are looked for in the rows; they're offered last otherwise.
  if (q.length > 2 && !TERMINAL_COMMANDS.some((c) => c.mnemonic.toLowerCase() === q)) add(search(raw.trim()));
  return out.slice(0, limit);
}

const strip = ({ id, code, label, hint, href }: Suggestion): Suggestion => ({ id, code, label, hint, href });
const category = (name: string): Suggestion => ({ id: `cat:${name}`, code: "CAT", label: `${name} transactions`, hint: "spending in this category", href: `/statements?tab=transactions&category=${encodeURIComponent(name)}&lane=EXPENSE` });
