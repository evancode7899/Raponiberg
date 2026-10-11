/**
 * Every function in the app: its mnemonic (type it in the command bar), where it lives,
 * and how it's grouped in the sidebar. The page header and browser tab title come from
 * here too, so names stay consistent everywhere.
 */
export type NavGroup = "Overview" | "Money" | "Planning" | "Data" | "System";

export type TerminalCommand = {
  /** Bloomberg-style uppercase mnemonic */
  mnemonic: string;
  href: string;
  /** Display name */
  label: string;
  /** One line under the page title. */
  description?: string;
  group: NavGroup;
  /** Listed in the command bar and help but not the sidebar (lives inside another page). */
  hidden?: boolean;
  /** Extra tokens for autocomplete (lowercase) */
  keywords?: string[];
  /** Action commands don't navigate; the shell runs them instead (see AppShell). */
  action?: "shutdown";
};

export const NAV_GROUPS: NavGroup[] = ["Overview", "Money", "Planning", "Data", "System"];

export const TERMINAL_COMMANDS: TerminalCommand[] = [
  {
    mnemonic: "HOME",
    href: "/",
    label: "Dashboard",
    description: "Where things stand, what changed, and what needs you.",
    group: "Overview",
    keywords: ["main", "dashboard", "index", "home"],
  },
  {
    mnemonic: "NW",
    href: "/net-worth",
    label: "Net worth",
    description: "Every account on the same month-ends, how it was built, investment returns, and each account's year-by-year roll-forward.",
    group: "Money",
    keywords: ["networth", "wealth", "balance", "returns", "assets", "roll-forward", "rollforward", "contributions"],
  },
  {
    mnemonic: "CF",
    href: "/cash-flow",
    label: "Cash flow",
    description: "Income and spending by period and category, from bank and card statements.",
    group: "Money",
    keywords: ["cashflow", "income", "expenses", "spending", "p&l", "savings rate", "year over year", "yoy"],
  },
  {
    mnemonic: "INV",
    href: "/investments",
    label: "Investments",
    description: "What you hold, how it's allocated, what the funds cost, unrealized gains, and money in vs growth.",
    group: "Money",
    keywords: ["holdings", "allocation", "portfolio", "expense ratio", "fees", "cost basis", "tax loss harvesting", "rebalance", "etf", "fund"],
  },
  {
    mnemonic: "BON",
    href: "/bonuses",
    label: "Bonuses",
    description: "Headline bonuses, the cash paid up front, what was deferred, and when each deferral vests, checked against the pay stubs.",
    group: "Money",
    keywords: ["bonus", "deferred", "deferral", "vesting", "vest", "restricted", "award", "compensation", "comp", "forfeit"],
  },
  {
    mnemonic: "CAR",
    href: "/car",
    label: "Car",
    description: "What the car really costs: total cost of ownership, cost per mile, fuel economy, depreciation, warranty and service, from your log and the statements.",
    group: "Money",
    keywords: ["car", "auto", "vehicle", "gas", "fuel", "mpg", "mileage", "odometer", "insurance", "parking", "maintenance", "service", "depreciation", "kbb", "tco", "cost per mile", "warranty"],
  },
  {
    mnemonic: "ANN",
    href: "/annual",
    label: "Annual report",
    description: "Each calendar year on one page: pay, taxes, spending and savings, year-end net worth, and what moved it.",
    group: "Money",
    keywords: ["annual", "yearly", "year", "profile", "summary", "statement", "one-off", "non-recurring", "waterfall", "fpo"],
  },
  {
    mnemonic: "FCST",
    href: "/forecast",
    label: "Forecast",
    description: "The engine FIRE, Taxes, Home budget and Goals run on: drivers in, a month-by-month path out, tied to what is proven so far. Estimates, not financial advice.",
    group: "Planning",
    keywords: ["forecast", "projection", "outlook", "assumptions", "future", "plan", "salary", "raise", "bonus", "milestone", "balances", "net worth"],
  },
  {
    mnemonic: "FIRE",
    href: "/fire",
    label: "FIRE",
    description: "Financial independence, retire early: your FIRE number, when you get there, and what moves the date. Built on the forecast. Estimates, not financial advice.",
    group: "Planning",
    keywords: ["financial independence", "retire early", "fi", "coast", "lean", "fat", "barista", "4% rule", "safe withdrawal", "walk away", "savings rate"],
  },
  {
    mnemonic: "TAX",
    href: "/taxes",
    label: "Taxes",
    description: "Federal, Connecticut and New York tax: projections, joint vs separate, withholding true-ups, and filed returns checked line by line. Estimates, not tax advice.",
    group: "Planning",
    keywords: ["tax", "irs", "withholding", "w2", "refund", "estimated", "joint", "separate"],
  },
  {
    mnemonic: "LIM",
    href: "/tax-accounts",
    label: "Account limits",
    description: "How much of each yearly 401(k), IRA, HSA and 529 limit is used, the backdoor Roth, and which limit to fill next. Estimates, not tax advice.",
    group: "Planning",
    keywords: ["401k", "ira", "roth", "backdoor", "hsa", "contribution limit", "catch-up", "pro rata", "tax advantaged", "retirement", "529", "chet", "max out", "limits"],
  },
  {
    mnemonic: "HSA",
    href: "/hsa",
    label: "HSA receipts",
    description: "Medical bills paid out of pocket that the HSA can pay back tax-free whenever you choose, which have been reimbursed, and what leaving the money invested has earned. Estimates, not tax advice.",
    group: "Planning",
    keywords: ["hsa", "health savings", "receipts", "shoebox", "reimburse", "reimbursement", "medical", "qualified expenses", "out of pocket", "8889", "1099-sa"],
  },
  {
    mnemonic: "GOAL",
    href: "/goals",
    label: "Goals",
    description: "Savings targets funded from your real balances: how far along, the pace needed, and when you'll get there.",
    group: "Planning",
    keywords: ["goal", "target", "emergency fund", "down payment", "savings", "sinking fund"],
  },
  {
    mnemonic: "HB",
    href: "/home-budget",
    label: "Home budget",
    description: "How much house fits the budget, and renting vs buying.",
    group: "Planning",
    keywords: ["budget", "house", "approval", "affordability", "rent vs buy"],
  },
  {
    mnemonic: "MTG",
    href: "/mortgage",
    label: "Mortgage",
    description: "Prepay the mortgage or invest the difference.",
    group: "Planning",
    keywords: ["loan", "prepay", "amortization", "invest"],
  },
  {
    mnemonic: "STMT",
    href: "/statements",
    label: "Statements",
    description: "Import statements, see what to download, fix what's missing or failing, and check what stands behind every figure.",
    group: "Data",
    keywords: ["upload", "pdf", "import", "bank", "credit card", "coverage", "documents", "accounts", "download", "plan"],
  },
  {
    mnemonic: "INT",
    href: "/statements?tab=issues",
    label: "Issues",
    description: "What's proven, what's missing, and what to fetch or fix.",
    group: "Data",
    hidden: true,
    keywords: ["integrity", "issues", "proof", "checks", "reconcile", "missing", "failing", "validation", "exceptions", "source of truth"],
  },
  {
    mnemonic: "TXN",
    href: "/transactions",
    label: "Transactions",
    description: "Search every statement row and fix how it's categorized.",
    group: "Data",
    keywords: ["ledger", "search", "payee", "merchant", "rows", "categorize"],
  },
  {
    mnemonic: "REV",
    href: "/review",
    label: "Review",
    description: "Answer the classifier's open questions and settle transfers between your accounts.",
    group: "Data",
    keywords: ["review", "categorize", "classify", "transfers", "match", "inbox", "todo"],
  },
  {
    mnemonic: "SET",
    href: "/settings",
    label: "Settings",
    description: "Appearance, app password, household, exports, backups and the audit log.",
    group: "System",
    keywords: ["prefs", "appearance", "font", "theme", "preferences", "household", "backup"],
  },
  {
    mnemonic: "EXP",
    href: "/settings?tab=data",
    label: "Export CSV",
    group: "System",
    hidden: true,
    keywords: ["csv", "download", "export"],
  },
  {
    mnemonic: "AUD",
    href: "/settings?tab=audit",
    label: "Audit log",
    group: "System",
    hidden: true,
    keywords: ["audit", "events", "history"],
  },
  {
    mnemonic: "DB",
    href: "/database",
    label: "Database browser",
    description: "Read-only view of the raw SQLite tables.",
    group: "System",
    hidden: true,
    keywords: ["sqlite", "tables", "rows", "browse", "raw"],
  },
  {
    mnemonic: "HELP",
    href: "/help",
    label: "Help",
    description: "Every function and its mnemonic, plus keyboard shortcuts.",
    group: "System",
    hidden: true,
    keywords: ["?", "commands", "functions", "list", "shortcuts", "keyboard"],
  },
  {
    mnemonic: "OFF",
    href: "#off",
    label: "Shut down server",
    group: "System",
    hidden: true,
    keywords: ["shutdown", "stop", "quit", "exit", "close"],
    action: "shutdown",
  },
];

