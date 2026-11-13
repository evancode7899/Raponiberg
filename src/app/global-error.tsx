"use client";

import { useEffect } from "react";
import "./globals.css";

/**
 * The app's own frame failed (the layout or the shell), so this replaces the whole
 * document: it can't use the shell, and keeps to plain markup the stylesheet covers.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <html lang="en">
      <body className="min-h-screen bg-canvas text-fg antialiased">
        <main className="mx-auto flex min-h-screen max-w-md flex-col items-start justify-center gap-3 px-6 text-sm">
          <h1 className="text-base font-semibold">Raponiberg couldn&apos;t start this page</h1>
          <p className="text-muted">Something went wrong before the page could be drawn. Your data isn&apos;t affected.</p>
          {error.message && <p className="break-words font-mono text-[11px] text-muted">{error.message}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg" onClick={reset}>
              Try again
            </button>
            {/* A full reload on purpose: the router itself may be what failed. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" className="rounded-md border border-line-strong px-3 py-1.5 text-xs font-medium text-fg">
              Reload the app
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
