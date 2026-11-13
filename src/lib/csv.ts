/** A number as the exports write them (-12.34, 1200, .5): never a formula, so left as is. */
const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/**
 * RFC 4180–style CSV cell escaping. Text that a spreadsheet would run as a formula (it
 * starts with = + - @, a tab or a carriage return: a merchant name off a statement can) gets a
 * leading apostrophe, which spreadsheets show as plain text.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  let s = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s) && !PLAIN_NUMBER.test(s)) {
    s = `'${s}`;
  }
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function csvRow(cells: (string | number | boolean | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}
