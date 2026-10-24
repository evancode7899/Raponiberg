"use client";

import type { ReactNode } from "react";
import { useProof, useProofFlag, type ProofTarget } from "./context";

/**
 * A figure that opens its proof when clicked; plain text without a proof (or outside the app
 * shell). A figure the proof sweep found disagreeing with its proof is withheld: a dash that
 * opens the proof, which says what's wrong.
 */
export function ProofValue({ proof, children, className = "" }: { proof?: ProofTarget; children: ReactNode; className?: string }) {
  const open = useProof();
  const flag = useProofFlag(proof);
  if (!proof || !open) return <>{children}</>;
  if (flag)
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          open(proof);
        }}
        title={`Withheld: this figure disagrees with its proof, a bug in the app (not your documents). ${flag}`}
        className={`cursor-pointer rounded-sm text-neg underline decoration-neg decoration-dotted underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${className}`}
      >
        —
      </button>
    );
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
