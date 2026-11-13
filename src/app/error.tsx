"use client";

import { btn, ErrorNote, PageBody } from "@/components/ui/kit";
import Link from "next/link";
import { useEffect } from "react";

/** A page that failed while drawing: says so inside the app's frame, with a way to try again. */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <PageBody width="narrow">
      <ErrorNote>
        <div className="font-semibold text-neg">This page couldn&apos;t be shown</div>
        <p className="mt-1">Something went wrong while drawing it. Your data isn&apos;t affected.</p>
        {error.message && <p className="mt-1 break-words font-mono text-[11px] text-muted">{error.message}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={btn.primary} onClick={reset}>
            Try again
          </button>
          <Link href="/" className={btn.secondary}>
            Go to Home
          </Link>
        </div>
      </ErrorNote>
    </PageBody>
  );
}
