import type { Quality } from "./timeline";

/** What each data-quality level means, in plain words (a figure's hover text and its proof drawer). */
export const QUALITY_TEXT: Record<Quality, { label: string; help: string }> = {
  EXACT: { label: "Exact", help: "Straight from statements, to the cent." },
  ESTIMATED: {
    label: "Estimated",
    help: "Inside an investment statement's period: market change and quarterly contributions are spread evenly across its days. Exact again at each statement date.",
  },
  DERIVED: {
    label: "Derived",
    help: "No statement for this stretch; worked out from a year-end report minus the statements around it.",
  },
  INTERPOLATED: {
    label: "Gap",
    help: "A statement is missing here; values are interpolated between the statements on either side. Upload the missing statement to make it exact.",
  },
  STALE: {
    label: "Stale",
    help: "Past the latest statement on file; the last known balance is carried forward.",
  },
  UNKNOWN: { label: "Unknown", help: "Before the first statement on file." },
};
