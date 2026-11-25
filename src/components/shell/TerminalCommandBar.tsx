"use client";

import { suggest, type Suggestion } from "@/components/shell/commandSearch";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

const HISTORY_KEY = "pf-command-history";
const HISTORY = 20;

function readHistory(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, HISTORY) : [];
  } catch {
    return [];
  }
}

/**
 * The command line: a code (NW, CF, TXN), a code and words (CF TRENDS, TAX W-4, CF DINING), or
 * words to find in the statements. Ctrl+K (⌘K) or "/" focuses it from anywhere; ↑ on an empty
 * line brings back earlier commands; Esc leaves it.
 */
export function TerminalCommandBar({ onShutdown }: { onShutdown?: () => void }) {
  const router = useRouter();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [line, setLine] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  /** Which earlier command the line shows: -1 is what's being typed. */
  const [past, setPast] = useState(-1);

  const matches = useMemo(() => suggest(line), [line]);
  const showList = open && matches.length > 0;

  const go = useCallback(
    (s: Suggestion) => {
      const typed = line.trim();
      if (typed) {
        try {
          localStorage.setItem(HISTORY_KEY, JSON.stringify([typed, ...readHistory().filter((x) => x !== typed)].slice(0, HISTORY)));
        } catch {
          /* storage unavailable */
        }
      }
      setLine("");
      setPast(-1);
      setOpen(false);
      inputRef.current?.blur();
      if (s.action === "shutdown") return onShutdown?.();
      router.push(s.href);
    },
    [line, router, onShutdown],
  );

  // New text puts the highlight back on the first match (adjusted during render, not in an effect).
  const [seenLine, setSeenLine] = useState(line);
  if (line !== seenLine) {
    setSeenLine(line);
    setHighlight(0);
  }

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  // Global shortcut: Ctrl/⌘+K anywhere, or "/" when not typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable || el.getAttribute("role") === "textbox");
      if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!showList) return;
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-command-root]")) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [showList]);

  const recall = (by: number) => {
    const all = readHistory();
    const next = Math.max(-1, Math.min(all.length - 1, past + by));
    setPast(next);
    setLine(next < 0 ? "" : all[next]!);
  };

  return (
    <div data-command-root className="relative w-full">
      <div className="flex h-8 items-center gap-2 rounded-md border border-line-strong bg-surface-2 px-2.5 focus-within:border-accent focus-within:bg-surface">
        <span className="select-none font-mono text-xs font-bold text-accent" aria-hidden>
          &gt;
        </span>
        <input
          ref={inputRef}
          type="text"
          value={line}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Go to a page or tab, or find transactions"
          aria-autocomplete="list"
          aria-controls={showList ? listId : undefined}
          aria-expanded={showList}
          aria-activedescendant={showList ? `${listId}-${highlight}` : undefined}
          role="combobox"
          className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-fg outline-none placeholder:text-faint"
          placeholder="NW · CF TRENDS · TAX W-4 · or words to find"
          onChange={(e) => {
            setLine(e.target.value);
            setPast(-1);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const pick = matches[highlight] ?? matches[0];
              if (pick && line.trim()) go(pick);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              if (past >= 0) recall(-1);
              else setHighlight((h) => Math.min(matches.length - 1, h + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              // On an empty line (or while going back through earlier ones), ↑ is the command before.
              if (!line.trim() || past >= 0) recall(1);
              else setHighlight((h) => Math.max(0, h - 1));
            } else if (e.key === "Escape") {
              setOpen(false);
              setLine("");
              setPast(-1);
              inputRef.current?.blur();
            }
          }}
        />
        <kbd className="hidden shrink-0 rounded border border-line-strong px-1 font-mono text-[10px] text-faint sm:inline">Ctrl K</kbd>
      </div>
      {showList && (
        <ul ref={listRef} id={listId} role="listbox" className="app-scroll absolute left-0 right-0 top-[calc(100%+4px)] z-[200] max-h-[min(70vh,28rem)] overflow-auto rounded-md border border-line-strong bg-surface py-1 shadow-xl">
          {matches.map((c, i) => (
            <li key={c.id} id={`${listId}-${i}`} role="option" aria-selected={i === highlight}>
              <button
                type="button"
                tabIndex={-1}
                className={`flex w-full items-baseline gap-3 px-3 py-1.5 text-left text-[13px] ${i === highlight ? "bg-surface-3" : "hover:bg-surface-2"}`}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  go(c);
                }}
              >
                <span className="w-11 shrink-0 font-mono text-xs font-bold text-accent">{c.code}</span>
                <span className="shrink-0 text-fg">{c.label}</span>
                <span className="truncate text-xs text-muted">{c.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
