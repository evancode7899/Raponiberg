import { BLOCKING_KINDS, type SweepState } from "./clearance.ts";

/**
 * What a page says, at its top, about figures of its own the proof sweep withholds for a
 * bug in the app (owner's rule, 2026-11-14: a page with such a figure says so itself; it's
 * not left to Statements › Checks). Pure; the banner is components/ui/proof/SweepNotice.tsx.
 *
 * Only the sweep's own disagreements count (a figure and its proof differ): a missing
 * statement or an open finding is the documents', and stays on Statements.
 */

/** Each route and the name the sweep files its figures under (figures.ts `page`): that name, or that name and more ("Taxes 2025", "FIRE › Plan"). */
export const SWEEP_PAGE_OF_ROUTE: Readonly<Record<string, string>> = {
  "/": "Home",
  "/net-worth": "Net worth",
  "/cash-flow": "Cash flow",
  "/investments": "Investments",
  "/bonuses": "Bonuses",
  "/car": "Car",
  "/insurance": "Insurance",
  "/card-perks": "Card perks",
  "/annual": "Annual",
  "/forecast": "Forecast",
  "/fire": "FIRE",
  "/calendar": "Calendar",
  "/taxes": "Taxes",
  "/tax-accounts": "Account limits",
  "/hsa": "HSA",
  "/goals": "Goals",
  "/home-budget": "Home budget",
  "/mortgage": "Mortgage",
  "/statements": "Statements",
  "/transactions": "Transactions",
};

const routeOf = (pathname: string): string | null =>
  Object.keys(SWEEP_PAGE_OF_ROUTE)
    .filter((r) => (r === "/" ? pathname === "/" : pathname === r || pathname.startsWith(`${r}/`)))
    .sort((a, b) => b.length - a.length)[0] ?? null;

/** The page itself, a tab of it ("FIRE › Plan") or a year of it ("Taxes 2025"); never another page that starts alike ("Home budget" isn't "Home"). */
const isPage = (page: string, name: string) => page === name || page.startsWith(`${name} › `) || (page.startsWith(`${name} `) && /^\d{4}$/.test(page.slice(name.length + 1)));

export type PageNotice = {
  /** How many of the page's figures are withheld. */
  figures: number;
  /** The same, by the sweep's page name ("Taxes 2025"), most first. */
  parts: { page: string; figures: number }[];
  /** What the first of them says is wrong. */
  example: string;
};

/** The figures of the page at `pathname` the sweep withholds for a problem of the app's own, or null when there are none (or no verdicts yet). */
export function pageNotice(s: SweepState, pathname: string): PageNotice | null {
  const route = routeOf(pathname);
  if (!route || s.status !== "ready") return null;
  const name = SWEEP_PAGE_OF_ROUTE[route]!;
  const by = new Map<string, number>();
  let example = "";
  for (const problems of Object.values(s.problems)) {
    const p = problems.find((x) => BLOCKING_KINDS.includes(x.kind) && isPage(x.page, name));
    if (!p) continue;
    by.set(p.page, (by.get(p.page) ?? 0) + 1);
    example ||= p.detail;
  }
  if (!by.size) return null;
  const parts = [...by].map(([page, figures]) => ({ page, figures })).sort((a, b) => b.figures - a.figures || a.page.localeCompare(b.page));
  return { figures: parts.reduce((t, x) => t + x.figures, 0), parts, example };
}