const byMnemonic = new Map(TERMINAL_COMMANDS.map((c) => [c.mnemonic.toUpperCase(), c]));

export function getCommandByMnemonic(raw: string): TerminalCommand | undefined {
  return byMnemonic.get(raw.trim().toUpperCase());
}

/** The page a path belongs to (for the header and the active sidebar item). */
export function commandForPath(pathname: string): TerminalCommand | undefined {
  return TERMINAL_COMMANDS.find((c) => !c.action && !c.href.includes("?") && (c.href === "/" ? pathname === "/" : pathname === c.href || pathname.startsWith(`${c.href}/`)));
}

export function filterCommands(query: string): TerminalCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return TERMINAL_COMMANDS.filter((c) => !c.hidden || c.action);
  const scored = TERMINAL_COMMANDS.map((c) => {
    const m = c.mnemonic.toLowerCase();
    const score =
      m === q ? 0 : m.startsWith(q) ? 1 : c.label.toLowerCase().startsWith(q) ? 2 : c.label.toLowerCase().includes(q) ? 3 : c.keywords?.some((k) => k.includes(q)) ? 4 : 9;
    return { c, score };
  });
  return scored
    .filter((x) => x.score < 9)
    .sort((a, b) => a.score - b.score)
    .map((x) => x.c);
}
