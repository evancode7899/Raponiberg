/**
 * Category taxonomy for the statement ledger. Categories describe *what* money was for;
 * lanes (see Lane) describe *how it counts* (income, spending, internal transfer...).
 * Keep names stable: user-learned merchant rules and the budget reference them by name.
 */

export type Lane =
  | "INCOME"
  | "EXPENSE"
  /** Between two of the household's tracked accounts — never income or spending. */
  | "TRANSFER"
  /**
   * Between a tracked account and money the household owns but doesn't track (a partner's
   * pre-merge accounts, Venmo/Wise balances, a foreign brokerage). Not income or
   * spending, but it *is* principal entering/leaving the tracked books.
   */
  | "EXTERNAL_TRANSFER"
  /** Payroll deferrals that land directly in a retirement account. */
  | "CONTRIBUTION_EMPLOYEE"
  /** Employer match / profit sharing / safe harbor. */
  | "CONTRIBUTION_EMPLOYER"
  | "CONTRIBUTION_PERSONAL";

export const LANES: Lane[] = [
  "INCOME",
  "EXPENSE",
  "TRANSFER",
  "EXTERNAL_TRANSFER",
  "CONTRIBUTION_EMPLOYEE",
  "CONTRIBUTION_EMPLOYER",
  "CONTRIBUTION_PERSONAL",
];

export const LANE_LABELS: Record<Lane, string> = {
  INCOME: "Income",
  EXPENSE: "Spending",
  TRANSFER: "Transfer between own accounts",
  EXTERNAL_TRANSFER: "Transfer with untracked money",
  CONTRIBUTION_EMPLOYEE: "Payroll retirement deferral",
  CONTRIBUTION_EMPLOYER: "Employer retirement contribution",
  CONTRIBUTION_PERSONAL: "Personal retirement contribution",
};

export type CategoryDef = {
  name: string;
  kind: "INCOME" | "EXPENSE";
  group: string;
};

export const CATEGORIES: CategoryDef[] = [
  // Income
  { name: "Paycheck", kind: "INCOME", group: "Income" },
  { name: "Paid leave & benefits", kind: "INCOME", group: "Income" },
  { name: "Interest", kind: "INCOME", group: "Income" },
  { name: "P2P & reimbursements", kind: "INCOME", group: "Income" },
  { name: "Other income", kind: "INCOME", group: "Income" },
  // Spending: ten categories. The classifier's finer rules (see LEGACY_ROLLUP) fold into these.
  { name: "Housing & utilities", kind: "EXPENSE", group: "Essentials" },
  { name: "Groceries", kind: "EXPENSE", group: "Essentials" },
  { name: "Transportation", kind: "EXPENSE", group: "Essentials" },
  { name: "Health & insurance", kind: "EXPENSE", group: "Essentials" },
  { name: "Dining", kind: "EXPENSE", group: "Lifestyle" },
  { name: "Shopping & gifts", kind: "EXPENSE", group: "Lifestyle" },
  { name: "Travel & entertainment", kind: "EXPENSE", group: "Lifestyle" },
  { name: "Taxes & fees", kind: "EXPENSE", group: "Financial" },
  { name: "Untracked card payments", kind: "EXPENSE", group: "Financial" },
  { name: "Other", kind: "EXPENSE", group: "Financial" },
  // Money movement (used with TRANSFER / EXTERNAL_TRANSFER / contribution lanes)
  { name: "Own-account transfers", kind: "EXPENSE", group: "Money movement" },
  { name: "Partner contributions (pre-merge)", kind: "INCOME", group: "Money movement" },
  { name: "Partner accounts (untracked)", kind: "INCOME", group: "Money movement" },
  { name: "International transfers", kind: "INCOME", group: "Money movement" },
  { name: "Untracked investment accounts", kind: "INCOME", group: "Money movement" },
  { name: "Retirement contributions", kind: "INCOME", group: "Money movement" },
];

export const CATEGORY_NAMES = new Set(CATEGORIES.map((c) => c.name));

/**
 * The finer spending categories the rules and older data use, and the one of the ten
 * each now counts under. Applied to every classification and to stored rows/rules.
 */
export const LEGACY_ROLLUP: Record<string, string> = {
  Housing: "Housing & utilities",
  Utilities: "Housing & utilities",
  "Phone & internet": "Housing & utilities",
  "Health & fitness": "Health & insurance",
  Insurance: "Health & insurance",
  "Personal care": "Health & insurance",
  Shopping: "Shopping & gifts",
  Pets: "Shopping & gifts",
  "Kids & education": "Shopping & gifts",
  "Gifts & donations": "Shopping & gifts",
  Travel: "Travel & entertainment",
  Entertainment: "Travel & entertainment",
  Subscriptions: "Travel & entertainment",
  "Events & celebrations": "Travel & entertainment",
  Taxes: "Taxes & fees",
  "Fees & interest": "Taxes & fees",
  "Government & services": "Taxes & fees",
  "Card perks & rewards": "Taxes & fees",
  "P2P payments": "Other",
  "Cash & ATM": "Other",
  Checks: "Other",
  Uncategorized: "Other",
};

export function rollupCategory(name: string): string {
  return LEGACY_ROLLUP[name] ?? name;
}
