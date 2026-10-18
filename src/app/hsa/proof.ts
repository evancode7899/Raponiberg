import type { ProofTarget } from "@/components/ui/proof/context";
import type { HsaDescriptor } from "@/lib/book/proof/hsaProof";

/** A figure on the HSA page that opens its proof (lib/book/proof/hsaProof.ts). */
export const hsaProof = (metric: HsaDescriptor["metric"], shownCents: number, part?: HsaDescriptor["part"]): ProofTarget => ({
  descriptor: { report: "hsa", metric, ...(part ? { part } : {}) },
  shownCents,
});
