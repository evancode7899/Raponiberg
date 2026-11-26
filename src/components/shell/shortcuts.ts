/** Every keyboard shortcut, listed once: Help draws all of them, and the Dashboard's ? its own. */
export type Shortcut = [keys: string, what: string];

export const APP_KEYS: Shortcut[] = [
  ["Ctrl K  or  /", "Jump to the command bar from anywhere"],
  ["Enter", "Go to the highlighted function"],
  ["↑ ↓", "Move through command-bar matches"],
  ["Esc", "Close the command list, a side panel or the menu"],
  ["G  then a letter", "Go to a page (the letters are listed below)"],
  ["[  ]", "Previous and next tab of the page"],
  ["?", "Show the keys for where you are"],
  ["SAVE name", "In the command bar: keep this page, tab and filters as a view; type its name to come back"],
  ["SPLIT code", "In the command bar: that page beside this one (SPLIT alone closes it)"],
];

/** Every table's keys (components/shell/KeyMap.tsx, components/ui/DataTable.tsx). */
export const TABLE_KEYS: Shortcut[] = [
  ["J  K", "Next and previous row (from anywhere on the page: the first row in view)"],
  ["Enter", "Open the row"],
  ["C", "Copy the table as CSV, each amount as the page shows it"],
  ["X  or  Space", "Pick the row, in a table with bulk changes"],
  ["Home  End", "First and last row"],
];

export const DASHBOARD_KEYS: Shortcut[] = [
  ["?", "List these keys"],
  ["← →  or  H L", "Previous and next panel"],
  ["↑ ↓  or  K J", "Previous and next row"],
  ["Enter", "Open the row, or the panel's page"],
  ["Space", "On a row about a category or month: narrow the other panels to it (Esc lets go)"],
  [":", "The panel's own command line: words narrow its rows, a code runs"],
  ["I", "What the panel is and where its figures come from"],
  ["1  2  3", "Net worth over 6 months, 12 months, or all proven history"],
  ["M", "3-month average on or off"],
  ["/", "Command bar"],
];

export const CATEGORIZE_KEYS: Shortcut[] = [
  ["J  K", "Next and previous merchant"],
  ["A", "Looks right: keep the guess"],
  ["Enter", "Apply the category you picked"],
  ["O", "Show or hide the rows"],
];
