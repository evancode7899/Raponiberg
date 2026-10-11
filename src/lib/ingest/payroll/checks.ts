import { CASH_EARNING_KINDS, WITHHELD_KINDS, type PayStubFacts } from "./types.ts";

export type StubCheck = { label: string; expected: number; actual: number; ok: boolean };

/**
 * A stub proving itself: its line items add up to the totals it prints, and gross minus
 * everything withheld is the net it paid, this period and year to date. A failure means
 * the stub was read wrong (or prints figures that don't add up) — never "close enough".
 */
export function stubChecks(s: PayStubFacts): StubCheck[] {
  const sum = (pick: "current" | "ytd", kinds: ReadonlySet<string>) => s.lines.filter((l) => kinds.has(l.kind)).reduce((t, l) => t + (l[pick] ?? 0), 0);
  const out: StubCheck[] = [];
  const check = (label: string, expected: number | null, actual: number) => {
    if (expected != null) out.push({ label, expected, actual, ok: expected === actual });
  };
  const p = s.printed;
  const earnCur = sum("current", CASH_EARNING_KINDS);
  const earnYtd = sum("ytd", CASH_EARNING_KINDS);
  const heldCur = sum("current", WITHHELD_KINDS);
  const heldYtd = sum("ytd", WITHHELD_KINDS);
  check("Earning lines = printed gross pay (this period)", p.grossCurrent, earnCur);
  check("Earning lines = printed gross pay (year to date)", p.grossYtd, earnYtd);
  check("Tax and deduction lines = printed total withheld (this period)", p.withheldCurrent, heldCur);
  check("Tax and deduction lines = printed total withheld (year to date)", p.withheldYtd, heldYtd);
  check("Gross − withheld = net pay (this period)", p.netCurrent, (p.grossCurrent ?? earnCur) - (p.withheldCurrent ?? heldCur));
  if (p.netYtd != null && (p.grossYtd != null || s.lines.every((l) => l.ytd != null))) {
    check("Gross − withheld = net pay (year to date)", p.netYtd, (p.grossYtd ?? earnYtd) - (p.withheldYtd ?? heldYtd));
  }
  if (s.deposits.length) check("Direct deposits = net pay", p.netCurrent, s.deposits.reduce((t, d) => t + d.amount, 0));
  return out;
}
