import { addDays } from "./isoDate.ts";

/**
 * Dates as an iCalendar file (RFC 5545), to add to any calendar app. Each is an all-day event
 * with reminders before it; the same date exported again keeps its id, so it updates rather
 * than doubles.
 */
export type IcsEvent = { id: string; date: string; title: string; description?: string };

const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const compact = (iso: string) => iso.replaceAll("-", "");

/** Lines end in CRLF and run 75 bytes at most; a longer one continues on the next, after a space. */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (bytes + n > 74) {
      out.push(cur);
      cur = " ";
      bytes = 1;
    }
    cur += ch;
    bytes += n;
  }
  return [...out, cur].join("\r\n");
}

export function icsFile(events: readonly IcsEvent[], now: Date, reminderDays: readonly number[] = [14, 3]): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Raponiberg//Money calendar//EN",
    "CALSCALE:GREGORIAN",
    ...events.flatMap((e) => [
      "BEGIN:VEVENT",
      `UID:${escape(e.id)}@raponiberg.local`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compact(e.date)}`,
      `DTEND;VALUE=DATE:${compact(addDays(e.date, 1))}`,
      `SUMMARY:${escape(e.title)}`,
      ...(e.description ? [`DESCRIPTION:${escape(e.description)}`] : []),
      "TRANSP:TRANSPARENT",
      ...reminderDays.flatMap((d) => ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escape(e.title)}`, `TRIGGER:-P${d}D`, "END:VALARM"]),
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
