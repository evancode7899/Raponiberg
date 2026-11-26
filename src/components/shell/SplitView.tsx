"use client";

import { useEffect, useState } from "react";
import { commandForPath } from "./terminalCommands";

/** The command line's SPLIT (and the key map) opens a page beside this one: dispatch with the page's address, or null to close. */
export const SPLIT_EVENT = "pf:split";
const SPLIT_KEY = "pf-split";

export function openSplit(href: string | null) {
  window.dispatchEvent(new CustomEvent<string | null>(SPLIT_EVENT, { detail: href }));
}

/** Whether this page is the right-hand side of a split: a frame of the app inside the app. */
export function isSplitPane(): boolean {
  try {
    return typeof window !== "undefined" && window.self !== window.top && window.parent.location.origin === window.location.origin;
  } catch {
    return false;
  }
}

/** The page shown beside this one, kept for the tab (sessionStorage) so a reload keeps it. */
export function useSplit(): [string | null, (href: string | null) => void] {
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => {
    try {
      // Read after mount: the server render can't see this tab's storage.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHref(sessionStorage.getItem(SPLIT_KEY));
    } catch {
      /* storage unavailable */
    }
    const on = (e: Event) => {
      const next = (e as CustomEvent<string | null>).detail;
      setHref(next);
      try {
        if (next) sessionStorage.setItem(SPLIT_KEY, next);
        else sessionStorage.removeItem(SPLIT_KEY);
      } catch {
        /* storage unavailable */
      }
    };
    window.addEventListener(SPLIT_EVENT, on);
    return () => window.removeEventListener(SPLIT_EVENT, on);
  }, []);
  return [href, openSplit];
}

/**
 * The right-hand side of a split: another page of the app, whole, beside the one on the left.
 * It is the app itself in a frame (the app may frame only itself: lib/auth/csp.ts), drawn
 * without the top bar and sidebar (AppShell's split pane), with its own tabs and scroll.
 */
export function SplitPane({ href, onClose, onOpenHere }: { href: string; onClose: () => void; onOpenHere: () => void }) {
  const page = commandForPath(href.split("?")[0]!);
  return (
    <section aria-label={`Beside: ${page?.label ?? href}`} className="hidden min-h-0 min-w-0 flex-1 flex-col border-l border-line-strong lg:flex">
      <header className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-2 text-xs">
        <span className="font-mono text-2xs font-bold text-accent">{page?.mnemonic ?? "PAGE"}</span>
        <span className="truncate text-fg">{page?.label ?? href}</span>
        <button type="button" className="ml-auto text-muted hover:text-fg" onClick={onOpenHere} title="Open this page in the main view instead">
          Open here
        </button>
        <button type="button" className="text-muted hover:text-fg" onClick={onClose} aria-label="Close the split view" title="Close the split view (SPLIT in the command line)">
          ✕
        </button>
      </header>
      <iframe key={href} src={href} title={page?.label ?? "Beside"} className="min-h-0 w-full flex-1 border-0 bg-canvas" />
    </section>
  );
}
