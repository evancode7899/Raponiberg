import { csvRow } from "@/lib/csv";
import { APP_KEYS, CATEGORIZE_KEYS, DASHBOARD_KEYS, TABLE_KEYS, type Shortcut } from "./shortcuts";

/**
 * The one key map. Every key the app answers to is listed here or in shortcuts.ts, Help and
 * the ? overlay draw them from here, and keymap.test.ts holds the pages to it: every sidebar
 * page has a jump, no two jumps share a letter, and every page with tabs uses the kit's tab
 * strip, which [ and ] step through.
 */

/** A table's own copy (DataTable copies every row it holds, not just those drawn): it listens for this on its wrapper. */
export const COPY_TABLE_EVENT = "pf:copy-table";

/** G then a letter: the page it jumps to (by its address in terminalCommands.ts). */
export const JUMPS: Record<string, string> = {
  h: "/",
  n: "/net-worth",
  i: "/investments",
  f: "/forecast",
  e: "/fire",
  o: "/goals",
  w: "/scenarios",
  b: "/home-budget",
  l: "/tax-accounts",
  d: "/calendar",
  c: "/cash-flow",
  a: "/annual",
  u: "/bonuses",
  t: "/taxes",
  p: "/card-perks",
  v: "/car",
  y: "/insurance",
  m: "/medical",
  r: "/hsa",
  s: "/statements",
  x: "/statements?tab=transactions",
  q: "/statements?tab=categorize",
  ",": "/settings",
};

/** Where each page's own keys are listed, by its address: the ? overlay shows them on that page. */
export const PAGE_KEYS: { path: string; tab?: string; title: string; keys: Shortcut[] }[] = [
  { path: "/", title: "Dashboard", keys: DASHBOARD_KEYS },
  { path: "/statements", tab: "categorize", title: "Statements › Categorize, with a merchant focused", keys: CATEGORIZE_KEYS },
];

/** The sections of the key map, for Help and the ? overlay. */
export function keySections(path: string, tab: string | null): { title: string; keys: Shortcut[] }[] {
  const own = PAGE_KEYS.filter((p) => p.path === path && (!p.tab || p.tab === tab));
  return [{ title: "Anywhere", keys: APP_KEYS }, { title: "In a table", keys: TABLE_KEYS }, ...own.map(({ title, keys }) => ({ title, keys }))];
}

/** The page a jump letter opens, if any. */
export function jumpTo(letter: string): string | null {
  return JUMPS[letter.toLowerCase()] ?? null;
}

/** The tab [ or ] moves to: the one before or after the selected one, round the strip. */
export function stepTab(count: number, selected: number, by: -1 | 1): number {
  if (count <= 0) return -1;
  const at = selected < 0 ? (by > 0 ? -1 : 0) : selected;
  return (at + by + count) % count;
}

/**
 * A table's CSV as drawn: the head's names, then each row's cells. A cell holding figures
 * copies their text (n.a. while one is withheld: what the page shows); any other cell its
 * words, its lines joined.
 */
export function csvOfCells(head: string[], rows: string[][]): string {
  return [head, ...rows].map((r) => csvRow(r)).join("\r\n") + "\r\n";
}

/** Whether a key press belongs to a field being typed in (or a control that takes letters), so no shortcut may take it. */
export function isTyping(el: Element | null): boolean {
  if (!el) return false;
  const t = el as HTMLElement;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || t.getAttribute("role") === "textbox" || t.getAttribute("role") === "combobox";
}
