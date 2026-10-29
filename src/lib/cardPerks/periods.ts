import { CADENCE_INFO, type Cadence } from "./catalog.ts";

const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type Period = { key: string; label: string; start: string; end: string };

/** The periods of one cadence in a calendar year, in order. */
export function periodsOf(cadence: Cadence, year: number): Period[] {
  const months = CADENCE_INFO[cadence].months;
  const out: Period[] = [];
  for (let i = 0; i < 12 / months; i++) {
    const m0 = i * months + 1;
    const m1 = m0 + months - 1;
    const key = cadence === "MONTHLY" ? `${year}-${pad(m0)}` : cadence === "QUARTERLY" ? `${year}-Q${i + 1}` : cadence === "SEMIANNUAL" ? `${year}-H${i + 1}` : `${year}`;
    const label = cadence === "MONTHLY" ? MONTHS[i]! : cadence === "QUARTERLY" ? `Q${i + 1}` : cadence === "SEMIANNUAL" ? (i === 0 ? "Jan–Jun" : "Jul–Dec") : String(year);
    out.push({ key, label, start: `${year}-${pad(m0)}-01`, end: `${year}-${pad(m1)}-${pad(lastDay(year, m1))}` });
  }
  return out;
}

/** The period of `cadence` a date falls in. */
export function periodKey(cadence: Cadence, date: string): string {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  if (cadence === "MONTHLY") return date.slice(0, 7);
  if (cadence === "QUARTERLY") return `${y}-Q${Math.ceil(m / 3)}`;
  if (cadence === "SEMIANNUAL") return `${y}-H${m <= 6 ? 1 : 2}`;
  return y;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** A case-insensitive pattern, or null when blank or not a valid regular expression. */
export function regex(pattern: string | undefined): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}
