/**
 * Made-up statements for a parser's tests (the template: exampleBank.ts). Writes the text a
 * PDF of the institution's statement extracts to, from rows it invents with a seeded random
 * number generator, so a test can make as many statements as it likes, of any shape (empty,
 * one row, hundreds, across a new year), and know exactly what each should parse to. Names
 * and merchants are invented; amounts are random. Nothing here comes from a real statement.
 */
export type FixtureRow = { date: string; description: string; amountCents: number };
export type Fixture = { text: string; accountNumber: string; periodStart: string; periodEnd: string; openingCents: number; closingCents: number; rows: FixtureRow[] };

const MERCHANTS = ["SPRINGFIELD DINER", "EXAMPLE GROCERS #12", "SHELBYVILLE HARDWARE", "CITY WATER DEPT", "PAT EXAMPLE PAYROLL", "SAMPLE STREAMING CO", "TRANSFER FROM SAVINGS ••5678"];

/** A small seeded generator (mulberry32): the same seed always makes the same statement. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const usd = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const slash = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;
const short = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}`;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function exampleBankFixture(opts: { seed?: number; periodStart?: string; days?: number; rows?: number; openingCents?: number } = {}): Fixture {
  const random = rng(opts.seed ?? 1);
  const periodStart = opts.periodStart ?? "2031-03-01";
  const days = opts.days ?? 30;
  const periodEnd = addDays(periodStart, days - 1);
  const accountNumber = String(1000 + Math.floor(random() * 9000));
  const openingCents = opts.openingCents ?? Math.round(random() * 500_000);
  const n = opts.rows ?? 1 + Math.floor(random() * 25);
  const rows: FixtureRow[] = Array.from({ length: n }, () => {
    const deposit = random() < 0.3;
    return { date: addDays(periodStart, Math.floor(random() * days)), description: MERCHANTS[Math.floor(random() * MERCHANTS.length)]!, amountCents: (deposit ? 1 : -1) * (1 + Math.floor(random() * (deposit ? 400_000 : 60_000))) };
  }).sort((a, b) => a.date.localeCompare(b.date));
  const deposits = rows.filter((r) => r.amountCents > 0);
  const withdrawals = rows.filter((r) => r.amountCents < 0);
  const sum = (rs: FixtureRow[]) => rs.reduce((s, r) => s + r.amountCents, 0);
  const closingCents = openingCents + sum(rows);
  const text = [
    "Example Bank, N.A.",
    "Pat Example",
    "100 Example Street, Springfield",
    `Statement period ${slash(periodStart)} to ${slash(periodEnd)}`,
    `Account number XXXXXX${accountNumber}`,
    "Account summary",
    `Beginning balance on ${slash(periodStart)} ${usd(openingCents)}`,
    `Deposits and credits ${usd(sum(deposits))}`,
    `Withdrawals and debits ${usd(sum(withdrawals))}`,
    `Ending balance on ${slash(periodEnd)} ${usd(closingCents)}`,
    "Deposits and other credits",
    "Date Description Amount",
    ...deposits.map((r) => `${short(r.date)} ${r.description} ${usd(r.amountCents)}`),
    `Total deposits and other credits ${usd(sum(deposits))}`,
    "Withdrawals and other debits",
    "Date Description Amount",
    ...withdrawals.map((r) => `${short(r.date)} ${r.description} ${usd(r.amountCents)}`),
    `Total withdrawals and other debits ${usd(sum(withdrawals))}`,
    "-- 1 of 1 --",
  ].join("\n");
  return { text, accountNumber, periodStart, periodEnd, openingCents, closingCents, rows };
}
