import { extractAdpStubs } from "./adp.ts";
import { extractTrinetStub } from "./trinet.ts";
import type { PayStubFacts } from "./types.ts";
import { extractVensureStubs } from "./vensure.ts";

export * from "./types.ts";
export { amountsFromLines, ZERO_AMOUNTS, type PayrollAmounts } from "./amounts.ts";
export { stubChecks, type StubCheck } from "./checks.ts";

export function detectTrinet(text: string): boolean {
  return /Check Date: \d{2}\/\d{2}\/\d{4}/.test(text) && /Pay Period: /.test(text) && /NON-NEGOTIABLE/.test(text);
}
export function detectVensure(text: string): boolean {
  return /Net Pay Distribution/.test(text) && /Period Start Date/.test(text) && /Gross Earnings|TOTAL NET PAY/.test(text);
}
export function detectAdp(text: string): boolean {
  return /Earnings Statement/.test(text) && /ADP, Inc\./.test(text) && /Pay Date:/.test(text) && /Net Pay/.test(text);
}

/** Every stub in a payroll PDF, by its provider's one extractor. */
export function extractPayStubs(text: string): { provider: "TriNet" | "Vensure" | "ADP"; stubs: PayStubFacts[] } | null {
  if (detectTrinet(text)) {
    const s = extractTrinetStub(text);
    return { provider: "TriNet", stubs: s ? [s] : [] };
  }
  if (detectVensure(text)) return { provider: "Vensure", stubs: extractVensureStubs(text) };
  if (detectAdp(text)) return { provider: "ADP", stubs: extractAdpStubs(text) };
  return null;
}
