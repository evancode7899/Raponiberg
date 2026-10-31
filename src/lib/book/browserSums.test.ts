import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Totals belong in the reports (src/lib), where every page and proof reads the same sum:
 * a total added up in the browser can quietly differ from the one the proof re-derives, and
 * the proof sweep never sees it. Page code may still add things up, but only where each sum
 * is listed here with why it isn't a figure another page shows: a chart's scale, a row count,
 * what the owner has ticked or typed, or a figure that opens its own proof (which re-derives
 * it and flags a difference). A new `.reduce(` in page code fails this test until it moves
 * into a report or is listed with its reason; the count catches a second sum slipping into
 * a file that already has one.
 */
const ALLOWED: Record<string, { count: number; why: string }> = {
  "src/app/HomeClient.tsx": { count: 1, why: "share-of-assets denominator for the composition bar (percentages, not a figure)" },
  "src/app/annual/AnnualStatement.tsx": { count: 1, why: "orders spending categories by their total across the years shown (sort key only)" },
  "src/app/api/transfers/route.ts": { count: 1, why: "the transfer editor's difference between the legs the owner picked (a pairing's check, not a figure)" },
  "src/app/car/CostsTab.tsx": { count: 4, why: "a year's cost lines added for the Total/per-mile/per-month rows, each opening the car proof for that year" },
  "src/app/car/FuelTab.tsx": { count: 1, why: "average miles a month from the odometer log (miles, not money)" },
  "src/app/car/LogTab.tsx": { count: 1, why: "the footer total of the log rows listed (a view of rows each shown above)" },
  "src/app/car/OverviewTab.tsx": { count: 2, why: "chart bucket sizes and the fixed-cost share (a ratio) of the view's own lines" },
  "src/app/cash-flow/BudgetTab.tsx": { count: 3, why: "budget targets the owner typed, and the months of a category's proven series for its median/average" },
  "src/app/cash-flow/SpendingTab.tsx": { count: 1, why: "the one-offs marked inside the date range picked (a filter of the report's list)" },
  "src/app/forecast/ForecastInputs.tsx": { count: 5, why: "each person's seed summed as the proof target (the proof re-derives it), and the planned one-offs the owner typed" },
  "src/app/goals/GoalsClient.tsx": { count: 1, why: "the goal editor's balance beside each account group to pick (an editing aid)" },
  "src/app/home-budget/SensitivityTab.tsx": { count: 1, why: "picks the nearest grid point (not a sum)" },
  "src/app/home-budget/parts.tsx": { count: 1, why: "bar chart scale" },
  "src/app/hsa/FoundTab.tsx": { count: 1, why: "the rows the owner ticked" },
  "src/app/hsa/ReceiptsTab.tsx": { count: 4, why: "receipts the owner ticked or filtered to, and the receipts named in a callout" },
  "src/app/hsa/ReimburseTab.tsx": { count: 5, why: "the reimbursement plan for the amount the owner typed, and the receipts picked for one withdrawal" },
  "src/app/insurance/InsuranceClient.tsx": { count: 1, why: "the beneficiary shares the owner is typing, checked to add up to 100% (percentages, not money)" },
  "src/app/investments/InvestmentsClient.tsx": { count: 2, why: "the target allocation the owner is typing, and the stock share (a ratio) of the report's classes" },
  "src/app/net-worth/AccountsTab.tsx": { count: 1, why: "roll-forward totals over accounts, each opening the annual rollforward-total proof (which re-derives it)" },
  "src/app/net-worth/NetWorthClient.tsx": { count: 1, why: "chart floor for debts" },
  "src/app/review/CategorizeQueue.tsx": { count: 2, why: "row counts and the latest date in the review queue" },
  "src/app/settings/DataPanel.tsx": { count: 1, why: "row count" },
  "src/app/statements/Timeline.tsx": { count: 1, why: "month count" },
  "src/app/taxes/TaxComparison.tsx": { count: 5, why: "the Separate total column: the two separate returns the engine computed, added line by line" },
  "src/app/taxes/TaxOverview.tsx": { count: 3, why: "the separate returns' Worksheet totals (lineValue), the three balances at filing, and the paid-to-date table's total column" },
  "src/app/taxes/TaxWorksheet.tsx": { count: 6, why: "household columns of per-person figures the engine returns, and a schedule's last filled row" },
  "src/components/charts/ShareBar.tsx": { count: 2, why: "chart scale" },
  "src/components/ledger/StatementPlan.tsx": { count: 2, why: "statement count" },
};

const ROOT = path.resolve(__dirname, "../../..");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");

describe("browser sums", () => {
  it("page code adds up only what's listed, with its reason", () => {
    const found: Record<string, number> = {};
    for (const f of [...files(path.join(ROOT, "src/app")), ...files(path.join(ROOT, "src/components"))]) {
      const n = (readFileSync(f, "utf8").match(/\.reduce\(/g) ?? []).length;
      if (n) found[rel(f)] = n;
    }
    const wrong = Object.entries(found)
      .filter(([f, n]) => ALLOWED[f]?.count !== n)
      .map(([f, n]) => `${f}: ${n} sum(s), ${ALLOWED[f] ? `${ALLOWED[f].count} listed` : "none listed"}`);
    const stale = Object.keys(ALLOWED).filter((f) => !(f in found)).map((f) => `${f}: listed but adds nothing up`);
    expect([...wrong, ...stale], "Move the total into its report (src/lib), or list it here with why it isn't a figure").toEqual([]);
  });
});
