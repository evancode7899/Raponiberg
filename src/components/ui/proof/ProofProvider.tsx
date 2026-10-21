"use client";

import { apiSecretHeaders } from "@/components/ledger/useApi";
import type { Proof, ProofDescriptor } from "@/lib/book/proof";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { ProofContext, type ProofTarget } from "./context";
import { ProofPanel } from "./ProofPanel";

/** One proof in the drawer: what was asked for, and the answer once it arrives. */
export type ProofEntry = { target: ProofTarget; proof: (Proof & { stamp: string }) | null; error: string | null };

/**
 * One proof drawer for the whole app (mounted by AppShell). Clicking a figure opens its
 * proof; a link inside a proof opens the linked one on top, and Back returns to the one
 * before. A plain fetch, not useApi's call: that clears the page's cached answers on
 * every non-GET, and asking for a proof changes nothing.
 */
export function ProofProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<ProofEntry[]>([]);
  // Which request each entry is waiting on, so a slow answer never lands on a newer entry.
  const seq = useRef(0);

  const load = useCallback((target: ProofTarget, mode: "open" | "push") => {
    const id = ++seq.current;
    const entry: ProofEntry & { id: number } = { target, proof: null, error: null, id };
    setStack((s) => (mode === "open" ? [entry] : [...s, entry]));
    const settle = (patch: Partial<ProofEntry>) => setStack((s) => s.map((e) => ((e as typeof entry).id === id ? { ...e, ...patch } : e)));
    fetch("/api/proof", { method: "POST", headers: { "content-type": "application/json", ...apiSecretHeaders() }, body: JSON.stringify(target.descriptor) })
      .then(async (r) => {
        const j = (await r.json().catch(() => ({ error: `The server answered ${r.status}.` }))) as Proof & { stamp: string; error?: string };
        if (!r.ok || j.error) throw new Error(j.error ?? `The server answered ${r.status}.`);
        settle({ proof: j });
      })
      .catch((e: Error) => settle({ error: e.message }));
  }, []);

  const open = useCallback((t: ProofTarget) => load(t, "open"), [load]);
  const follow = useCallback((descriptor: ProofDescriptor) => load({ descriptor, shownCents: null }, "push"), [load]);
  const back = useCallback(() => setStack((s) => s.slice(0, -1)), []);
  const close = useCallback(() => setStack([]), []);

  return (
    <ProofContext.Provider value={open}>
      {children}
      <ProofPanel stack={stack} onFollow={follow} onBack={back} onClose={close} />
    </ProofContext.Provider>
  );
}
