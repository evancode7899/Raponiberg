/**
 * What each Dashboard panel is (its "i" button, or I on the panel): what it shows, where its
 * figures come from, and what to do with it. Words only, no figures: every number on the
 * panel already opens its own proof.
 */
export type PanelAbout = { what: string; from: string; use?: string };

export const PANEL_ABOUT: Record<string, PanelAbout> = {
  NW: {
    what: "Net worth at each proven month-end: everything owned less everything owed.",
    from: "Net worth's month-end balances, the same figures as Net worth › Overview. Flags on the line are the month's events.",
    use: "1, 2 and 3 pick 6 months, 12 months or all of it; M lays a 3-month average over the line.",
  },
  CHG: {
    what: "How the latest proven month moved net worth: saving, market growth and one-offs, each against its 12-month average.",
    from: "Net worth › What changed, for the same month.",
  },
  DUE: {
    what: "What's coming up: bills, statements due, tax dates and renewals, nearest first.",
    from: "the Money calendar, which reads the statements, Card perks, Insurance and Taxes.",
  },
  CAT: {
    what: "The spending categories that moved most in the latest proven month, against their own 12-month average.",
    from: "Cash flow › Spending, for the same months.",
    use: "Space on a category narrows the other panels to it.",
  },
  CF: {
    what: "Money in and money out for each of the last 12 proven months.",
    from: "Cash flow's monthly totals: income, spending and what was left to save.",
  },
  INV: {
    what: "What's invested, by kind, with its time-weighted return net of fees.",
    from: "Investments and Net worth › Investment returns.",
  },
  BAL: {
    what: "Every account grouped by kind, as of the latest proven month-end.",
    from: "Net worth's account balances, each from a statement.",
  },
  PLAN: {
    what: "Where each goal stands and when the forecast reaches it.",
    from: "Goals, measured against the one forecast that FIRE, Taxes and Home also use.",
  },
  NEWS: {
    what: "What stands out right now, ranked by how much money is at stake.",
    from: "the other pages' own findings: records, unusual charges, deadlines and checks.",
  },
};
