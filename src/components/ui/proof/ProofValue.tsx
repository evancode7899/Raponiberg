"use client";

import type { ReactNode } from "react";
import { useProof, type ProofTarget } from "./context";

/** A figure that opens its proof when clicked; plain text without a proof (or outside the app shell). */
export function ProofValue({ proof, children, className = "" }: { proof?: ProofTarget; children: ReactNode; className?: string }) {
  const open = useProof();
  if (!proof || !open) return <>{children}</>;
  return (
    <button
      type="button"
      onClick={(e) => {
        // Inside a clickable row, open the proof rather than the row's own drill-down.
        e.stopPropagation();
        open(proof);
      }}
      title="Show the rows and checks behind this figure"
      className={`cursor-pointer rounded-sm text-inherit underline decoration-line-strong decoration-dotted underline-offset-4 hover:decoration-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${className}`}
    >
      {children}
    </button>
  );
}
