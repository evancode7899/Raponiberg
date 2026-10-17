"use client";

import { apiSecretHeaders } from "@/components/ledger/useApi";
import type { CashFlowProof } from "@/lib/book/proof/cashFlowProof";
import { useCallback, useState, type ReactNode } from "react";
import { ProofContext, type ProofTarget } from "./context";
import { ProofPanel } from "./ProofPanel";

export type ProofState = { target: ProofTarget; proof: (CashFlowProof & { stamp: string }) | null; error: string | null };

/**
 * One proof drawer for the whole app (mounted by AppShell). A plain fetch, not useApi's
 * call: that clears the page's cached answers on every non-GET, and asking for a proof
 * changes nothing.
 */
export function ProofProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ProofState | null>(null);
  const open = useCallback((target: ProofTarget) => {
    setState({ target, proof: null, error: null });
    fetch("/api/proof", { method: "POST", headers: { "content-type": "application/json", ...apiSecretHeaders() }, body: JSON.stringify(target.descriptor) })
      .then(async (r) => {
        const j = (await r.json().catch(() => ({ error: `The server answered ${r.status}.` }))) as CashFlowProof & { stamp: string; error?: string };
        if (!r.ok || j.error) throw new Error(j.error ?? `The server answered ${r.status}.`);
        // Only if this figure is still the one open (another click may have replaced it).
        setState((s) => (s?.target === target ? { target, proof: j, error: null } : s));
      })
      .catch((e: Error) => setState((s) => (s?.target === target ? { target, proof: null, error: e.message } : s)));
  }, []);
  const close = useCallback(() => setState(null), []);
  return (
    <ProofContext.Provider value={open}>
      {children}
      <ProofPanel state={state} onClose={close} />
    </ProofContext.Provider>
  );
}
