"use client";

import { apiSecretHeaders, lastDataStamp, onDataStamp } from "@/components/ledger/useApi";
import type { Proof, ProofDescriptor } from "@/lib/book/proof";
import type { MonthEndNote } from "@/lib/book/proof/proofText";
import { clearanceOf, sweepAnswer, type Clearance, type SweepState } from "@/lib/book/proof/clearance";
import type { Quality } from "@/lib/ledger/timeline";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { DataStampContext, ProofContext, SweepContext, type ProofTarget } from "./context";
import { ProofPanel } from "./ProofPanel";
import { SweepNotice } from "./SweepNotice";

/** One proof in the drawer: what was asked for (none for a figure with no proof), why the page shows or withholds it, and the answer once it arrives. */
export type ProofEntry = { target: ProofTarget | null; clearance: Clearance | null; quality?: Quality; proof: (Proof & { stamp: string; monthEnd?: MonthEndNote | null }) | null; error: string | null; id?: number };

/** Opens a figure's proof from anywhere in the app: dispatch it on window with { descriptor, shownCents } (openProof below). */
export const OPEN_PROOF_EVENT = "pf:open-proof";
export function openProof(t: ProofTarget): void {
  window.dispatchEvent(new CustomEvent<ProofTarget>(OPEN_PROOF_EVENT, { detail: t }));
}

/** How long to wait before asking again while the sweep runs, and after it failed. */
const PENDING_POLL_MS = 2000;
const FAILED_POLL_MS = 15000;
/** A sweep of other data than the page's is asked again this often, a few times. */
const STALE_POLL_MS = 3000;
const STALE_TRIES = 5;

/**
 * One proof drawer for the whole app (mounted by AppShell), and the proof sweep's
 * verdicts every figure is cleared by (clearance.ts). Clicking a figure opens its proof;
 * a link inside a proof opens the linked one on top, and Back returns to the one before.
 * A plain fetch, not useApi's call: that clears the page's cached answers on every
 * non-GET, and asking for a proof changes nothing.
 */
export function ProofProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<ProofEntry[]>([]);
  // Which request each entry is waiting on, so a slow answer never lands on a newer entry.
  const seq = useRef(0);

  const load = useCallback((target: ProofTarget | null, clearance: Clearance | null, mode: "open" | "push", quality?: Quality) => {
    const id = ++seq.current;
    const entry: ProofEntry & { id: number } = { target, clearance, quality, proof: null, error: null, id };
    setStack((s) => (mode === "open" ? [entry] : [...s, entry]));
    if (!target) return;
    const settle = (patch: Partial<ProofEntry>) => setStack((s) => s.map((e) => ((e as typeof entry).id === id ? { ...e, ...patch } : e)));
    fetch("/api/proof", { method: "POST", headers: { "content-type": "application/json", ...apiSecretHeaders() }, body: JSON.stringify(target.descriptor) })
      .then(async (r) => {
        const j = (await r.json().catch(() => ({ error: `The server answered ${r.status}.` }))) as Proof & { stamp: string; error?: string };
        if (!r.ok || j.error) throw new Error(j.error ?? `The server answered ${r.status}.`);
        settle({ proof: j });
      })
      .catch((e: Error) => settle({ error: e.message }));
  }, []);

  const open = useCallback((t: ProofTarget | null, clearance?: Clearance, quality?: Quality) => load(t, clearance ?? null, "open", quality), [load]);
  const follow = useCallback((descriptor: ProofDescriptor) => load({ descriptor, shownCents: null }, null, "push"), [load]);
  const back = useCallback(() => setStack((s) => s.slice(0, -1)), []);
  // A proof kept beside whichever one is open next, to compare two figures side by side.
  const [pinned, setPinned] = useState<ProofEntry | null>(null);
  const close = useCallback(() => setStack([]), []);

  // The data the page's figures were built from: the stamp of the latest answer useApi got.
  const [pageStamp, setPageStamp] = useState<string | null>(() => lastDataStamp());
  useEffect(() => onDataStamp(setPageStamp), []);

  // The proof sweep's verdicts: read now, again while the sweep of the data runs, and
  // whenever the data changes. No answer withholds every figure; it never clears them.
  const [sweep, setSweep] = useState<SweepState>({ stamp: null, status: "pending", cleared: {}, basis: {}, problems: {} });
  const stampRef = useRef(pageStamp);
  useEffect(() => {
    stampRef.current = pageStamp;
  }, [pageStamp]);
  const readRef = useRef<() => void>(() => {});
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let staleTries = 0;
    // One read at a time: the page's data often arrives before the first answer does, and a
    // second read then would fetch the whole sweep again (megabytes on a big Book). What lands
    // is checked against the page's data below, and read again if it's stale.
    let inflight = false;
    const later = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(read, ms);
    };
    const read = () => {
      clearTimeout(timer);
      if (inflight) return;
      inflight = true;
      fetch("/api/proof/sweep", { headers: apiSecretHeaders() })
        .then(async (r) => sweepAnswer(r.status, await r.json().catch(() => null)))
        .catch((e: Error) => sweepAnswer(null, null, e.message))
        .then((next) => {
          inflight = false;
          if (!live) return;
          // The same verdicts keep the same state: a new one redraws every figure on the page.
          setSweep((old) => (old.stamp === next.stamp && old.status === next.status && old.status === "ready" ? old : next));
          if (next.status === "pending") later(PENDING_POLL_MS);
          else if (next.status === "failed") later(FAILED_POLL_MS);
          else if (stampRef.current && next.stamp !== stampRef.current && staleTries++ < STALE_TRIES) later(STALE_POLL_MS);
        });
    };
    readRef.current = () => {
      staleTries = 0;
      read();
    };
    read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);
  // New data on the page: its figures wait for the sweep of that data.
  useEffect(() => {
    if (pageStamp && pageStamp !== sweep.stamp) readRef.current();
  }, [pageStamp, sweep.stamp]);

  // A figure opened from outside a page (the command line, a pin): its proof, cleared as any figure is.
  const sweepRef = useRef(sweep);
  useEffect(() => {
    sweepRef.current = sweep;
  }, [sweep]);
  useEffect(() => {
    const onOpen = (e: Event) => {
      const t = (e as CustomEvent<ProofTarget>).detail;
      if (t?.descriptor) open(t, t.shownCents == null ? undefined : clearanceOf(t, sweepRef.current, stampRef.current));
    };
    window.addEventListener(OPEN_PROOF_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_PROOF_EVENT, onOpen);
  }, [open]);

  return (
    <ProofContext.Provider value={open}>
      <SweepContext.Provider value={sweep}>
        <DataStampContext.Provider value={pageStamp}>
          <SweepNotice />
          {children}
          <ProofPanel stack={stack} pinned={pinned} onPin={setPinned} onFollow={follow} onBack={back} onClose={close} />
        </DataStampContext.Provider>
      </SweepContext.Provider>
    </ProofContext.Provider>
  );
}
