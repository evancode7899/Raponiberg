"use client";

import { Callout } from "@/components/ui/kit";
import type { BlockerRef } from "@/lib/book/reports/blockerRef";
import Link from "next/link";

/**
 * How every page shows a figure the Book can't prove: never the number, always why —
 * which check fails, or (on hover) which statement or stub is missing.
 */

/** Where the statements still to download are listed. */
const STATEMENTS_TO_DOWNLOAD = "/statements?tab=plan";

/**
 * A callout listing the failing checks behind a section — data that contradicts itself.
 * Statements or stubs that are simply missing aren't itemized here: which ones to
 * download lives on the Statements tab only. When the whole section is withheld
 * (`withheld`) and only missing documents are to blame, one quiet line says so.
 * Renders nothing when there's nothing failing to show.
 */
export function BlockedNote({ blockers, what, limit = 6, title, withheld = false }: { blockers: BlockerRef[]; what: string; limit?: number; title?: string; withheld?: boolean }) {
  const failing = blockers.filter((b) => b.status === "FAIL");
  if (failing.length === 0)
    return withheld && blockers.length > 0 ? (
      <p className="text-xs text-muted">
        Not shown until the statements it needs are on file —{" "}
        <Link href={STATEMENTS_TO_DOWNLOAD} className="text-accent hover:underline">
          see Statements
        </Link>
        .
      </p>
    ) : null;
  return (
    <Callout
      tone="bad"
      title={`${title ?? `Can't prove ${what}`} (${failing.length} failing)`}
      action={
        <Link href="/statements?tab=issues" className="whitespace-nowrap text-xs font-medium text-accent hover:underline">
          Open Issues →
        </Link>
      }
    >
      <ul className="mt-1 flex flex-col gap-1 text-xs">
        {failing.slice(0, limit).map((b) => (
          <li key={b.id}>
            <span className="font-medium text-neg">{b.title}</span>
            <span className="text-muted"> — {b.fix}</span>
          </li>
        ))}
        {failing.length > limit && <li className="text-muted">…and {failing.length - limit} more on Statements → Issues.</li>}
      </ul>
    </Callout>
  );
}

/** Tooltip text for a withheld figure. */
export const blockedTitle = (bs: BlockerRef[]) => `Not shown — can't be proven:\n${bs.slice(0, 8).map((b) => `• ${b.title}`).join("\n")}${bs.length > 8 ? `\n…and ${bs.length - 8} more` : ""}`;

/** In place of a number in a table or tile. */
export function BlockedValue({ blockers, className = "" }: { blockers: BlockerRef[]; className?: string }) {
  const fail = blockers.some((b) => b.status === "FAIL");
  return (
    <span title={blockedTitle(blockers)} className={`cursor-help whitespace-nowrap text-xs font-medium ${fail ? "text-neg" : "text-warn"} ${className}`}>
      {fail ? "failing" : "missing data"}
    </span>
  );
}
