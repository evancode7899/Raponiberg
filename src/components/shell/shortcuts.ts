/** Every keyboard shortcut, listed once: Help draws all of them, and the Dashboard's ? its own. */
export type Shortcut = [keys: string, what: string];

export const APP_KEYS: Shortcut[] = [
  ["Ctrl K  or  /", "Jump to the command bar from anywhere"],
  ["Enter", "Go to the highlighted function"],
  ["↑ ↓", "Move through command-bar matches"],
  ["Esc", "Close the command list, a side panel or the menu"],
];

export const DASHBOARD_KEYS: Shortcut[] = [
  ["?", "List these keys"],
  ["← →  or  H L", "Previous and next panel"],
  ["↑ ↓  or  K J", "Previous and next row"],
  ["Enter", "Open the row, or the panel's page"],
  ["1  2  3", "Net worth over 6 months, 12 months, or all proven history"],
  ["M", "3-month average on or off"],
  ["X", "On a feed row: dismiss it until what it says changes"],
  ["R", "On a feed row: remind me in a week"],
  ["/", "Command bar"],
];

export const CATEGORIZE_KEYS: Shortcut[] = [
  ["J  K", "Next and previous merchant"],
  ["A", "Looks right: keep the guess"],
  ["Enter", "Apply the category you picked"],
  ["O", "Show or hide the rows"],
];
