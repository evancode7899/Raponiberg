"use client";

import { Callout } from "@/components/ui/kit";
import { pageNotice } from "@/lib/book/proof/pageNotice";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useContext } from "react";
import { SweepContext } from "./context";

/**
 * At the top of a page with figures the proof sweep withholds for a bug in the app: how
 * many, where, and what the first one says (lib/book/proof/pageNotice.ts). Without it the
 * only sign on the page is a red dash wherever the figure sits, on whichever tab that is.
 */
export function SweepNotice() {
  const pathname = usePathname();
  const n = pageNotice(useContext(SweepContext), pathname);
  if (!n) return null;
  const one = n.figures === 1;
  return (
    <div className="mx-auto w-full max-w-[96rem] px-4 pt-3 sm:px-6" data-sweep-notice={n.figures}>
      <Callout
        tone="bad"
        title={`${n.figures} figure${one ? "" : "s"} on this page ${one ? "is" : "are"} withheld: a bug in the app, not your documents`}
        action={
          pathname === "/statements" ? undefined : (
            <Link href="/statements?tab=checks" className="text-xs font-medium underline underline-offset-2">
              All of them →
            </Link>
          )
        }
      >
        <p className="text-xs">
          {one ? "It doesn't" : "They don't"} tie to {one ? "its proof" : "their proofs"}, so {one ? "it shows" : "each shows"} as a red dash (click one for why){n.parts.length > 1 || n.parts[0]!.page.includes(" ") ? `: ${n.parts.map((p) => `${p.page} (${p.figures})`).join(", ")}` : ""}. First: {n.example}
        </p>
      </Callout>
    </div>
  );
}
