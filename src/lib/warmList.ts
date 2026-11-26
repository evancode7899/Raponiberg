/**
 * The reports the server builds as soon as the data changes, so pages find them ready
 * (instrumentation.ts, keepBookWarm). scripts/endpoint-timings.ts times the same list on
 * the demo in CI, so a report that grows slow shows there.
 */
export const WARM_REPORTS = [
  "/api/ledger/attention",
  "/api/command/index",
  "/api/statements/edge",
  "/api/dashboard/home-summary",
  "/api/dashboard/briefing",
  "/api/dashboard/upcoming",
  "/api/dashboard/net-worth?granularity=month",
  "/api/dashboard/cash-flow",
  "/api/integrity",
  "/api/profile",
  "/api/forecast",
  "/api/tax",
  "/api/investments",
  "/api/tax-accounts",
  "/api/goals",
  "/api/car",
  "/api/card-perks",
  "/api/bonuses",
  "/api/home-budget/funds",
  "/api/dashboard/net-worth/accounts",
  "/api/calendar",
  "/api/investments/funds",
  "/api/mortgage/links",
];

/**
 * These also look for new files in their folders and keep what they read, so the first visit
 * after a download doesn't wait for a PDF. Never on a read-only second server (LAUNCH_UPKEEP=0).
 */
export const WARM_UPKEEP_REPORTS = ["/api/hsa", "/api/medical", "/api/insurance"];

/** Warmed last: the slowest to build. */
export const WARM_LAST = ["/api/dashboard/net-worth/changes?granularity=month"];
