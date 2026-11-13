"use client";

import { btn, EmptyState, PageBody } from "@/components/ui/kit";
import Link from "next/link";

/**
 * An address the app has no page for. A client component because the kit's `btn` classes
 * live in a client module (a server component reads them as undefined), so the title is set
 * here rather than through `metadata`.
 */
export default function NotFound() {
  return (
    <PageBody width="narrow">
      <title>Page not found · Raponiberg</title>
      <EmptyState
        title="There's no page at this address"
        action={
          <Link href="/" className={btn.primary}>
            Go to Home
          </Link>
        }
      >
        It may have moved: every page is in the menu on the left.
      </EmptyState>
    </PageBody>
  );
}
